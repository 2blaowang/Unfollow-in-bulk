/* ============================================================
 * 微信表情包导出 - 包装开源工具 wxemoticon
 * 工具:https://github.com/liusheng22/export-wechat-emoji
 * 原理:微信 4.x 本地表情文件是加密的,wxemoticon 从运行中的微信
 *       进程提取数据库密钥 → 解密 emoticon.db 得到每个表情的
 *       CDN 地址与 AES 密钥 → 下载并还原为原始图片(GIF/PNG/JPG)。
 * 本模块职责:工具定位/下载(SHA-256 校验)/账号列表/调用导出/进度。
 * 实测(v0.3.0):无需管理员、无需退出微信;925 个表情约 2.5 分钟。
 * ============================================================ */
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const REL = 'v0.3.0';
const ZIP_URL = `https://github.com/liusheng22/export-wechat-emoji/releases/download/${REL}/wxemoticon-x86_64-windows.zip`;
const ZIP_NAME = 'wxemoticon-x86_64-windows.zip';
/* 与官方 SHA256SUMS-windows.txt 一致,防止下载被篡改 */
const ZIP_SHA256 = 'ceb10c0b2052716cc493e5446d3cb59d1b3090d2b64014ad6ddc7b3b28a033d0';

let app = null;
try { app = require('electron').app; } catch (e) { /* 非 Electron 环境测试用 */ }

const baseDir = () => (app && app.getPath ? app.getPath('userData') : path.join(os.tmpdir(), 'bulk-unfollow'));
const managedToolPath = () => path.join(baseDir(), 'tools', 'wxemoticon', 'wxemoticon.exe');
const installerToolPath = () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'wxemoticon', 'wxemoticon.exe');

function findTool() {
  for (const p of [managedToolPath(), installerToolPath()]) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  try {
    const out = execSync('where wxemoticon', { encoding: 'utf8' });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (e) { /* PATH 中没有 */ }
  return null;
}

function runTool(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { windowsHide: true });
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { p.kill(); } catch (e) { /* ignore */ } resolve({ ok: false, error: '命令超时' }); }
    }, timeoutMs || 120000);
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { out += String(d); });
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: '启动失败:' + e.message }); } });
    p.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out });
    });
  });
}

async function toolVersion(exe) {
  const r = await runTool(exe, ['--version'], 30000);
  const m = String(r.output || '').match(/wxemoticon\s+(\S+)/);
  return m ? m[1] : (r.ok ? '未知版本' : '');
}

/* ---------- 状态 ---------- */
async function status() {
  const exe = findTool();
  if (!exe) return { ok: true, tool: { found: false } };
  const version = await toolVersion(exe);
  return { ok: true, tool: { found: true, path: exe, version } };
}

/* ---------- 工具下载与安装(带哈希校验) ---------- */
async function downloadWithProgress(url, dest, timeoutMs, onProgress) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastSent = 0;
  const buf = [];
  for await (const chunk of res.body) {
    buf.push(chunk);
    received += chunk.length;
    if (onProgress && received - lastSent > 256 * 1024) {
      lastSent = received;
      onProgress({ received, total });
    }
  }
  if (onProgress) onProgress({ received, total: total || received });
  await fsp.writeFile(dest, Buffer.concat(buf));
  return received;
}

async function unzip(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`],
      { windowsHide: true }
    );
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('解压失败:' + err.slice(-300)))));
  });
}

async function installTool(ctl) {
  const log = (m) => ctl && ctl.log && ctl.log(m);
  const tmpDir = path.join(os.tmpdir(), 'bulk-unfollow-wxemo');
  await fsp.mkdir(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, ZIP_NAME);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      log(`下载导出工具(${REL}),第 ${attempt} 次尝试,约 3.7MB,GitHub 直连可能较慢…`);
      await downloadWithProgress(
        ZIP_URL,
        zipPath,
        600000,
        (p) => ctl && ctl.progress && ctl.progress({ stage: 'download', received: p.received, total: p.total })
      );
      break;
    } catch (e) {
      if (attempt >= 3) {
        return { ok: false, message: '下载失败:' + ((e && e.message) || e) + '。可在应用外手动下载:' + ZIP_URL };
      }
      log('下载失败,3 秒后重试…');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const hash = crypto.createHash('sha256').update(await fsp.readFile(zipPath)).digest('hex');
  if (hash !== ZIP_SHA256) {
    return { ok: false, message: '下载文件校验失败(哈希不匹配),已放弃安装。请检查网络环境后重试。' };
  }
  log('校验通过,正在解压安装…');
  const destDir = path.join(baseDir(), 'tools', 'wxemoticon');
  await unzip(zipPath, destDir);
  const exe = managedToolPath();
  if (!fs.existsSync(exe)) return { ok: false, message: '安装后未找到 wxemoticon.exe' };
  const version = await toolVersion(exe);
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  log('工具就绪:wxemoticon ' + version);
  return { ok: true, path: exe, version };
}

/* 从用户手动下载的 zip 安装(自动下载失败时的兜底) */
async function installFromZip(zipPath, ctl) {
  try {
    const hash = crypto.createHash('sha256').update(await fsp.readFile(zipPath)).digest('hex');
    if (hash !== ZIP_SHA256) return { ok: false, message: '所选 zip 校验失败(哈希不匹配)。请从官方 Releases 下载 ' + ZIP_NAME };
    const destDir = path.join(baseDir(), 'tools', 'wxemoticon');
    await unzip(zipPath, destDir);
    const exe = managedToolPath();
    if (!fs.existsSync(exe)) return { ok: false, message: '解压后未找到 wxemoticon.exe' };
    const version = await toolVersion(exe);
    if (ctl && ctl.log) ctl.log('工具就绪:wxemoticon ' + version);
    return { ok: true, path: exe, version };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
}

/* ---------- 账号列表 ---------- */
async function listAccounts() {
  const exe = findTool();
  if (!exe) return { ok: false, message: '导出工具未安装' };
  const r = await runTool(exe, ['urls', '--list-accounts', '--json'], 60000);
  if (!r.ok && !r.output.trim()) return { ok: false, message: '列账号失败(退出码 ' + r.code + '):' + r.output.slice(-200) };
  const ids = String(r.output).split(/\r?\n/).map((s) => s.trim())
    .filter((s) => /^wxid_[A-Za-z0-9_]+$/.test(s) || /^[a-zA-Z0-9_-]{6,64}$/.test(s));
  return { ok: ids.length > 0, accounts: [...new Set(ids)] };
}

/* ---------- 导出 ---------- */
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n += 1;
    }
  };
  walk(dir);
  return n;
}

async function exportStickers(opts, ctl) {
  const exe = findTool();
  if (!exe) return { ok: false, message: '导出工具未安装' };
  const args = ['export', '--no-interactive', '--json', '--skip-existing'];
  if (opts.flat) args.push('--flat');
  if (opts.outDir) args.push('--out-dir', String(opts.outDir));
  if (opts.wxid) args.push('--wxid', String(opts.wxid));

  return await new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    if (ctl && ctl.register) ctl.register(child);
    let out = '';
    let total = 0;
    let pollTimer = null;
    const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };

    const finish = (result) => {
      stopPoll();
      try { child.kill(); } catch (e) { /* ignore */ }
      resolve(result);
    };

    /* 导出过程 CLI 不输出逐个进度,轮询导出目录文件数来显示进度 */
    pollTimer = setInterval(() => {
      if (!opts.outDir || !ctl || !ctl.progress) return;
      const done = countFiles(String(opts.outDir));
      if (done > 0) ctl.progress({ stage: 'export', done, total: total || undefined });
    }, 2000);

    child.stdout.on('data', (d) => {
      out += String(d);
      for (const line of String(d).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (ctl && ctl.log) ctl.log(t);
        const m = t.match(/已生成 URL 列表[:：]\s*(\d+)\s*条/);
        if (m) {
          total = parseInt(m[1], 10);
          if (ctl && ctl.progress) ctl.progress({ stage: 'list', total });
        }
      }
    });
    child.stderr.on('data', (d) => {
      const t = String(d).trim();
      if (t && ctl && ctl.log) ctl.log(t);
    });
    child.on('error', (e) => finish({ ok: false, message: '启动导出失败:' + e.message }));
    child.on('close', (code) => {
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      let summary = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].startsWith('{')) {
          try { summary = JSON.parse(lines[i]); break; } catch (e) { /* 继续向上找 */ }
        }
      }
      if (summary) {
        finish({
          ok: true,
          summary,
          outDir: summary.outDir || opts.outDir || '',
          message: `导出完成:成功 ${summary.ok},跳过 ${summary.skipped},失败 ${summary.failed}`,
        });
      } else if (code === 0) {
        finish({ ok: true, outDir: opts.outDir || '', message: '导出完成(未解析到统计信息)' });
      } else {
        finish({
          ok: false,
          message: '导出失败(退出码 ' + code + ')。若提示密钥相关错误,请完全退出微信后重试;详见日志。',
        });
      }
    });
  });
}

module.exports = { status, installTool, installFromZip, listAccounts, exportStickers, findTool, ZIP_URL, REL };
