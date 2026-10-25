/* 主界面:视频下载(B 站 / 抖音 自动识别) */
let dlRunning = false;
let dlPlatform = null; // 'bilibili' | 'douyin'
let biliVideo = null;
let biliPlay = null;
let dyVideo = null;

function detectPlatform(text) {
  const t = String(text || '');
  if (/b23\.tv/i.test(t) || /bilibili\.com/i.test(t) || /BV[0-9A-Za-z]{10}/.test(t) || /(^|[^0-9A-Za-z])av(\d{3,})/i.test(t)) return 'bilibili';
  if (/v\.douyin\.com/i.test(t) || /douyin\.com/i.test(t) || /iesdouyin/i.test(t) || /\d{16,}/.test(t)) return 'douyin';
  return null;
}

function dlStatus(text) {
  $('dlStatus').textContent = text;
}

function setDlBar(pct) {
  $('dlBar').style.width = pct + '%';
  $('dlPct').textContent = pct + '%';
}

function updatePlatformBadge() {
  const p = detectPlatform($('shareInput').value);
  const b = $('platformBadge');
  if (!p) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  b.className = 'plat-badge ' + (p === 'bilibili' ? 'badge-bili' : 'badge-dy');
  b.textContent = p === 'bilibili' ? '识别到:哔哩哔哩' : '识别到:抖音';
}

function codecName(c) {
  const p = String(c || '').split('.')[0].toLowerCase();
  return { avc1: 'H.264', hev1: 'H.265', hvc1: 'H.265', av01: 'AV1' }[p] || p || '';
}

/* 登录状态(影响 B 站可下载的最高画质) */
function setAccount(info) {
  const loggedIn = !!(info && info.loggedIn);
  if (loggedIn) {
    $('account').classList.remove('hidden');
    $('loginChipBtn').classList.add('hidden');
    $('uname').textContent = info.uname;
    if (info.face) $('avatar').src = info.face;
  } else {
    $('account').classList.add('hidden');
    $('loginChipBtn').classList.remove('hidden');
  }
}

/* ---------- 解析 ---------- */
async function parseShare() {
  if (dlRunning) return;
  const text = $('shareInput').value;
  if (!text.trim()) { dlStatus('请先粘贴分享链接'); return; }
  const p = detectPlatform(text);
  if (!p) { dlStatus('未识别到 B 站或抖音链接,请检查内容'); return; }
  dlPlatform = p;
  $('videoPanel').classList.add('hidden');
  $('biliOptions').classList.add('hidden');
  biliVideo = null; biliPlay = null; dyVideo = null;
  $('downloadBtn').disabled = true;
  try {
    if (p === 'bilibili') await parseBili(text);
    else await parseDouyin(text);
  } catch (e) {
    dlStatus('出错:' + ((e && e.message) || e));
  }
}

async function parseBili(text) {
  dlStatus('解析中…');
  const r = await window.bili.resolveVideo(text);
  if (!r || !r.ok) { dlStatus('解析失败:' + ((r && r.message) || '无响应')); return; }
  biliVideo = r;
  $('vTitle').textContent = r.title;
  $('vMeta').textContent = 'UP:' + r.owner + ' · 时长 ' + fmtDur(r.duration) + ' · ' + r.bvid;
  const ps = r.pages || [];
  if (ps.length > 1) {
    $('pageWrap').classList.remove('hidden');
    $('pageSel').innerHTML = ps.map((p2, i) => '<option value="' + i + '">P' + p2.page + ' ' + esc(p2.part) + '</option>').join('');
  } else {
    $('pageWrap').classList.add('hidden');
    $('pageSel').innerHTML = '';
  }
  $('biliOptions').classList.remove('hidden');
  $('videoPanel').classList.remove('hidden');
  await loadBiliPlayurl();
}

function currentBiliPart() {
  const pages = (biliVideo && biliVideo.pages) || [];
  if (!pages.length) return null;
  const idx = Number($('pageSel').value) || 0;
  return pages[idx] || pages[0];
}

async function loadBiliPlayurl() {
  if (!biliVideo) return;
  const part = currentBiliPart();
  if (!part) return;
  $('qualitySel').innerHTML = '<option>加载清晰度中…</option>';
  $('downloadBtn').disabled = true;
  biliPlay = null;
  const pu = await window.bili.getPlayurl(biliVideo.bvid, part.cid);
  if (!pu || !pu.ok) {
    $('qualitySel').innerHTML = '';
    dlStatus('获取清晰度失败:' + ((pu && pu.message) || '无响应'));
    return;
  }
  const vids = [...pu.videos].sort((a, b) => b.id - a.id);
  biliPlay = Object.assign({}, pu, { videos: vids });
  $('qualitySel').innerHTML = vids
    .map((v, i) => {
      const cn = codecName(v.codecs);
      return '<option value="' + i + '">' + esc(v.name) + (cn ? ' · ' + esc(cn) : '') + ' · 约 ' + v.sizeMB + ' MB</option>';
    })
    .join('');
  dlStatus('');
  $('downloadBtn').disabled = false;
}

async function parseDouyin(text) {
  dlStatus('解析链接…');
  const rr = await window.bili.resolveDyVideo(text);
  if (!rr || !rr.ok) { dlStatus('解析失败:' + ((rr && rr.message) || '无响应')); return; }
  dlStatus('已识别视频 ' + rr.id + ',正在打开视频页捕获直链…(最长 180 秒;如弹登录请扫码,如未自动播放请点击播放)');
  const cap = await window.bili.fetchDyVideo(rr.id);
  if (!cap || !cap.ok) { dlStatus('获取直链失败:' + ((cap && cap.message) || '超时')); return; }
  dyVideo = { videoUrls: cap.videoUrls, audioUrls: cap.audioUrls, title: cap.title };
  $('vTitle').textContent = cap.title;
  $('vMeta').textContent = '抖音 · ID ' + rr.id;
  $('videoPanel').classList.remove('hidden');
  dlStatus('');
  $('downloadBtn').disabled = false;
}

/* ---------- 下载 ---------- */
async function startDownload() {
  if (dlRunning) return;
  if (dlPlatform === 'bilibili') return startBiliDownload();
  if (dlPlatform === 'douyin') return startDouyinDownload();
}

async function startBiliDownload() {
  const vids = biliPlay.videos;
  const v = vids[Number($('qualitySel').value) || 0] || vids[0];
  const audios = biliPlay.audios || [];
  if (!v || !v.urls || !v.urls.length) { dlStatus('该清晰度没有可用的下载地址'); return; }
  let best = null;
  for (const a of audios) if (!best || a.bandwidth > best.bandwidth) best = a;
  if (!best || !best.urls || !best.urls.length) { dlStatus('未找到可用的音频流,无法合并'); return; }
  const part = currentBiliPart();
  let base = sanitizeName(biliVideo.title);
  if (biliVideo.pages.length > 1 && part) base += ' P' + part.page + ' ' + sanitizeName(part.part);
  let savePath = await window.bili.pickSave(base + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  const videoTmp = savePath + '.v.part';
  const audioTmp = savePath + '.a.part';
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('下载视频流…');
  try {
    const r = await window.bili.downloadStreams({ key: 'cur', videoUrls: v.urls, audioUrls: best.urls, videoTmp, audioTmp });
    if (!r.ok) throw new Error(r.message);
    setDlBar(100);
    dlStatus('下载完成,正在用 ffmpeg 合并…');
    const m = await window.bili.mux({ videoTmp, audioTmp, outPath: savePath });
    if (!m.ok) throw new Error(m.message);
    dlStatus('✅ 已保存:' + savePath);
  } catch (e) {
    dlStatus('❌ 下载失败:' + ((e && e.message) || e));
  } finally {
    await window.bili.cleanup([videoTmp, audioTmp]);
    dlRunning = false;
    $('downloadBtn').disabled = false;
    $('parseBtn').disabled = false;
  }
}

async function startDouyinDownload() {
  const v = dyVideo;
  let savePath = await window.bili.pickSave(sanitizeName(v.title) + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('下载中…');
  try {
    const r = await window.bili.downloadDyVideo({ key: 'dyv', videoUrls: v.videoUrls, audioUrls: v.audioUrls, dest: savePath, title: v.title });
    if (!r.ok) throw new Error(r.message);
    setDlBar(100);
    dlStatus('✅ 已保存:' + (r.dest || savePath));
  } catch (e) {
    dlStatus('❌ 下载失败:' + ((e && e.message) || e));
  } finally {
    dlRunning = false;
    $('downloadBtn').disabled = false;
    $('parseBtn').disabled = false;
  }
}

/* ---------- 绑定 ---------- */
$('openUnfollowBtn').addEventListener('click', () => window.bili.openUnfollow());
$('loginChipBtn').addEventListener('click', () => window.bili.startLogin());
$('shareInput').addEventListener('input', updatePlatformBadge);
$('parseBtn').addEventListener('click', parseShare);
$('pageSel').addEventListener('change', loadBiliPlayurl);
$('downloadBtn').addEventListener('click', startDownload);
window.bili.onDlProgress(({ key, received, total }) => {
  const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
  if (['cur:v', 'cur:a', 'dyv', 'dya', 'wxv'].includes(key)) setDlBar(pct);
});
window.bili.onLoginSuccess((info) => setAccount(info));

/* ---------- 初始化 ---------- */
(async () => {
  const info = await window.bili.checkLogin();
  setAccount(info);
  try {
    const ff = await window.bili.ffmpegCheck();
    if (!ff.ok) dlStatus('⚠️ 未找到 ffmpeg,B 站视频合并将失败');
  } catch (e) {
    /* ignore */
  }
})();

/* ---------- 微信视频号(捕获 feed + 下载解密) ---------- */
let wxFeeds = [];
let wxFeedBusy = {};
let wxFeedMsg = {};

function wxStatusText(t) { $('wxStatus').textContent = t; }

function wxLogLine(line) {
  const box = $('wxLog');
  const div = document.createElement('div');
  div.textContent = String(line);
  box.appendChild(div);
  while (box.childElementCount > 80) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function renderWxFeeds() {
  const wrap = $('wxList');
  if (!wxFeeds.length) {
    wrap.innerHTML = '<div class="muted">尚未捕获到视频。启动捕获 → 重启微信 → 打开/切换视频号视频,这里会自动列出。</div>';
    return;
  }
  wrap.innerHTML = wxFeeds.map((f) => {
    const busy = !!wxFeedBusy[f.id];
    const st = wxFeedMsg[f.id] || '';
    return '<div class="cap-item">' +
      '<div class="cap-main">' +
        '<span class="cap-url" style="max-width:300px;font-weight:600;color:#33415e" title="' + esc(f.title || '') + '">' + esc(f.title || '(无标题)') + '</span>' +
        '<span class="cap-time">' + esc(f.nickname || '') + '</span>' +
        '<span class="cap-size">' + fmtSize(f.size) + (f.duration ? ' · ' + fmtDur(f.duration) : '') + '</span>' +
      '</div>' +
      '<div class="cap-ops">' +
        (st ? '<span class="cap-time">' + esc(st) + '</span>' : '') +
        '<button class="btn small primary" data-wxv-dl="' + esc(f.id) + '"' + (busy ? ' disabled' : '') + '>下载</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function refreshWxStatus() {
  try {
    const s = await window.bili.wxvStatus();
    wxFeeds = (s && s.feeds) || [];
    $('wxStartBtn').classList.toggle('hidden', !!(s && s.running));
    $('wxStopBtn').classList.toggle('hidden', !(s && s.running));
    renderWxFeeds();
  } catch (e) { /* ignore */ }
}

async function wxFeedDownload(id) {
  const f = wxFeeds.find((x) => x.id === id);
  if (!f || wxFeedBusy[id]) return;
  let savePath = await window.bili.pickSave('视频号_' + sanitizeName((f.title || 'video').slice(0, 40)) + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  wxFeedBusy[id] = true;
  wxFeedMsg[id] = '下载中 0%';
  renderWxFeeds();
  try {
    const r = await window.bili.downloadWxvFeed(f, savePath);
    if (r && r.ok) {
      wxFeedMsg[id] = '✅ 已保存';
      wxStatusText('✅ 已保存(已解密):' + savePath);
    } else {
      wxFeedMsg[id] = '❌ 失败';
      wxStatusText('❌ 下载失败:' + ((r && r.message) || '未知错误'));
    }
  } catch (e) {
    wxFeedMsg[id] = '❌ 失败';
    wxStatusText('❌ 下载失败:' + ((e && e.message) || e));
  } finally {
    delete wxFeedBusy[id];
    renderWxFeeds();
  }
}

$('wxStartBtn').addEventListener('click', async () => {
  $('wxStartBtn').disabled = true;
  try {
    wxStatusText('启动捕获代理…');
    const r = await window.bili.wxvStart();
    if (!r || !r.ok) throw new Error((r && r.message) || '启动失败');
    const cert = await window.bili.wxvInstallCert();
    wxStatusText('✅ 捕获已启动(127.0.0.1:' + r.port + ')' + (cert && cert.ok ? ',证书已就绪' : ',证书未安装(可点「安装证书」重试)') + '。请完全退出微信并重新打开,然后打开视频号视频。');
  } catch (e) {
    wxStatusText('❌ 启动失败:' + ((e && e.message) || e));
  } finally {
    $('wxStartBtn').disabled = false;
    refreshWxStatus();
  }
});

$('wxStopBtn').addEventListener('click', async () => {
  try {
    const r = await window.bili.wxvStop();
    wxStatusText(r && r.ok ? '已停止捕获,系统代理已还原。微信需重新打开才能恢复正常直连。' : '停止失败:' + ((r && r.message) || ''));
  } catch (e) {
    wxStatusText('停止失败:' + ((e && e.message) || e));
  }
  refreshWxStatus();
});

$('wxCertBtn').addEventListener('click', async () => {
  const r = await window.bili.wxvInstallCert();
  wxStatusText(r && r.ok ? '✅ 证书已就绪(当前用户 · 受信任的根证书颁发机构)' : '❌ 安装失败:' + ((r && r.message) || '请先启动捕获'));
});

$('wxList').addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.getAttribute) return;
  const dl = t.getAttribute('data-wxv-dl');
  if (dl) wxFeedDownload(dl);
});

window.bili.onWxvFeed((item) => {
  if (!item || !item.id) return;
  const idx = wxFeeds.findIndex((x) => x.id === item.id);
  if (idx >= 0) wxFeeds[idx] = item;
  else wxFeeds.unshift(item);
  if (wxFeeds.length > 100) wxFeeds.pop();
  renderWxFeeds();
});
window.bili.onWxvLog((line) => wxLogLine(line));
window.bili.onWxvStatus(() => refreshWxStatus());
window.bili.onDlProgress(({ key, received, total }) => {
  if (key !== 'wxv') return;
  const id = Object.keys(wxFeedBusy).find((k) => wxFeedBusy[k]);
  if (!id) return;
  const pct = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
  const msg = '下载中 ' + pct + '%';
  if (wxFeedMsg[id] !== msg) { wxFeedMsg[id] = msg; renderWxFeeds(); }
});
refreshWxStatus();
