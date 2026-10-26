/* ============================================================
 * B 站一键取关助手 - Electron 主进程
 * 职责:窗口管理、B 站登录(持久会话)、代理渲染进程调用 B 站接口
 *       + 视频下载:解析分享链接 → 下载视频/音频流 → ffmpeg 合并
 * 接口(与网页端一致):
 *   账号  GET  https://api.bilibili.com/x/web-interface/nav
 *   列表  GET  https://api.bilibili.com/x/relation/followings
 *   取关  POST https://api.bilibili.com/x/relation/modify  (act=2)
 *   视频  GET  https://api.bilibili.com/x/web-interface/view
 *         GET  https://api.bilibili.com/x/player/playurl (fnval=4048 DASH)
 * ============================================================ */
const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PARTITION = 'persist:bilibili';
const LOGIN_URL = 'https://passport.bilibili.com/login';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const FOLLOWINGS_URL = 'https://api.bilibili.com/x/relation/followings';
const MODIFY_URL = 'https://api.bilibili.com/x/relation/modify';

let mainWin = null;
let unfollowWin = null;
let loginWin = null;
let loginPollTimer = null;

const biliSession = () => session.fromPartition(PARTITION);

function sendToMain(channel, payload) {
  // 广播到所有窗口(视频下载在主窗口,登录状态两个窗口都需要)
  for (const w of [mainWin, unfollowWin]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(channel, payload); } catch (e) { /* ignore */ }
    }
  }
}

/* ---------- Cookie 与通用请求 ---------- */
async function cookieString() {
  const list = await biliSession().cookies.get({ url: 'https://api.bilibili.com' });
  return list.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function biliJSON(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { code: -1, message: `HTTP ${res.status} 非JSON响应` };
  }
}

function biliHeaders(extra) {
  return Object.assign(
    {
      'User-Agent': UA,
      Referer: 'https://space.bilibili.com/',
      Origin: 'https://space.bilibili.com',
    },
    extra || {}
  );
}

/* ---------- ffmpeg ---------- */
let _ffmpegPath;
function getFfmpegPath() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  try {
    _ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    if (fs.existsSync(_ffmpegPath)) return _ffmpegPath;
  } catch (e) {
    /* 未随包安装,继续找系统 ffmpeg */
  }
  try {
    const out = execSync('where ffmpeg', { encoding: 'utf8' });
    const first = String(out)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    _ffmpegPath = first || null;
  } catch (e) {
    _ffmpegPath = null;
  }
  return _ffmpegPath;
}

function muxVideo(videoPath, audioPath, outPath) {
  const ff = getFfmpegPath();
  if (!ff) return Promise.resolve({ ok: false, message: '未找到 ffmpeg(依赖未装好且系统 PATH 中也没有)' });
  return new Promise((resolve) => {
    const p = spawn(
      ff,
      ['-y', '-loglevel', 'error', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-movflags', '+faststart', outPath],
      { windowsHide: true }
    );
    let err = '';
    p.stderr.on('data', (d) => {
      err += String(d);
      if (err.length > 8000) err = err.slice(-4000);
    });
    p.on('error', (e) => resolve({ ok: false, message: 'ffmpeg 启动失败:' + e.message }));
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) resolve({ ok: true });
      else resolve({ ok: false, message: err || 'ffmpeg 退出码 ' + code });
    });
  });
}

/* ---------- 取关相关接口 ---------- */
async function biliNav() {
  const cookie = await cookieString();
  return biliJSON(NAV_URL, { headers: biliHeaders({ Cookie: cookie }), signal: AbortSignal.timeout(15000) });
}

async function biliFollowings(mid, pn, ps) {
  const cookie = await cookieString();
  const url = `${FOLLOWINGS_URL}?vmid=${mid}&pn=${pn}&ps=${ps}`;
  return biliJSON(url, { headers: biliHeaders({ Cookie: cookie }), signal: AbortSignal.timeout(15000) });
}

async function biliUnfollow(mid) {
  const cookie = await cookieString();
  const m = cookie.match(/bili_jct=([^;]+)/);
  if (!m) return { code: -111, message: '未获取到登录凭证 bili_jct,请重新登录' };
  const body = new URLSearchParams({ fid: String(mid), act: '2', re_src: '11', csrf: m[1] });
  return biliJSON(MODIFY_URL, {
    method: 'POST',
    headers: biliHeaders({
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
}

async function checkLogin() {
  try {
    const cookie = await cookieString();
    if (!cookie.includes('SESSDATA=')) return { loggedIn: false };
    const r = await biliNav();
    if (r && r.code === 0 && r.data && r.data.isLogin) {
      return {
        loggedIn: true,
        mid: r.data.mid,
        uname: r.data.uname,
        face: r.data.face || '',
      };
    }
    return { loggedIn: false, reason: r ? `code=${r.code}` : '无响应' };
  } catch (e) {
    return { loggedIn: false, reason: (e && e.message) || String(e) };
  }
}

/* ---------- 视频下载:解析 ---------- */
function extractBvidOrAid(text) {
  const t = String(text || '');
  let m = t.match(/BV[0-9A-Za-z]{10}/i);
  if (m) return { bvid: m[0].replace(/^bv/i, 'BV') };
  m = t.match(/av(\d{3,})/i);
  if (m) return { aid: m[1] };
  m = t.trim().match(/^(\d{4,})$/);
  if (m) return { aid: m[1] };
  return null;
}

async function resolveShareLink(text) {
  const t = String(text || '').trim();
  let ref = extractBvidOrAid(t);
  if (!ref && /b23\.tv|bili2233/i.test(t)) {
    const m = t.match(/https?:\/\/(b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/i);
    if (m) {
      try {
        const res = await fetch(m[0], {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(15000),
        });
        ref = extractBvidOrAid(res.url || '');
      } catch (e) {
        return { ok: false, message: '短链解析失败:' + ((e && e.message) || e) };
      }
    }
  }
  if (!ref) return { ok: false, message: '未识别到 BV 号 / av 号 / 链接' };

  const q = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${ref.aid}`;
  const r = await biliJSON(`https://api.bilibili.com/x/web-interface/view?${q}`, {
    headers: biliHeaders({ Cookie: await cookieString() }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r || r.code !== 0 || !r.data) {
    return { ok: false, message: r ? `获取视频信息失败:code=${r.code} ${r.message}` : '无响应' };
  }
  const d = r.data;
  return {
    ok: true,
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    owner: d.owner && d.owner.name,
    duration: d.duration,
    pages: (d.pages || []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
  };
}

/* ---------- 视频下载:清晰度(playurl, DASH) ---------- */
async function biliPlayurl(bvid, cid) {
  const cookie = await cookieString();
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=0&fnval=4048&fourk=1`;
  const r = await biliJSON(url, { headers: biliHeaders({ Cookie: cookie }), signal: AbortSignal.timeout(15000) });
  if (!r || r.code !== 0 || !r.data) {
    return { ok: false, message: r ? `code=${r.code} ${r.message}` : '无响应' };
  }
  const d = r.data;
  const dash = d.dash || {};
  const nameOf = (id) => {
    const f = (d.support_formats || []).find((s) => s.quality === id);
    return f ? f.new_description || f.display_desc || f.format : `${id}`;
  };
  const len = (d.timelength || 0) / 1000;
  const videos = (dash.video || []).map((v) => ({
    id: v.id,
    name: nameOf(v.id),
    codecs: v.codecs || '',
    width: v.width,
    height: v.height,
    sizeMB: Math.round(((v.bandwidth || 0) * len) / 8 / 1024 / 1024),
    urls: [v.base_url, ...(v.backup_url || [])].filter(Boolean),
  }));
  const audios = (dash.audio || []).map((a) => ({
    id: a.id,
    bandwidth: a.bandwidth || 0,
    urls: [a.base_url, ...(a.backup_url || [])].filter(Boolean),
  }));
  if (!videos.length) return { ok: false, message: '未获取到清晰度数据(该视频可能不支持或需登录)' };
  return { ok: true, videos, audios, timelength: d.timelength };
}

/* ---------- 视频下载:流下载(带备用地址与进度) ---------- */
async function downloadStream(urls, dest, key, extraHeaders, xorArray) {
  let lastErr = null;
  for (const url of urls) {
    const ctrl = new AbortController();
    let stallTimer = null;
    try {
      const res = await fetch(url, {
        headers: Object.assign({ 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, extraHeaders || {}),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const ctype = String(res.headers.get('content-type') || '');
      if (/text\/html|application\/json|application\/xml|text\/xml/i.test(ctype)) {
        throw new Error('返回的不是视频文件(链接可能已过期): ' + ctype);
      }
      const total = Number(res.headers.get('content-length')) || 0;
      let received = 0;
      let lastSent = 0;
      var xorApplied = 0;
      const resetStall = function () {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(function () {
          ctrl.abort(new Error('下载停滞(25 秒无数据,CDN 可能拒绝该直链)'));
        }, 25000);
      };
      resetStall();
      await pipeline(
        Readable.fromWeb(res.body),
        async function* (source) {
          for await (const chunk of source) {
            if (xorArray && xorApplied < xorArray.length) {
              const n = Math.min(xorArray.length - xorApplied, chunk.length);
              for (let i = 0; i < n; i += 1) chunk[i] ^= xorArray[xorApplied + i];
              xorApplied += n;
            }
            received += chunk.length;
            resetStall();
            if (received - lastSent > 512 * 1024) {
              lastSent = received;
              sendToMain('dl:progress', { key, received, total });
            }
            yield chunk;
          }
        },
        fs.createWriteStream(dest)
      );
      if (stallTimer) clearTimeout(stallTimer);
      sendToMain('dl:progress', { key, received, total: total || received });
      return { ok: true, bytes: received };
    } catch (e) {
      if (stallTimer) clearTimeout(stallTimer);
      lastErr = e;
      try {
        await fsp.rm(dest, { force: true });
      } catch (_) {
        /* ignore */
      }
    }
  }
  return { ok: false, message: (lastErr && lastErr.message) || String(lastErr) };
}

/* ---------- 登录窗口 ---------- */
function stopLoginPoll() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

function startLoginPoll() {
  stopLoginPoll();
  let attempts = 0;
  loginPollTimer = setInterval(async () => {
    attempts += 1;
    if (attempts > 240) {
      stopLoginPoll();
      return;
    }
    try {
      const list = await biliSession().cookies.get({ domain: 'bilibili.com' });
      const hasSess = list.some((c) => c.name === 'SESSDATA');
      const hasJct = list.some((c) => c.name === 'bili_jct');
      if (hasSess && hasJct) {
        const info = await checkLogin();
        if (info.loggedIn) {
          stopLoginPoll();
          if (loginWin && !loginWin.isDestroyed()) loginWin.close();
          sendToMain('login:success', info);
        }
      }
    } catch (e) {
      /* 轮询错误忽略,下一轮继续 */
    }
  }, 1500);
}

function openLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return;
  }
  loginWin = new BrowserWindow({
    width: 450,
    height: 680,
    title: '登录 B 站',
    autoHideMenuBar: true,
    parent: mainWin && !mainWin.isDestroyed() ? mainWin : undefined,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWin.loadURL(LOGIN_URL);
  loginWin.on('closed', () => {
    loginWin = null;
    stopLoginPoll();
  });
  startLoginPoll();
}

/* ---------- IPC ---------- */
ipcMain.handle('login:check', () => checkLogin());
ipcMain.handle('login:start', () => openLoginWindow());
ipcMain.handle('login:logout', async () => {
  stopLoginPoll();
  if (loginWin && !loginWin.isDestroyed()) loginWin.close();
  await biliSession().clearStorageData();
  return { ok: true };
});
ipcMain.handle('bili:nav', () => biliNav());
ipcMain.handle('bili:followings', (_e, mid, pn, ps) => biliFollowings(mid, pn, ps));
ipcMain.handle('bili:unfollow', (_e, mid) => biliUnfollow(mid));

ipcMain.handle('video:resolve', (_e, text) => resolveShareLink(text));
ipcMain.handle('video:playurl', (_e, bvid, cid) => biliPlayurl(bvid, cid));
ipcMain.handle('video:pick-save', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(mainWin, {
    defaultPath: defaultName,
    filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('video:download', async (_e, { key, videoUrls, audioUrls, videoTmp, audioTmp }) => {
  const v = await downloadStream(videoUrls, videoTmp, key + ':v');
  if (!v.ok) return { ok: false, message: '视频流下载失败:' + v.message };
  const a = await downloadStream(audioUrls, audioTmp, key + ':a');
  if (!a.ok) return { ok: false, message: '音频流下载失败:' + a.message };
  return { ok: true };
});
ipcMain.handle('video:mux', (_e, { videoTmp, audioTmp, outPath }) => muxVideo(videoTmp, audioTmp, outPath));
ipcMain.handle('video:cleanup', async (_e, files) => {
  for (const f of files || []) {
    try {
      await fsp.rm(f, { force: true });
    } catch (_) {
      /* ignore */
    }
  }
  return { ok: true };
});
ipcMain.handle('video:ffmpeg-check', () => ({ ok: !!getFfmpegPath(), path: getFfmpegPath() || '' }));

/* ============================================================
 * 抖音视频下载(实验性 · 页面捕获直链)
 * 原理:解析分享链接得到视频 ID → 在内嵌窗口中打开 www.douyin.com
 *      视频页 → 页面播放器用自身合法签名请求视频 → 主进程通过
 *      webRequest 捕获 douyinvod 直链 → 直接下载 MP4。
 *      无需实现签名算法;公开视频无需登录(需要登录时可在窗口内扫码)。
 * ============================================================ */
const DY_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DY_CAP_PARTITION = 'douyin-video-capture';

let dyCapWin = null;
let dyCapUrls = [];
let dyCapTitle = '';

const dySleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dyVideoLog(m) {
  try {
    fs.appendFileSync(path.join(app.getAppPath(), 'dyvideo-run.log'), '[' + new Date().toISOString() + '] ' + m + '\n', 'utf8');
  } catch (e) {
    /* ignore */
  }
}

function extractDouyinId(text) {
  const t = String(text || '');
  let m = t.match(/\/video\/(\d{15,})/);
  if (m) return m[1];
  m = t.match(/\/note\/(\d{15,})/);
  if (m) return m[1];
  m = t.match(/modal_id=(\d{15,})/);
  if (m) return m[1];
  m = t.match(/(\d{16,})/);
  if (m) return m[1];
  return null;
}

function classifyDouyinUrl(u) {
  if (/media-audio/.test(u)) return 'audio';
  if (/media-video/.test(u)) return 'video';
  return 'full';
}

function brOf(u) {
  const m = String(u).match(/[?&]br=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function resolveDouyinId(text) {
  const t = String(text || '').trim();
  var id = extractDouyinId(t);
  if (id) return { ok: true, id: id };
  const m = t.match(/https?:\/\/v\.douyin\.com\/[0-9A-Za-z\-_]+/i);
  if (!m) return { ok: false, message: '未识别到抖音链接或视频 ID' };
  const res = await fetch(m[0], {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': DY_MOBILE_UA },
    signal: AbortSignal.timeout(20000),
  }).catch(function () { return null; });
  if (!res) return { ok: false, message: '短链解析失败(网络错误)' };
  id = extractDouyinId(res.url || '');
  if (!id) {
    const html = await res.text().catch(function () { return ''; });
    id = extractDouyinId(html);
  }
  if (!id) return { ok: false, message: '短链未指向视频(' + String(res.url || '').slice(0, 80) + ')' };
  return { ok: true, id: id };
}

function dyCapSend(msg) {
  sendToMain('dyvideo:status', { msg: msg });
}

ipcMain.handle('dyvideo:resolve', async (_e, text) => resolveDouyinId(text));

ipcMain.handle('unfollow:open', () => {
  if (unfollowWin && !unfollowWin.isDestroyed()) {
    unfollowWin.focus();
    return { ok: true };
  }
  unfollowWin = new BrowserWindow({
    width: 680,
    height: 840,
    minWidth: 560,
    minHeight: 600,
    title: '批量取关',
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  unfollowWin.loadFile(path.join(__dirname, 'renderer', 'unfollow.html'));
  unfollowWin.on('closed', () => { unfollowWin = null; });
  return { ok: true };
});

ipcMain.handle('dyvideo:fetch', async (_e, id) => {
  id = String(id || '').trim();
  if (!/^\d{15,}$/.test(id)) return { ok: false, message: '视频 ID 无效' };
  dyVideoLog('捕获直链:打开视频页 ' + id);
  dyCapUrls = [];
  dyCapTitle = '';

  if (dyCapWin && !dyCapWin.isDestroyed()) {
    try { dyCapWin.destroy(); } catch (e) { /* ignore */ }
  }
  dyCapWin = null;

  const ses = session.fromPartition(DY_CAP_PARTITION);
  try { await ses.setUserAgent(UA); } catch (e) { /* ignore */ }
  const filter = {
    urls: ['*://*.douyinvod.com/*', '*://*.douyin.com/aweme/v1/play/*', '*://*.aweme.snssdk.com/aweme/v1/play/*'],
  };
  const handler = function (details) {
    const u = String(details.url || '');
    if (dyCapUrls.length >= 4) return;
    var dup = false;
    for (var i = 0; i < dyCapUrls.length; i++) {
      if (dyCapUrls[i].url.split('?')[0] === u.split('?')[0]) { dup = true; break; }
    }
    if (dup) return;
    var hit = '';
    if (/douyinvod\.com/.test(u) && (/\.mp4|mime_type=video_mp4/i.test(u))) hit = u;
    else if (/aweme\/v1\/play/.test(u)) hit = u;
    if (hit) {
      var kind = classifyDouyinUrl(hit);
      dyCapUrls.push({ url: hit, kind: kind, br: brOf(hit) });
      dyVideoLog('捕获直链(' + dyCapUrls.length + ',' + kind + '):' + hit.slice(0, 500));
    }
  };
  ses.webRequest.onBeforeRequest(filter, handler);

  dyCapWin = new BrowserWindow({
    width: 560,
    height: 780,
    title: '抖音视频页(获取直链中,完成后自动关闭)',
    autoHideMenuBar: true,
    webPreferences: {
      partition: DY_CAP_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dyCapWin.webContents.on('will-prevent-unload', function (event) { event.preventDefault(); });
  dyCapWin.webContents.on('will-navigate', function (e, url) {
    // 阻止 bitbrowser:// 等外部协议触发系统弹窗
    if (!/^https?:\/\/([^/]*\.)?(douyin|iesdouyin|douyinvod|zjcdn)\.com/.test(String(url || ''))) e.preventDefault();
  });
  dyCapWin.on('closed', function () { dyCapWin = null; });

  // 通过调试接口捕获页面自身请求的视频详情(含直链),不受登录墙影响
  var dbg = dyCapWin.webContents.debugger;
  dbg.on('message', function (_ev, method, params) {
    if (method !== 'Network.responseReceived' || dyCapUrls.length >= 3) return;
    try {
      const u = String((params.response && params.response.url) || '');
      if (!/aweme\/detail/i.test(u)) return;
      dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(function (body) {
        if (dyCapUrls.length >= 3) return;
        const j = JSON.parse(body.body);
        const aweme = j.aweme_detail || (j.data && j.data.aweme_detail) || (j.item_list && j.item_list[0]);
        const v = aweme && aweme.video;
        if (!v) return;
        var url = '';
        if (Array.isArray(v.bit_rate) && v.bit_rate.length) {
          var best = v.bit_rate.reduce(function (a, b) { return ((b.bit_rate || 0) > (a.bit_rate || 0) ? b : a); });
          var pa = best.play_addr || {};
          var list = pa.url_list || [];
          url = list.find(function (x) { return /^https:/.test(x); }) || '';
        }
        if (!url && v.play_addr && Array.isArray(v.play_addr.url_list)) {
          url = v.play_addr.url_list.find(function (x) { return /^https:/.test(x); }) || '';
        }
        if (url) {
          const kind = classifyDouyinUrl(url);
          if (dyCapUrls.some(function (x) { return x.url.split('?')[0] === url.split('?')[0]; })) return;
          dyCapUrls.push({ url: url, kind: kind, br: brOf(url) });
          dyVideoLog('从详情接口捕获直链(' + dyCapUrls.length + ',' + kind + '):' + url.slice(0, 300));
          if (!dyCapTitle) dyCapTitle = String(aweme.desc || '').slice(0, 120);
        }
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  });
  try {
    dbg.attach('1.3'); // 同步方法,不返回 Promise(此前误用 .then 导致白屏)
    dbg.sendCommand('Network.enable').catch(function (e) {
      dyVideoLog('Network.enable 失败:' + ((e && e.message) || e));
    });
  } catch (e) {
    dyVideoLog('调试接口附加失败:' + ((e && e.message) || e));
  }

  dyCapWin.loadURL('https://www.douyin.com/video/' + id).catch(function () {});

  const start = Date.now();
  var autoplayTried = 0;
  while (!dyCapUrls.length && Date.now() - start < 180000) {
    await dySleep(1500);
    if (!dyCapWin || dyCapWin.isDestroyed()) break;
    autoplayTried += 1;
    if (autoplayTried >= 2) {
      await dyCapWin.webContents
        .executeJavaScript('(function(){var v=document.querySelector("video");if(v&&v.paused){v.muted=true;var p=v.play();if(p&&p.catch)p.catch(function(){});return "played";}return "";})()')
        .catch(function () { return ''; });
    }
    if (!dyCapTitle) {
      dyCapTitle = await dyCapWin.webContents
        .executeJavaScript('document.title')
        .then(function (t) { return String(t || '').replace(/\s*[-|]\s*抖音\s*$/, '').trim().slice(0, 120); })
        .catch(function () { return ''; });
    }
    dyCapSend(dyCapUrls.length ? '直链已获取,关闭窗口…' : '等待视频加载并捕获直链…(' + Math.round((Date.now() - start) / 1000) + '/180 秒;如弹登录请扫码,如未自动播放请点击播放)');
  }

  var fullUrls = [];
  var videoOnly = [];
  var audioOnly = [];
  for (var ci = 0; ci < dyCapUrls.length; ci++) {
    var it = dyCapUrls[ci];
    if (it.kind === 'audio') audioOnly.push(it);
    else if (it.kind === 'video') videoOnly.push(it);
    else fullUrls.push(it);
  }
  videoOnly.sort(function (a, b) { return b.br - a.br; });
  audioOnly.sort(function (a, b) { return b.br - a.br; });
  var videoUrls = fullUrls.length ? fullUrls.map(function (x) { return x.url; }) : videoOnly.map(function (x) { return x.url; });
  var audioUrls = fullUrls.length ? [] : audioOnly.map(function (x) { return x.url; });
  const result = videoUrls.length
    ? { ok: true, videoUrls: videoUrls, audioUrls: audioUrls, title: dyCapTitle || '抖音视频 ' + id }
    : { ok: false, message: '获取直链超时(180 秒)。请在窗口内登录后重试,或该视频不可公开播放' };
  dyVideoLog(result.ok ? '捕获完成:完整直链 ' + fullUrls.length + ' 条,纯视频 ' + videoOnly.length + ' 条,纯音频 ' + audioOnly.length + ' 条,标题=' + result.title : '捕获失败:' + result.message);
  if (dyCapWin && !dyCapWin.isDestroyed()) {
    try { dyCapWin.destroy(); } catch (e) { /* ignore */ }
  }
  dyCapWin = null;
  try { ses.webRequest.onBeforeRequest(filter, null); } catch (e) { /* ignore */ }
  return result;
});

ipcMain.handle('dyvideo:download', async (_e, { key, videoUrls, audioUrls, dest, title }) => {
  var tmpV = null;
  var tmpA = null;
  try {
    if (!dest) {
      const dir = app.getPath('downloads');
      const base = sanitizeName('抖音_' + (title || 'video'));
      dest = path.join(dir, base + '.mp4');
      var fn = 1;
      while (fs.existsSync(dest)) {
        dest = path.join(dir, base + ' (' + fn + ').mp4');
        fn += 1;
      }
    }
    tmpV = dest + '.v.part';
    tmpA = dest + '.a.part';
    dyVideoLog('开始下载,视频直链:' + String((videoUrls && videoUrls[0]) || '') + ' | 音频直链:' + String((audioUrls && audioUrls[0]) || '无') + ' | 目标:' + dest);
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.douyin.com/',
    Range: 'bytes=0-',
  };
    const rv = await downloadStream(videoUrls, tmpV, key, headers);
    if (!rv.ok) throw new Error('视频流下载失败:' + rv.message);
    if (audioUrls && audioUrls.length) {
      const ra = await downloadStream(audioUrls, tmpA, key + 'a', headers);
      if (!ra.ok) throw new Error('音频流下载失败:' + ra.message);
      dyVideoLog('双流下载完成,开始合并…');
      const m = await muxVideo(tmpV, tmpA, dest);
      if (!m.ok) throw new Error('合并失败:' + m.message);
    } else {
      try {
        await fsp.rename(tmpV, dest);
      } catch (e) {
        await fsp.copyFile(tmpV, dest);
        await fsp.rm(tmpV, { force: true });
      }
    }
    dyVideoLog('下载完成 ' + dest);
    return { ok: true, dest: dest };
  } catch (e) {
    if (tmpV) { try { await fsp.rm(tmpV, { force: true }); } catch (_) { /* ignore */ } }
    if (tmpA) { try { await fsp.rm(tmpA, { force: true }); } catch (_) { /* ignore */ } }
    const msg = (e && e.message) || String(e);
    dyVideoLog('下载失败:' + msg);
    return { ok: false, message: msg };
  }
});

/* ============================================================
 * 微信视频号下载(实验 · 不解密直存)
 * 原理:本地 MITM 代理(127.0.0.1:8899)+ 系统代理切换;
 *   仅拦截视频 CDN 域名(*.video.weixin.qq.com / stodownload* /
 *   finder.video.qq.com),其余微信流量(登录、mmtls 私有协议)
 *   全部原样隧道直通;命中的视频响应原文落盘(不做任何解密),
 *   可用「完整下载」重新拉取完整文件,验证能否直接播放。
 *   首次启动会生成本地根证书(LocalCapture Root CA 2),需安装到
 *   当前用户「受信任的根证书颁发机构」(无需管理员)。
 * ============================================================ */
const WXV_INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const WXV_PORT = 8899;
let wxProxy = null;
let wxSavedProxy = null;
const wxFeedStore = new Map(); // feed.id -> item

function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
}

function wxvLog(m) {
  try {
    fs.appendFileSync(path.join(app.getAppPath(), 'wxv-run.log'), '[' + new Date().toISOString() + '] ' + m + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

function regReadIS(name) {
  try {
    const out = execSync(`reg query "${WXV_INTERNET_SETTINGS}" /v ${name}`, { encoding: 'utf8' });
    const m = out.match(/REG_(SZ|DWORD)\s+(\S+)/);
    return m ? m[2] : '';
  } catch (e) { return ''; }
}
function regWriteIS(name, type, data) {
  try { execSync(`reg add "${WXV_INTERNET_SETTINGS}" /v ${name} /t ${type} /d "${data}" /f`, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
}
function wxvGetSysProxy() {
  return {
    enable: /0x1/i.test(regReadIS('ProxyEnable')),
    server: regReadIS('ProxyServer'),
    override: regReadIS('ProxyOverride'),
    autoConfigUrl: regReadIS('AutoConfigURL'),
  };
}
function wxvApplySysProxy(on, server, override) {
  regWriteIS('ProxyEnable', 'REG_DWORD', on ? '1' : '0');
  if (on && server) regWriteIS('ProxyServer', 'REG_SZ', server);
  if (on && override) regWriteIS('ProxyOverride', 'REG_SZ', override);
}
function wxvRestoreSysProxy(s) {
  if (!s) return;
  regWriteIS('ProxyEnable', 'REG_DWORD', s.enable ? '1' : '0');
  if (s.server) regWriteIS('ProxyServer', 'REG_SZ', s.server);
  if (s.override) regWriteIS('ProxyOverride', 'REG_SZ', s.override);
  if (s.autoConfigUrl) regWriteIS('AutoConfigURL', 'REG_SZ', s.autoConfigUrl);
}
function wxvStatus() {
  return {
    running: !!(wxProxy && wxProxy.isRunning && wxProxy.isRunning()),
    port: WXV_PORT,
    captures: wxvCaptures(),
    feeds: Array.from(wxFeedStore.values()).reverse(),
  };
}

let wxCaptureCache = null;
function wxvCaptures() {
  if (wxProxy) return wxProxy.getCaptures();
  if (wxCaptureCache) return wxCaptureCache;
  try {
    wxCaptureCache = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'wx-captures', 'index.json'), 'utf8'));
  } catch (e) { wxCaptureCache = []; }
  return wxCaptureCache;
}
function wxvSaveCaptures() {
  try {
    const dir = path.join(app.getPath('userData'), 'wx-captures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(wxProxy ? wxProxy.getCaptures() : (wxCaptureCache || []), null, 1), 'utf8');
  } catch (e) { /* ignore */ }
}

ipcMain.handle('wxv:start', async () => {
  try {
    if (!wxProxy) {
      const { createProxy } = require('./wx-proxy');
      wxProxy = createProxy({
        port: WXV_PORT,
        version: String(Date.now()),
        dataDir: app.getPath('userData'),
        onLog: (line) => { wxvLog(line); sendToMain('wxv:log', line); },
      });
      wxProxy.on('capture', (info) => {
        wxvLog('[捕获] ' + info.host + ' ' + info.size + 'B range=' + (info.range || '-') + ' ct=' + (info.contentType || '-') + ' url=' + String(info.url || '').slice(0, 400));
        wxvSaveCaptures();
        sendToMain('wxv:captured', info);
      });
      wxProxy.on('feed', (item) => {
        try {
          const existed = wxFeedStore.has(item.id);
          wxFeedStore.set(item.id, Object.assign({}, item, { ts: Date.now() }));
          if (wxFeedStore.size > 100) {
            const first = wxFeedStore.keys().next().value;
            wxFeedStore.delete(first);
          }
          wxvLog('[Feed] ' + (existed ? '(更新)' : '(新增)') + ' ' + (item.title || item.id) + ' key=' + item.key + ' size=' + item.size);
          sendToMain('wxv:feed', item);
        } catch (e) { /* ignore */ }
      });
    }
    const r = await wxProxy.start();
    if (!wxSavedProxy) {
      wxSavedProxy = wxvGetSysProxy();
      wxvLog('系统代理原配置: enable=' + wxSavedProxy.enable + ' server=' + wxSavedProxy.server + ' override=' + wxSavedProxy.override + ' pac=' + wxSavedProxy.autoConfigUrl);
    }
    wxvApplySysProxy(true, '127.0.0.1:' + r.port, '<local>;localhost;127.0.0.1');
    if (wxSavedProxy.autoConfigUrl) {
      try { execSync(`reg delete "${WXV_INTERNET_SETTINGS}" /v AutoConfigURL /f`, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
    wxvLog('捕获已启动,系统代理已指向 127.0.0.1:' + r.port);
    sendToMain('wxv:status', wxvStatus());
    return { ok: true, port: r.port, caPath: r.caPath };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    wxvLog('启动失败:' + msg);
    return { ok: false, message: msg };
  }
});

ipcMain.handle('wxv:stop', async () => {
  try {
    wxvRestoreSysProxy(wxSavedProxy);
    wxSavedProxy = null;
    if (wxProxy) await wxProxy.stop();
    wxvSaveCaptures();
    wxvLog('捕获已停止,系统代理已还原');
    sendToMain('wxv:status', wxvStatus());
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('wxv:status', () => wxvStatus());

ipcMain.handle('wxv:install-cert', () => {
  const caPath = wxProxy && wxProxy.caPath ? wxProxy.caPath : '';
  if (!caPath || !fs.existsSync(caPath)) return { ok: false, message: '证书尚未生成(请先启动捕获)' };
  try {
    execSync(`certutil -user -addstore Root "${caPath}"`, { stdio: 'pipe' });
    wxvLog('CA 证书已安装到当前用户根证书库:' + caPath);
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || '');
    if (/0x800700b7|already exists|已存在/i.test(msg)) return { ok: true, message: '证书此前已安装' };
    wxvLog('安装证书失败:' + msg.slice(0, 300));
    return { ok: false, message: msg.slice(0, 300) || String(e) };
  }
});

ipcMain.handle('wxv:download', async (_e, url, savePath, reqHeaders) => {
  try {
    if (!/^https:\/\//i.test(String(url || ''))) return { ok: false, message: '仅支持 https 直链' };
    if (!savePath) return { ok: false, message: '未指定保存路径' };
    const headers = Object.assign(
      { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' },
      reqHeaders || {}
    );
    delete headers['accept-encoding'];
    delete headers['Accept-Encoding'];
    delete headers['range'];
    delete headers['host'];
    delete headers['content-length'];
    delete headers['proxy-connection'];
    const r = await downloadStream([String(url)], savePath, 'wxv', headers);
    if (!r.ok) {
      wxvLog('完整下载失败:' + r.message);
      return r;
    }
    // 文件头检测:标准 MP4 应在第 4-7 字节出现 "ftyp";不是则基本可判定为加密流
    let head = { isMp4: false, hex: '' };
    try {
      const fd = fs.openSync(savePath, 'r');
      const b = Buffer.alloc(16);
      fs.readSync(fd, b, 0, 16, 0);
      fs.closeSync(fd);
      head = { isMp4: b.toString('latin1', 4, 8) === 'ftyp', hex: b.toString('hex') };
    } catch (e) { /* ignore */ }
    wxvLog('完整下载完成 ' + savePath + '(' + r.bytes + 'B) 文件头=' + head.hex + ' -> ' + (head.isMp4 ? '标准 MP4,未加密 ✓' : '非标准 MP4 头,疑似加密流 ✗'));
    return { ok: true, bytes: r.bytes, head: head };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('wxv:open', async (_e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, message: '文件不存在' };
    const err = await shell.openPath(p);
    return err ? { ok: false, message: err } : { ok: true };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('wxv:feed-download', async (_e, item, savePath) => {
  try {
    if (!item || !/^https:\/\//i.test(String(item.url || ''))) return { ok: false, message: '视频地址无效' };
    if (item.key === undefined || item.key === null || item.key === '') return { ok: false, message: '缺少 decodeKey(请重新打开该视频页面后重试)' };
    if (!savePath) return { ok: false, message: '未指定保存路径' };
    const tmp = savePath + '.enc.part';
    const r = await downloadStream([String(item.url)], tmp, 'wxv', {});
    if (!r.ok) {
      try { await fsp.rm(tmp, { force: true }); } catch (e2) { /* ignore */ }
      wxvLog('[下载] 失败:' + r.message);
      return { ok: false, message: r.message };
    }
    wxvLog('[下载] 完成 ' + r.bytes + 'B,开始解密 key=' + item.key);
    const { decryptBuffer } = require('./wxv-decrypt');
    const raw = await fsp.readFile(tmp);
    const dec = await decryptBuffer(raw, item.key, app.getPath('userData'), (m) => wxvLog(m));
    await fsp.writeFile(savePath, dec);
    await fsp.rm(tmp, { force: true });
    const isMp4 = dec.length > 12 && dec.toString('latin1', 4, 8) === 'ftyp';
    wxvLog('[解密] 完成 ' + savePath + ' 头部=' + (isMp4 ? 'ftyp ✓' : dec.slice(0, 12).toString('hex')));
    sendToMain('dl:progress', { key: 'wxv', received: dec.length, total: dec.length });
    return { ok: true, head: { isMp4: isMp4, hex: dec.slice(0, 16).toString('hex') } };
  } catch (e) {
    wxvLog('[解密下载] 异常:' + ((e && e.message) || e));
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

/* ============================================================
 * 微信表情包导出:包装开源工具 wxemoticon(见 emoji-export.js)
 * 从运行中的微信提取密钥 → 解密表情索引 → 从微信 CDN 下载原图
 * ============================================================ */
const emojiExport = require('./emoji-export');
let emojiBusy = false;
let emojiChild = null;

ipcMain.handle('emoji:status', () => emojiExport.status());
ipcMain.handle('emoji:accounts', () => emojiExport.listAccounts());
ipcMain.handle('emoji:pick-dir', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '选择导出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('emoji:open', (_e, p) => shell.openPath(String(p || '')));
ipcMain.handle('emoji:install', async (_e, mode) => {
  if (emojiBusy) return { ok: false, message: '有任务进行中' };
  emojiBusy = true;
  try {
    if (mode === 'zip') {
      const zip = await dialog.showOpenDialog(mainWin, {
        title: '选择 ' + emojiExport.ZIP_NAME,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
        properties: ['openFile'],
      });
      if (zip.canceled) return { ok: false, message: '已取消' };
      return await emojiExport.installFromZip(zip.filePaths[0], { log: (m) => sendToMain('emoji:log', { msg: m }) });
    }
    return await emojiExport.installTool({
      log: (m) => sendToMain('emoji:log', { msg: m }),
      progress: (p) => sendToMain('emoji:progress', p),
    });
  } finally {
    emojiBusy = false;
  }
});
ipcMain.handle('emoji:export', async (_e, opts) => {
  if (emojiBusy) return { ok: false, message: '有任务进行中' };
  emojiBusy = true;
  sendToMain('emoji:progress', { stage: 'start' });
  try {
    const r = await emojiExport.exportStickers(opts || {}, {
      log: (m) => sendToMain('emoji:log', { msg: m }),
      progress: (p) => sendToMain('emoji:progress', p),
      register: (child) => { emojiChild = child; },
    });
    sendToMain('emoji:done', r);
    return r;
  } catch (e) {
    const r = { ok: false, message: (e && e.message) || String(e) };
    sendToMain('emoji:done', r);
    return r;
  } finally {
    emojiChild = null;
    emojiBusy = false;
  }
});
ipcMain.handle('emoji:stop', () => {
  if (emojiChild) {
    try { emojiChild.kill(); } catch (e) { /* ignore */ }
    emojiChild = null;
  }
  emojiBusy = false;
  sendToMain('emoji:log', { msg: '已停止' });
  sendToMain('emoji:done', { ok: false, stopped: true, message: '已手动停止' });
  return { ok: true };
});

app.on('before-quit', () => {
  // 退出前还原系统代理,避免残留 127.0.0.1:8899 导致断网
  try {
    wxvSaveCaptures();
    if (wxSavedProxy) wxvRestoreSysProxy(wxSavedProxy);
    else if (wxProxy && wxProxy.isRunning()) wxvApplySysProxy(false, '', '');
  } catch (e) { /* ignore */ }
  try { if (wxProxy && wxProxy.isRunning()) wxProxy.stop(); } catch (e) { /* ignore */ }
});
/* ---------- 主窗口 ---------- */
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 780,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: 'B 站助手 · 视频下载',
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.disableHardwareAcceleration(); // 某些 Windows 显卡驱动会导致 GPU 进程崩溃(0xC0000409),禁用后走软件渲染

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
  app.whenReady().then(createMainWindow);
}

app.on('window-all-closed', () => app.quit());
