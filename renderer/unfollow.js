/* 取关窗口:哔哩哔哩批量取关 */
const state = {
  me: null,
  list: [],
  targets: [],
  kept: [],
  total: 0,
  running: false,
  stopFlag: false,
  ok: 0,
  fail: 0,
  failedList: [],
  riskStrikes: 0,
};

function logLine(text) {
  const el = $('log');
  const time = new Date().toTimeString().slice(0, 8);
  el.textContent += `[${time}] ${text}\n`;
  const lines = el.textContent.split('\n');
  if (lines.length > 600) el.textContent = lines.slice(-400).join('\n');
  el.scrollTop = el.scrollHeight;
}

function setAccount(info) {
  state.me = info && info.loggedIn ? { mid: info.mid, uname: info.uname, face: info.face } : null;
  if (state.me) {
    $('account').classList.remove('hidden');
    $('uname').textContent = `${info.uname} (UID ${info.mid})`;
    if (info.face) $('avatar').src = info.face;
    $('loginHint').textContent = '已登录,可以读取关注列表。';
    $('loginBtn').classList.add('hidden');
    $('loadBtn').disabled = false;
  } else {
    $('account').classList.add('hidden');
    $('loginBtn').classList.remove('hidden');
    $('loginHint').textContent =
      info && info.reason
        ? `未登录(${esc(info.reason)})。点击下方按钮,在弹出窗口中扫码或账密登录。`
        : '未登录。点击下方按钮,在弹出窗口中扫码或账密登录。';
    $('loadBtn').disabled = true;
  }
}

function resetList() {
  state.list = [];
  state.targets = [];
  state.kept = [];
  state.total = 0;
  state.failedList = [];
  $('loadStatus').textContent = '';
  $('listSummary').classList.add('hidden');
  $('filterSummary').classList.add('hidden');
  $('preview').classList.add('hidden');
  $('preview').innerHTML = '';
  $('startBtn').disabled = true;
  $('retryBtn').classList.add('hidden');
  $('bar').style.width = '0';
  $('runStatus').textContent = '等待开始…';
}

async function loadList() {
  if (!state.me || state.running) return;
  $('loadBtn').disabled = true;
  state.list = [];
  try {
    for (let pn = 1; ; pn += 1) {
      let r = null;
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        if (attempt > 0) await sleep(2000 * attempt);
        try {
          r = await window.bili.followingsPage(state.me.mid, pn, 50);
          break;
        } catch (e) {
          r = null;
          logLine(`读取第 ${pn} 页网络异常,重试…`);
        }
      }
      if (!r || r.code !== 0) {
        const msg = r ? `code=${r.code} ${r.message}` : '无响应';
        logLine(`读取关注列表失败(第 ${pn} 页):${msg}`);
        if (r && (r.code === -352 || r.code === -412)) alert('请求被 B 站风控拦截,请过几分钟再试');
        return;
      }
      const d = r.data || {};
      const list = (Array.isArray(d) ? d : d.list) || [];
      if (pn === 1) state.total = Array.isArray(d) ? list.length : Number(d.total) || 0;
      if (list.length === 0) break;
      state.list.push(...list);
      $('loadStatus').textContent = `已读取 ${state.list.length}${state.total ? '/' + state.total : ''}`;
      if (state.total ? state.list.length >= state.total : list.length < 50) break;
      await sleep(300);
    }
    logLine(`关注列表读取完成,共 ${state.list.length} 人`);
    applyFilter();
  } finally {
    $('loadBtn').disabled = false;
  }
}

function parseKeep() {
  const words = $('keepKeywords').value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  const mids = ($('keepMids').value.match(/\d+/g) || []).map(Number);
  return { words, mids };
}

function applyFilter() {
  const { words, mids } = parseKeep();
  const isKept = (u) => mids.includes(Number(u.mid)) || words.some((k) => (u.uname || '').includes(k));
  state.kept = state.list.filter(isKept);
  state.targets = state.list.filter((u) => !isKept(u));

  if (state.list.length === 0) {
    $('listSummary').classList.add('hidden');
    $('filterSummary').classList.add('hidden');
    $('preview').classList.add('hidden');
    $('startBtn').disabled = true;
    return;
  }

  $('listSummary').classList.remove('hidden');
  $('listSummary').innerHTML = `共 <b>${state.list.length}</b> 个关注`;

  $('filterSummary').classList.remove('hidden');
  $('filterSummary').innerHTML =
    `将取关 <b style="color:#ff5c7c">${state.targets.length}</b> 个` +
    (state.kept.length ? `,保留 ${state.kept.length} 个(${esc(state.kept.map((u) => u.uname).join('、'))})` : '');

  renderPreview();
  $('startBtn').disabled = state.targets.length === 0 || state.running;
}

function renderPreview() {
  const box = $('preview');
  if (!state.list.length) {
    box.classList.add('hidden');
    return;
  }
  const keptSet = new Set(state.kept.map((u) => u.mid));
  const rows = state.list
    .slice(0, 300)
    .map((u) => {
      const kept = keptSet.has(u.mid);
      return (
        `<div class="pv-row ${kept ? 'kept' : ''}">${kept ? '🔒' : '•'} ${esc(u.uname)}` +
        ` <span class="muted">(${u.mid}${u.special ? ' · ⭐特别关注' : ''})</span>` +
        `${kept ? '<span class="tag">保留</span>' : ''}</div>`
      );
    })
    .join('');
  box.innerHTML = rows + (state.list.length > 300 ? `<div class="muted">…仅显示前 300 个,共 ${state.list.length} 个</div>` : '');
  box.classList.remove('hidden');
}

function openConfirm() {
  const names = state.targets.slice(0, 8).map((u) => u.uname).join('、');
  $('confirmText').innerHTML =
    `即将取关 <b style="color:#ff5c7c">${state.targets.length}</b> 人` +
    (state.kept.length ? `(另有 ${state.kept.length} 人保留)` : '') +
    `<br><span class="muted">${esc(names)}${state.targets.length > 8 ? ' …' : ''}</span>`;
  $('confirmInput').value = '';
  $('confirmOk').disabled = true;
  $('confirmMask').classList.remove('hidden');
  $('confirmInput').focus();
}

function closeConfirm() {
  $('confirmMask').classList.add('hidden');
}

function setBar(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('bar').style.width = pct + '%';
  $('runStatus').textContent = `进度 ${done}/${total} · 成功 ${state.ok} · 失败 ${state.fail}`;
}

async function run(targets) {
  if (state.running || !targets.length) return;
  let delay = Number($('delayMs').value) || 350;
  if (delay < 150) {
    delay = 150;
    logLine('间隔过小,已强制调整为 150ms');
  }

  state.running = true;
  state.stopFlag = false;
  state.ok = 0;
  state.fail = 0;
  state.failedList = [];
  state.riskStrikes = 0;
  $('startBtn').disabled = true;
  $('loadBtn').disabled = true;
  $('retryBtn').classList.add('hidden');
  $('stopBtn').disabled = false;
  setBar(0, targets.length);

  let interrupted = false;

  for (let i = 0; i < targets.length; i += 1) {
    if (state.stopFlag) {
      interrupted = true;
      logLine('已手动停止');
      break;
    }
    const u = targets[i];
    const tag = `[${i + 1}/${targets.length}]`;
    let done = false;
    let lastErr = '';

    for (let attempt = 0; attempt <= 2; attempt += 1) {
      if (attempt > 0) await sleep(2000 * attempt);
      let r = null;
      try {
        r = await window.bili.unfollow(u.mid);
      } catch (e) {
        lastErr = '网络异常:' + ((e && e.message) || e);
        continue;
      }
      if (r && r.code === 0) {
        done = true;
        state.ok += 1;
        state.riskStrikes = 0;
        logLine(`${tag} ✅ 已取关 ${u.uname}`);
        break;
      }
      lastErr = r ? `code=${r.code} ${r.message}` : '空响应';
      if (r && (r.code === -352 || r.code === -412)) {
        state.riskStrikes += 1;
        logLine(`${tag} ⚠️ 触发风控(${r.code}),等待 8 秒后重试…`);
        await sleep(8000);
      } else if (r && (r.code === -101 || r.code === -111)) {
        logLine('登录状态或凭证失效,本次中止。请重新登录后再试。');
        alert('登录状态已失效,请重新登录');
        interrupted = true;
        break;
      }
    }

    if (interrupted) break;

    if (!done) {
      state.fail += 1;
      state.failedList.push(u);
      logLine(`${tag} ❌ 取关失败 ${u.uname}:${lastErr}`);
      if (state.riskStrikes >= 3) {
        interrupted = true;
        logLine('连续触发风控,为保护账号已暂停。稍后可点「重试失败的 N 个」继续。');
        break;
      }
    }

    setBar(i + 1, targets.length);
    await sleep(delay);
  }

  state.running = false;
  finishRun(interrupted);
}

function finishRun(interrupted) {
  $('stopBtn').disabled = true;
  $('loadBtn').disabled = false;
  if (state.failedList.length) {
    $('retryBtn').classList.remove('hidden');
    $('failCount').textContent = state.failedList.length;
  } else {
    $('retryBtn').classList.add('hidden');
  }
  if (interrupted) {
    $('startBtn').disabled = state.targets.length === 0;
    $('runStatus').textContent = `已中断:成功 ${state.ok},失败 ${state.fail}`;
    logLine(`执行中断:成功 ${state.ok},失败 ${state.fail}。建议重新读取列表后再继续。`);
  } else {
    $('startBtn').disabled = true;
    $('runStatus').textContent = `完成:成功 ${state.ok},失败 ${state.fail}`;
    logLine(`执行结束:成功 ${state.ok},失败 ${state.fail}。建议重新读取列表确认结果。`);
  }
}

/* ---------- 绑定 ---------- */
$('loginBtn').addEventListener('click', () => {
  logLine('正在打开登录窗口,请在弹出窗口中完成登录…');
  window.bili.startLogin();
});

$('logoutBtn').addEventListener('click', async () => {
  await window.bili.logout();
  setAccount({ loggedIn: false });
  resetList();
  logLine('已退出登录');
});

$('loadBtn').addEventListener('click', loadList);
$('keepKeywords').addEventListener('input', applyFilter);
$('keepMids').addEventListener('input', applyFilter);

$('startBtn').addEventListener('click', openConfirm);
$('confirmCancel').addEventListener('click', closeConfirm);
$('confirmInput').addEventListener('input', () => {
  $('confirmOk').disabled = $('confirmInput').value.trim() !== String(state.targets.length);
});
$('confirmInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('confirmOk').disabled) $('confirmOk').click();
  if (e.key === 'Escape') closeConfirm();
});
$('confirmOk').addEventListener('click', () => {
  closeConfirm();
  run(state.targets.slice());
});
$('stopBtn').addEventListener('click', () => {
  state.stopFlag = true;
  logLine('正在停止…(当前请求完成后结束)');
});
$('retryBtn').addEventListener('click', () => run(state.failedList.slice()));

/* ---------- 初始化 ---------- */
window.bili.onLoginSuccess((info) => {
  logLine('登录成功:' + info.uname);
  setAccount(info);
});

(async () => {
  const info = await window.bili.checkLogin();
  setAccount(info);
  if (info.loggedIn) logLine('已自动登录:' + info.uname);
})();
