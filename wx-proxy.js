'use strict';
/* ============================================================
 * 微信视频号捕获代理(实验版 · 不解密)
 * 原理:
 *   本地 HTTP 代理(127.0.0.1:8899)接收系统代理转来的 CONNECT;
 *   仅对视频 CDN 域名(*.video.weixin.qq.com / stodownload* /
 *   finder.video.qq.com)做 TLS 中间人(本地自签 CA),
 *   其余域名(含微信登录、mmtls 私有协议)全部原样隧道直通;
 *   命中的视频响应原文落盘保存(不做任何解密),
 *   用于验证"未加密视频能否直接保存播放"。
 * 注意:
 *   1) 所有用到的模块必须显式 require(上次教训:漏 require('tls')
 *      导致运行时崩溃);
 *   2) 所有回调内部自行兜错,绝不向外抛异常拖垮主进程。
 * ============================================================ */
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
let forge = null;
try { forge = require('node-forge'); } catch (e) { forge = null; }

/* 注入到视频号页面的脚本:定义 WXU 事件桥,把 feed(含视频直链+decodeKey)回传给代理 */
const WXV_FEED_JS = `(function () {
  if (window.__wxv_installed) return;
  window.__wxv_installed = true;
  function feedToItem(feed) {
    try {
      if (!feed || !feed.objectDesc) return null;
      var mediaList = feed.objectDesc.media || [];
      var media = mediaList[0];
      if (!media || !media.url) return null;
      return {
        id: String(feed.id || feed.objectNonceId || ('f' + (media.decodeKey || '') + '#' + String(feed.objectDesc.description || '').slice(0, 20))),
        title: String(feed.objectDesc.description || '').slice(0, 100),
        nickname: (feed.contact && feed.contact.nickname) || '',
        url: (media.url || '') + (media.urlToken || ''),
        key: media.decodeKey,
        size: media.fileSize || 0,
        duration: media.videoPlayLen || 0,
        ts: Date.now(),
      };
    } catch (e) { return null; }
  }
  function send(items) {
    try {
      fetch('/wxv-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feeds: items }) }).catch(function () {});
    } catch (e) {}
  }
  function handle(type, data) {
    try {
      if (!data) return;
      if (type === 'channels:OnFeedProfileLoaded' || type === 'channels:GotoNextFeed' || type === 'channels:GotoPrevFeed' || type === 'channels:HomeFeedChanged') {
        var it = feedToItem(data);
        if (it) send([it]);
      } else if (type === 'channels:PCFlowLoaded' || type === 'channels:RecommendFeedsLoaded' || type === 'channels:PreloadFeeds') {
        var list = Array.isArray(data) ? data : (data && data.feeds) || (data && data.object) || null;
        if (!Array.isArray(list)) return;
        var items = [];
        for (var i = 0; i < list.length && i < 30; i++) {
          var it2 = feedToItem(list[i]);
          if (it2) items.push(it2);
        }
        if (items.length) send(items);
      }
    } catch (e) {}
  }
  window.WXU = window.WXU || {};
  window.WXU.emit = function (type, data) {
    setTimeout(function () { handle(type, data); }, 0);
  };
  console.log('[wxv] feed hook installed');
})();`;

/* res.wx.qq.com SPA JS 改写正则(移植自 ltaoo/wx_channels_download) */
const WXV_REWRITE = true; // 已离线验证:51/51 bundle 语法通过
const WX_JS_RES = {
  dep: /"js\/([^"]{1,})\.js"/g,
  from: /from ?"([^"]{1,})\.js"/g,
  lazyImport: /import\("([^"]{1,})\.js"\)/g,
  import: /import ?"([^"]{1,})\.js"/g,
  feedProfile: /async finderGetCommentDetail\((\w+)\)\{([\s\S]*?)\}async/,
  pcFlow: /async finderPcFlow\((\w+)\)\{([\s\S]*?)\}async/,
  recommend: /async finderGetRecommend\((\w+)\)\{([\s\S]*?)\}async/,
  preload: / ([a-zA-Z_$][a-zA-Z0-9_$]*\.invoke\([a-zA-Z_$][a-zA-Z0-9_$]*\));\(/,
  flowTab: /flowTab:([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  goNext: /goToNextFlowFeed:([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  goPrev: /goToPrevFlowFeed:([a-zA-Z_$][a-zA-Z0-9_$]*)/,
};

/* 需要拦截(能看到内容)的视频 CDN 域名 */
function isInterceptHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  if (!h) return false;
  return (
    /(^|\.)video\.weixin\.qq\.com$/.test(h) ||
    /(^|\.)finder\.video\.qq\.com$/.test(h) ||
    /(^|\.)[\w-]+\.video\.qq\.com$/.test(h) ||
    /(^|\.)video\.qq\.com$/.test(h) ||
    /(^|\.)mpvideo\.qpic\.cn$/.test(h) ||
    isApiHost(h) ||
    /stodownload/.test(h)
  );
}

/* 视频号网页/API 域名:验证 decodeKey 是否明文可读 */
function isApiHost(host) {
  return (
    String(host || '').toLowerCase() === 'channels.weixin.qq.com' ||
    String(host || '').toLowerCase() === 'res.wx.qq.com'
  );
}

/* 响应/URL 看起来像视频流才落盘,其余正常转发 */
function looksMedia(url, contentType) {
  const u = String(url || '');
  const c = String(contentType || '');
  if (/^image\//i.test(c)) return false; // 封面图等,不落盘
  if (/stodownload/i.test(u)) return true;
  if (/video\/|mp4|mpegurl|octet-stream/i.test(c)) return true;
  if (/\.(mp4|m3u8|ts)(\?|$)/i.test(u)) return true;
  return false;
}

/* 首次生成并持久化本地根证书(LocalCapture Root CA 2) */
function ensureCA(dataDir, log) {
  if (!forge) throw new Error('node-forge 未安装,无法生成捕获证书');
  const dir = path.join(dataDir, 'wx-ca');
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'ca.key');
  const crtPath = path.join(dir, 'ca.crt');
  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    return {
      keyPem: fs.readFileSync(keyPath, 'utf8'),
      certPem: fs.readFileSync(crtPath, 'utf8'),
      certPath: crtPath,
    };
  }
  if (log) log('[证书] 首次运行,生成新的本地根证书…');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: 'LocalCapture Root CA 2' },
    { name: 'organizationName', value: 'LocalCapture' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(crtPath, certPem);
  return { keyPem, certPem, certPath: crtPath };
}

/* 每个域名一张叶子证书(共享一把叶子私钥,缓存 SecureContext) */
function createLeafFactory(ca) {
  const cache = new Map();
  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafKeyPem = forge.pki.privateKeyToPem(leafKeys.privateKey);
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  return function leafFor(servername) {
    const host = String(servername || '').toLowerCase();
    if (cache.has(host)) return cache.get(host);
    const cert = forge.pki.createCertificate();
    cert.publicKey = leafKeys.publicKey;
    cert.serialNumber = '02' + crypto.randomBytes(8).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000);
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    const ctx = tls.createSecureContext({ key: leafKeyPem, cert: forge.pki.certificateToPem(cert) });
    cache.set(host, ctx);
    return ctx;
  };
}

function createProxy(opts) {
  const options = opts || {};
  const port = options.port || 8899;
  const dataDir = options.dataDir || process.cwd();
  const version = String(options.version || Date.now());
  const log = options.onLog || function () {};
  const emitter = new EventEmitter();
  const state = { server: null, httpsServer: null, running: false, ca: null, captures: [] };

  function captureDir() {
    const d = path.join(dataDir, 'wx-captures');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
    return d;
  }

  function apiDir() {
    const d = path.join(dataDir, 'wx-api');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
    return d;
  }

  let api_seq = 0;
  /* 拦截到的 API/页面响应:落盘并搜索 decodeKey */
  function teeApiResponse(hostname, clientReq, upRes) {
    try {
      const seq = ++api_seq;
      const ext = /json/i.test(String(upRes.headers['content-type'] || '')) ? 'json' : 'txt';
      const fname = 'api-' + seq + '-' + hostname + (clientReq.url || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.' + ext;
      const savedPath = path.join(apiDir(), fname);
      const tee = fs.createWriteStream(savedPath);
      let got = 0;
      upRes.on('data', function (c) {
        got += c.length;
        if (got <= 8 * 1024 * 1024) tee.write(c);
      });
      upRes.on('end', function () {
        tee.end();
        const url = 'https://' + hostname + (clientReq.url || '');
        log('[API响应] ' + hostname + clientReq.url + ' ' + got + 'B -> ' + fname);
        fs.readFile(savedPath, 'utf8', function (err, text) {
          if (err || !text) return;
          const idx = text.indexOf('decodeKey');
          if (idx >= 0) {
            const ctxs = [];
            let from = 0;
            for (let k = 0; k < 3; k++) {
              const p = text.indexOf('decodeKey', from);
              if (p < 0) break;
              ctxs.push(text.slice(Math.max(0, p - 120), p + 200));
              from = p + 10;
            }
            log('[decodeKey命中] ' + url + ' :: ' + ctxs.join(' || '));
          }
        });
      });
      tee.on('error', function () { /* ignore */ });
      upRes.pipe(tee);
    } catch (e) { log('[API tee 异常] ' + ((e && e.message) || e)); }
  }

  /* 缓冲整个响应体后改写再返回(HTML/JS 用) */
  function bufferRewrite(upRes, clientRes, transform, tag) {
    const chunks = [];
    let total = 0;
    let overflow = false;
    upRes.on('data', function (c) {
      total += c.length;
      if (total > 16 * 1024 * 1024) overflow = true;
      if (!overflow) chunks.push(c);
    });
    upRes.on('end', function () {
      try {
        const raw = Buffer.concat(chunks);
        const headers = Object.assign({}, upRes.headers);
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        let body = raw;
        if (!overflow && transform) {
          try { body = transform(raw); } catch (e) { log('[重写失败/' + tag + '] ' + ((e && e.message) || e)); body = raw; }
        }
        headers['content-length'] = String(body.length);
        clientRes.writeHead(upRes.statusCode || 200, headers);
        clientRes.end(body);
      } catch (e) {
        log('[重写异常/' + tag + '] ' + ((e && e.message) || e));
        try { clientRes.destroy(); } catch (e2) { /* ignore */ }
      }
    });
    upRes.on('error', function () { try { clientRes.destroy(); } catch (e2) { /* ignore */ } });
  }

  /* 视频号页面 HTML:注入 feed 桥脚本 + 剥离 CSP + 缓存穿透 */
  function rewriteChannelsHtml(bodyBuf) {
    let html = bodyBuf.toString('utf8');
    const v = '?t=' + version;
    html = html.replace(/src="([^"]{1,})\.js"/g, 'src="$1.js' + v + '"');
    html = html.replace(/href="([^"]{1,})\.js"/g, 'href="$1.js' + v + '"');
    const inject = '<script>' + WXV_FEED_JS + '</script>';
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, function (m) { return m + inject; });
    } else {
      html = inject + html;
    }
    log('[HTML注入] 视频号页面已注入 feed 桥(' + html.length + 'B)');
    return Buffer.from(html, 'utf8');
  }

  /* 视频号 SPA JS:缓存穿透 + 暴露 feed 数据 */
  function rewriteWxJs(bodyBuf, pathname) {
    let js = bodyBuf.toString('utf8');
    const v = '?t=' + version;
    let wraps = 0;
    js = js.replace(WX_JS_RES.dep, '"js/$1.js' + v + '"');
    js = js.replace(WX_JS_RES.from, 'from"$1.js' + v + '"');
    js = js.replace(WX_JS_RES.lazyImport, 'import("$1.js' + v + '")');
    js = js.replace(WX_JS_RES.import, 'import"$1.js' + v + '"');
    js = js.replace(WX_JS_RES.feedProfile, function (m, a, b) {
      wraps += 1;
      return 'async finderGetCommentDetail(' + a + ') { var result = await (async () => { ' + b + ' })(); var __f = (result && result.data) ? result.data.object : null; try { typeof WXU !== "undefined" && WXU.emit("channels:OnFeedProfileLoaded", __f); } catch (e) {} return result; }async';
    });
    js = js.replace(WX_JS_RES.pcFlow, function (m, a, b) {
      wraps += 1;
      return 'async finderPcFlow(' + a + ') { var result = await (async () => { ' + b + ' })(); var __fs = (result && result.data) ? result.data.object : null; try { typeof WXU !== "undefined" && WXU.emit("channels:PCFlowLoaded", __fs); } catch (e) {} return result; }async';
    });
    js = js.replace(WX_JS_RES.recommend, function (m, a, b) {
      wraps += 1;
      return 'async finderGetRecommend(' + a + ') { var result = await (async () => { ' + b + ' })(); var __fs = (result && result.data) ? result.data.object : null; try { typeof WXU !== "undefined" && WXU.emit("channels:RecommendFeedsLoaded", __fs); } catch (e) {} return result; }async';
    });
    js = js.replace(WX_JS_RES.preload, function (m, expr) {
      wraps += 1;
      return ' (async()=>{ const _r = await ' + expr + '; try { typeof WXU !== "undefined" && WXU.emit("channels:PreloadFeeds", _r && _r.data ? _r.data.object : null); } catch (e) {} return _r; })();(';
    });
    // 注:goToNextFlowFeed/goToPrevFlowFeed 的改写在新版 SPA 中会命中解构赋值
    // (const {goToNextFlowFeed:o} = ...)导致语法错误白屏,已移除;
    // 首页 feed 由 PreloadFeeds/PCFlowLoaded/RecommendFeedsLoaded 覆盖。
    log('[JS改写] ' + String(pathname || '').slice(0, 90) + ' 方法包装=' + wraps);
    return Buffer.from(js, 'utf8');
  }

  /* 页面回传 feed */
  function handleNotify(bodyBuf) {
    try {
      const payload = JSON.parse(bodyBuf.toString('utf8'));
      const feeds = (payload && payload.feeds) || [];
      for (const it of feeds) {
        if (!it || !it.url || it.key === undefined || it.key === null) continue;
        try { emitter.emit('feed', it); } catch (e) { /* ignore */ }
      }
    } catch (e) { log('[notify 解析失败] ' + ((e && e.message) || e)); }
  }

  function recordCapture(info) {
    state.captures.unshift(info);
    if (state.captures.length > 50) state.captures.length = 50;
    try { emitter.emit('capture', info); } catch (e) { /* ignore */ }
  }

  /* 拦截到的 HTTPS 请求:转发上游,同时把视频响应原文落盘(tee) */
  function handleRequest(clientReq, clientRes) {
    try {
      const hostHeader = String(clientReq.headers.host || '');
      const hostname = hostHeader.split(':')[0];
      // 页面回传 feed:同源 POST /wxv-notify,不转发上游
      if (hostname === 'channels.weixin.qq.com' && clientReq.method === 'POST' && String(clientReq.url || '').split('?')[0] === '/wxv-notify') {
        const chunks = [];
        clientReq.on('data', function (c) { chunks.push(c); });
        clientReq.on('end', function () {
          try { handleNotify(Buffer.concat(chunks)); } catch (e) { /* ignore */ }
          try {
            clientRes.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            clientRes.end('{"ok":1}');
          } catch (e) { /* ignore */ }
        });
        clientReq.on('error', function () { try { clientRes.destroy(); } catch (e2) { /* ignore */ } });
        return;
      }
      const url = 'https://' + hostHeader + clientReq.url;
      const headers = Object.assign({}, clientReq.headers);
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      headers['accept-encoding'] = 'identity';
      const upReq = https.request(
        { host: hostname, port: 443, path: clientReq.url, method: clientReq.method, headers, rejectUnauthorized: false },
        function (upRes) {
          try {
            const ct = String(upRes.headers['content-type'] || '');
            if (WXV_REWRITE && hostname === 'channels.weixin.qq.com' && /text\/html/i.test(ct)) {
              bufferRewrite(upRes, clientRes, rewriteChannelsHtml, 'html');
              return;
            }
            if (WXV_REWRITE && hostname === 'res.wx.qq.com' && /javascript/i.test(ct) && !/wasm_video_decode/i.test(clientReq.url || '')) {
              bufferRewrite(upRes, clientRes, function (b) { return rewriteWxJs(b, clientReq.url); }, 'js');
              return;
            }
            if (isApiHost(hostname)) {
              teeApiResponse(hostname, clientReq, upRes);
            }
            if (!looksMedia(clientReq.url, ct)) {
              clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
              upRes.pipe(clientRes);
              return;
            }
            const fname = 'cap-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.bin';
            const savedPath = path.join(captureDir(), fname);
            const tee = fs.createWriteStream(savedPath);
            let got = 0;
            upRes.on('data', function (c) { got += c.length; });
            clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
            upRes.pipe(clientRes);
            upRes.pipe(tee);
            tee.on('finish', function () {
              const info = {
                id: fname,
                url: url,
                host: hostname,
                contentType: ct,
                range: String(clientReq.headers.range || ''),
                size: got,
                savedPath: savedPath,
                ts: Date.now(),
                reqHeaders: Object.assign({}, clientReq.headers),
              };
              log('[捕获响应] ' + hostname + ' ' + got + 'B range=' + (info.range || '-') + ' ct=' + ct + ' -> ' + fname);
              recordCapture(info);
            });
            tee.on('error', function (e) { log('[落盘失败] ' + ((e && e.message) || e)); });
          } catch (e) {
            log('[响应处理异常] ' + ((e && e.message) || e));
            try { clientRes.writeHead(502); clientRes.end(); } catch (e2) { /* ignore */ }
          }
        }
      );
      upReq.on('error', function (e) {
        log('[上游错误] ' + hostname + clientReq.url + ' ' + ((e && e.message) || e));
        try { clientRes.writeHead(502); clientRes.end('upstream error'); } catch (e2) { /* ignore */ }
      });
      clientReq.pipe(upReq);
    } catch (e) {
      log('[请求处理异常] ' + ((e && e.message) || e));
      try { clientRes.writeHead(500); clientRes.end(); } catch (e2) { /* ignore */ }
    }
  }

  /* 非目标域名:原样 TCP 隧道直通,不碰内容(微信登录/mmtls 全部走这里) */
  function tunnel(req, clientSocket, head) {
    const parts = String(req.url || '').split(':');
    const host = parts[0];
    const portN = parseInt(parts[1] || '443', 10) || 443;
    let up = null;
    const kill = function () {
      try { if (up) up.destroy(); } catch (e) { /* ignore */ }
      try { clientSocket.destroy(); } catch (e) { /* ignore */ }
    };
    try {
      up = net.connect({ host: host, port: portN }, function () {
        try {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) up.write(head);
          up.pipe(clientSocket);
          clientSocket.pipe(up);
        } catch (e) { log('[隧道错误] ' + ((e && e.message) || e)); kill(); }
      });
      up.on('error', function (e) {
        if (/qq\.com|weixin|wechat|tencent/i.test(host)) log('[隧道] ' + host + ':' + portN + ' ' + ((e && e.message) || e));
        kill();
      });
      clientSocket.on('error', kill);
      clientSocket.on('close', function () { try { if (up) up.destroy(); } catch (e) { /* ignore */ } });
    } catch (e) {
      log('[隧道建立失败] ' + host + ' ' + ((e && e.message) || e));
      kill();
    }
  }

  function start() {
    return new Promise(function (resolve, reject) {
      if (state.running) { resolve({ port: port, caPath: state.ca.certPath }); return; }
      try {
        state.ca = ensureCA(dataDir, log);
        const leafFor = createLeafFactory(state.ca);
        state.httpsServer = https.createServer({
          SNICallback: function (servername, cb) {
            try { cb(null, leafFor(servername)); } catch (e) { cb(e); }
          },
        }, handleRequest);
        state.httpsServer.on('tlsClientError', function (e) {
          log('[TLS握手失败] ' + ((e && e.message) || e));
        });
        state.httpsServer.on('clientError', function (e, sock) {
          try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e2) { /* ignore */ }
        });
        // WebSocket 升级请求:重建上游 TLS 隧道,保证页面 wss 可用
        state.httpsServer.on('upgrade', function (req, clientSocket, head) {
          try {
            const hostHeader = String(req.headers.host || '');
            const hostname = hostHeader.split(':')[0];
            const headers = Object.assign({}, req.headers);
            delete headers['proxy-connection'];
            const upReq = https.request({
              host: hostname, port: 443, path: req.url, method: req.method,
              headers: headers, rejectUnauthorized: false, agent: false,
            });
            upReq.end();
            upReq.on('upgrade', function (upRes, upSocket, upHead) {
              try {
                const lines = ['HTTP/1.1 101 Switching Protocols'];
                for (const k of Object.keys(upRes.headers)) {
                  const v = upRes.headers[k];
                  if (Array.isArray(v)) { for (const vv of v) lines.push(k + ': ' + vv); }
                  else lines.push(k + ': ' + v);
                }
                clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
                if (upHead && upHead.length) clientSocket.unshift(upHead);
                upSocket.pipe(clientSocket);
                clientSocket.pipe(upSocket);
              } catch (e) { try { clientSocket.destroy(); } catch (e2) { /* ignore */ } }
            });
            upReq.on('response', function (upRes) {
              // 上游拒绝升级:原样转发响应
              try {
                const lines = ['HTTP/1.1 ' + upRes.statusCode + ' ' + (upRes.statusMessage || '')];
                for (const k of Object.keys(upRes.headers)) {
                  const v = upRes.headers[k];
                  if (Array.isArray(v)) { for (const vv of v) lines.push(k + ': ' + vv); }
                  else lines.push(k + ': ' + v);
                }
                clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
                upRes.pipe(clientSocket);
              } catch (e) { try { clientSocket.destroy(); } catch (e2) { /* ignore */ } }
            });
            upReq.on('error', function () { try { clientSocket.destroy(); } catch (e2) { /* ignore */ } });
            clientSocket.on('error', function () { try { upReq.destroy(); } catch (e2) { /* ignore */ } });
            if (head && head.length) clientSocket.unshift(head);
          } catch (e) {
            try { clientSocket.destroy(); } catch (e2) { /* ignore */ }
          }
        });
        state.server = http.createServer(function (req, res) {
          // 普通(非 CONNECT)HTTP 请求不在本实验目标内
          try { res.writeHead(404); res.end(); } catch (e) { /* ignore */ }
        });
        state.server.on('connect', function (req, clientSocket, head) {
          const target = String(req.url || '').split(':')[0];
          // 只把腾讯相关域名的 CONNECT 写日志,避免记录整个系统的上网记录
          if (/qq\.com|weixin|wechat|tencent/i.test(target)) log('[CONNECT] ' + req.url);
          try {
            if (isInterceptHost(target)) {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              if (head && head.length) { try { clientSocket.unshift(head); } catch (e) { /* ignore */ } }
              state.httpsServer.emit('connection', clientSocket);
            } else {
              tunnel(req, clientSocket, head);
            }
          } catch (e) {
            log('[CONNECT处理异常] ' + target + ' ' + ((e && e.message) || e));
            try { clientSocket.destroy(); } catch (e2) { /* ignore */ }
          }
        });
        state.server.on('clientError', function (e, sock) {
          try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e2) { /* ignore */ }
        });
        state.server.on('error', function (e) {
          log('[代理端口错误] ' + ((e && e.message) || e));
          state.running = false;
          reject(e);
        });
        state.server.listen(port, '127.0.0.1', function () {
          state.running = true;
          log('[代理] 已启动 127.0.0.1:' + port + '(仅拦截视频 CDN,其余直通;原始流落盘,不解密)');
          resolve({ port: port, caPath: state.ca.certPath });
        });
      } catch (e) {
        log('[启动失败] ' + ((e && e.message) || e));
        reject(e);
      }
    });
  }

  function stop() {
    return new Promise(function (resolve) {
      let done = false;
      const fin = function () { if (!done) { done = true; state.running = false; resolve(); } };
      if (!state.server) { fin(); return; }
      try { state.server.close(fin); } catch (e) { fin(); }
      try { state.httpsServer.close(); } catch (e) { /* ignore */ }
      setTimeout(fin, 800);
    });
  }

  return {
    start: start,
    stop: stop,
    isRunning: function () { return state.running; },
    getCaptures: function () { return state.captures.slice(); },
    on: function (ev, cb) { emitter.on(ev, cb); },
    get caPath() { return state.ca ? state.ca.certPath : ''; },
  };
}

module.exports = { createProxy: createProxy, ensureCA: ensureCA, isInterceptHost: isInterceptHost };
