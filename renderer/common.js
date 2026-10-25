/* 渲染进程公共工具(主窗口与取关窗口共用) */
const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function sanitizeName(s) {
  return (
    String(s || 'video')
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'video'
  );
}
