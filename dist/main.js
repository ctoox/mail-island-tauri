/* main.js — Mail Island (Tauri 版)
 * 与 Tauri 后端的接口走 @tauri-apps/api 的 invoke / listen。
 * 与 Electron 版不同的点：
 *   - IPC 走 invoke('set_mode', { mode }) 而非 ipcRenderer.send
 *   - 事件走 listen('mode-changed', cb) 而非 ipcRenderer.on
 *   - 启动期 await window.__TAURI__.core.invoke('ready') 同步 ready 状态
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const $  = (id) => document.getElementById(id);
const island = $('island');

let mode = 'capsule';
let state = { view: 'all', query: '', selected: null, mails: [] };

const STARTER_MAILS = [
  { id: 1, from: 'GitHub', addr: 'noreply@github.com',
    subject: '[mail-island] Your verification code is 482913',
    time: '12:03', unread: true, code: '482913',
    body: 'Hi!<br><br>你的验证码是：<div class="code-block">482913</div>10 分钟内有效。' },
  { id: 2, from: 'Linear', addr: 'team@linear.app',
    subject: 'Weekly digest — 设计系统更新',
    time: '11:40', unread: true,
    body: '本周 Linear 设计系统更新了色彩 token 与暗色表面层级。' },
  { id: 3, from: '腾讯云', addr: 'service@mail.qcloud.com',
    subject: '账单出账通知（2026-10）',
    time: '10:12', unread: true,
    body: '您的账户本月账单已出，费用合计 ¥23.40。' },
  { id: 4, from: 'Vercel', addr: 'no-reply@vercel.com',
    subject: 'Deployment ready — mail-island-tauri',
    time: '昨天', unread: false,
    body: 'Production deployment <b>mail-island-tauri</b> 已就绪。<br>构建耗时 7s · 区域 hkg' },
  { id: 5, from: 'Stripe', addr: 'receipts@stripe.com',
    subject: 'Your receipt from Midjourney',
    time: '昨天', unread: false,
    body: 'Amount: $30.00 — Subscription renewed.' },
  { id: 6, from: 'Apple', addr: 'no_reply@email.apple.com',
    subject: 'Your App Store Connect code: A7K2QX',
    time: '08-20', unread: false, code: 'A7K2QX',
    body: '验证码：<div class="code-block">A7K2QX</div>请勿转发给任何人。' },
];

async function setMode(next) {
  if (next === mode) return;
  mode = next;
  island.dataset.mode = next;
  try {
    // Rust 端枚举在 serde rename_all = "lowercase" 后接收 "capsule"/"expanded"/"docked"
    await invoke('set_mode', { mode: next });
  } catch (e) {
    console.warn('set_mode failed:', e);
  }
}

island.addEventListener('click', (e) => {
  if (mode === 'docked') { setMode('capsule'); return; }
  if (mode === 'capsule' && !e.target.closest('button')) { setMode('expanded'); return; }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mode === 'expanded') setMode('capsule');
});
$('btn-collapse').onclick = () => setMode('capsule');

['click', 'mousedown'].forEach(ev =>
  document.querySelector('.expanded').addEventListener(ev, e => e.stopPropagation()));

window.addEventListener('contextmenu', async () => {
  await invoke('suppress_dock', { flag: true });
  setTimeout(async () => {
    try { await invoke('suppress_dock', { flag: false }); } catch {}
  }, 1500);
});

/* ── 渲染 ──────────────────────────────────────── */
function visible() {
  let ms = state.mails;
  if (state.view === 'unread') ms = ms.filter(m => m.unread);
  if (state.view === 'codes')  ms = ms.filter(m => m.code);
  if (state.query) {
    const q = state.query.toLowerCase();
    ms = ms.filter(m => (m.subject + m.from + m.addr).toLowerCase().includes(q));
  }
  return ms;
}
function renderList() {
  const box = $('mail-list');
  box.innerHTML = '';
  for (const m of visible()) {
    const el = document.createElement('div');
    el.className = 'mail-item'
      + (m.unread ? ' unread' : '')
      + (state.selected === m.id ? ' active' : '');
    el.innerHTML = `
      <div class="r1"><span class="from">${escapeHtml(m.from)}</span>
                      <span class="time">${escapeHtml(m.time)}</span></div>
      <div class="subj">${escapeHtml(m.subject)}</div>
      <div class="snip">${escapeHtml(m.body.replace(/<[^>]+>/g, ' ').slice(0, 80))}</div>
      ${m.code ? `<span class="chip-code">🔑 ${escapeHtml(m.code)}</span>` : ''}`;
    el.onclick = () => { m.unread = false; state.selected = m.id; render(); };
    box.appendChild(el);
  }
  if (!box.children.length) {
    box.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">没有邮件</div>';
  }
}
function renderCounts() {
  const all = state.mails, unread = all.filter(m => m.unread).length;
  $('c-all').textContent    = all.length;
  $('c-unread').textContent = unread || '';
  $('c-codes').textContent  = all.filter(m => m.code).length || '';
  $('island-badge').textContent = unread;
  island.classList.toggle('unread', unread > 0);
}
function renderRead() {
  const m = state.mails.find(x => x.id === state.selected);
  $('read-empty').style.display = m ? 'none' : 'flex';
  $('read-view').hidden = !m;
  if (!m) return;
  $('r-subject').textContent = m.subject;
  $('r-from').textContent    = m.from;
  $('r-addr').textContent    = ` <${m.addr}>`;
  $('r-time').textContent    = m.time;
  $('r-avatar').textContent  = (m.from[0] || '?').toUpperCase();
  $('r-body').innerHTML      = m.body;
  $('btn-copy').hidden       = !m.code;
  $('btn-copy').dataset.code = m.code || '';
}
function render() { renderList(); renderCounts(); renderRead(); }

document.querySelectorAll('.nav-item').forEach(n => n.onclick = () => {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  n.classList.add('active');
  state.view = n.dataset.view;
  renderList();
});
$('search').oninput = (e) => { state.query = e.target.value; renderList(); };
$('btn-copy').onclick = (e) => {
  const code = e.currentTarget.dataset.code;
  if (!code) return;
  navigator.clipboard?.writeText(code);
  e.currentTarget.textContent = '已复制 ✓';
  setTimeout(() => e.currentTarget.textContent = '复制验证码', 1200);
};
$('btn-delete').onclick = () => {
  const id = state.selected;
  if (!id) return;
  state.mails = state.mails.filter(m => m.id !== id);
  state.selected = null;
  render();
};
$('btn-archive').onclick = () => $('btn-delete').click();
$('btn-reply').onclick   = () => alert('回复功能待接入');

let toastTimer;
function toast({ title, code, meta }) {
  $('t-title').textContent = title;
  if (code) {
    $('t-code').hidden = false; $('t-code').textContent = code;
    $('t-copy').hidden = false;
  } else {
    $('t-code').hidden = true; $('t-copy').hidden = true;
  }
  $('t-meta').textContent = meta;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 7000);
}
$('toast').onclick = () => $('toast').classList.remove('show');

$('demo-mail').onclick = () => {
  const m = {
    id: Date.now(), from: 'Figma', addr: 'no-reply@figma.com',
    subject: '文件「Mail Island Tauri」有新评论',
    time: '刚刚', unread: true,
    body: 'Alex 评论了你的文件：这个岛形态的展开动画很顺滑。',
  };
  state.mails.unshift(m);
  render();
  toast({ title: '✉ 新邮件', meta: 'Figma · 文件「Mail Island Tauri」有新评论' });
};
$('demo-code').onclick = () => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const m = {
    id: Date.now(), from: 'QQ邮箱团队', addr: 'service@qq.com',
    subject: `您的验证码是 ${code}`, time: '刚刚',
    unread: true, code,
    body: `验证码：<div class="code-block">${code}</div>5 分钟内有效。`,
  };
  state.mails.unshift(m);
  render();
  toast({ title: '🔑 收到验证码', code, meta: 'QQ邮箱团队 · 登录验证' });
};
$('demo-mode').onclick = () => {
  const next = { capsule: 'expanded', expanded: 'docked', docked: 'capsule' }[mode];
  setMode(next);
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ── 启动 + 监听后端事件 ──────────────────────── */
async function boot() {
  state.mails = STARTER_MAILS;
  render();
  await listen('mode-changed', (e) => {
    mode = e.payload;
    island.dataset.mode = mode;
  });
  // 不在 docked 状态下应用启动就 docked——保留 capsule 给用户点
  await invoke('set_mode', { mode: 'capsule' });
}
boot();