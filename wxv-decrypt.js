'use strict';
/* ============================================================
 * 微信视频号解密(Node 版)
 * 使用微信官方解密模块(res.wx.qq.com decrypt-video-core 1.3.0):
 *   Module.WxIsaac64(decodeKey).generate(131072) 生成 ISAAC64 密钥流,
 *   数组反转后与文件前 131072 字节异或,即得原始 MP4。
 * 与视频号网页播放器的解密实现完全一致。
 * ============================================================ */
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'https://res.wx.qq.com/t/wx_fed/cdn_libs/res/decrypt-video-core/1.3.0';
const KS_LEN = 131072;

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        try { fs.rmSync(dest, { force: true }); } catch (e) { /* ignore */ }
        reject(new Error('HTTP ' + res.statusCode + ' ' + url));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (e) => {
      file.close();
      reject(e);
    });
  });
}

let glueCode = null;
let wasmBytes = null;

async function ensureWasm(dataDir, log) {
  if (glueCode && wasmBytes) return;
  const dir = path.join(dataDir, 'wx-wasm');
  fs.mkdirSync(dir, { recursive: true });
  const gluePath = path.join(dir, 'wasm_video_decode.js');
  const wasmPath = path.join(dir, 'wasm_video_decode.wasm');
  if (!fs.existsSync(gluePath) || fs.statSync(gluePath).size < 1000) {
    log && log('[wasm] 下载官方解密模块 JS…');
    await downloadTo(BASE + '/wasm_video_decode.js', gluePath);
  }
  if (!fs.existsSync(wasmPath) || fs.statSync(wasmPath).size < 1000) {
    log && log('[wasm] 下载官方解密模块 WASM…');
    await downloadTo(BASE + '/wasm_video_decode.wasm', wasmPath);
  }
  glueCode = fs.readFileSync(gluePath, 'utf8');
  wasmBytes = fs.readFileSync(wasmPath);
  log && log('[wasm] 模块就绪 js=' + glueCode.length + 'B wasm=' + wasmBytes.length + 'B');
}

const keystreamCache = new Map();

async function getKeystream(key, dataDir, log) {
  const cacheKey = String(key);
  if (keystreamCache.has(cacheKey)) return keystreamCache.get(cacheKey);
  await ensureWasm(dataDir, log);

  let captured = null;
  let mod = null;
  const Module = {
    wasmBinary: wasmBytes,
    print: function () {},
    printErr: function () {},
  };
  // 在受控作用域里执行官方 glue:注入 Module / wasm_isaac_generate / require 等
  const runner = new Function(
    'Module', 'wasm_isaac_generate', 'require', '__dirname', '__filename', 'self', 'VTS_WASM_URL', 'MAX_HEAP_SIZE',
    glueCode + '\n;return Module;'
  );
  mod = runner(
    Module,
    function (ptr, len) {
      try {
        const arr = new Uint8Array(mod.HEAPU8.buffer, ptr, len);
        captured = new Uint8Array(arr);
        captured.reverse();
      } catch (e) { /* ignore */ }
    },
    require,
    __dirname,
    __filename,
    { location: { href: BASE + '/wasm_video_decode.js' } },
    BASE + '/wasm_video_decode.wasm',
    33554432,
  );

  // 等待运行时就绪(部分构建为异步初始化)
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function chk() {
      if (mod && mod.WxIsaac64) return resolve();
      if (Date.now() - t0 > 30000) return reject(new Error('WASM 初始化超时'));
      setTimeout(chk, 50);
    })();
  });

  let dec = null;
  try {
    dec = new mod.WxIsaac64(String(key));
  } catch (e) {
    // 某些绑定要求 BigInt 种子
    dec = new mod.WxIsaac64(BigInt(key));
  }
  dec.generate(KS_LEN);
  if (!captured || captured.length !== KS_LEN) {
    throw new Error('密钥流生成失败(' + (captured ? captured.length : 0) + ' 字节)');
  }
  keystreamCache.set(cacheKey, captured);
  return captured;
}

async function decryptBuffer(buf, key, dataDir, log) {
  const ks = await getKeystream(key, dataDir, log);
  const out = Buffer.from(buf);
  const n = Math.min(ks.length, out.length);
  for (let i = 0; i < n; i += 1) out[i] ^= ks[i];
  const head = out.slice(0, 12).toString('hex');
  log && log('[解密] key=' + key + ' 异或前 ' + n + ' 字节, 头部=' + head);
  return out;
}

module.exports = { decryptBuffer, getKeystream };
