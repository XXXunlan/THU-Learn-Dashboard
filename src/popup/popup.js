/**
 * 弹窗：登录 + 一眼看清“最近要交什么”。
 * 数据同样只从后台缓存读，不在这里发任何请求。
 */

import { MSG, EVENT, TARGET, SITE } from '../common/constants.js';
import { formatDateTime, humanizeRemaining, truncate } from '../common/utils.js';

const $ = (s) => document.querySelector(s);
const send = (type, payload) => chrome.runtime.sendMessage({ target: TARGET.SW, type, payload });

const state = { settings: null, cache: null, session: {}, progress: null };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openUrl(url, active = true) {
  if (url) send(MSG.OPEN_URL, { url, active });
}

function openDashboard() {
  openUrl(chrome.runtime.getURL('src/dashboard/dashboard.html'));
}

async function loadState() {
  const res = await send(MSG.GET_STATE);
  if (!res || !res.ok) return;
  state.settings = res.state.settings;
  state.cache = res.state.cache;
  state.session = res.state.session;
  state.progress = res.state.progress;
  render();
}

function render() {
  const logged = !!state.session.loggedIn;
  const running = !!(state.progress && state.progress.running);

  $('#chip').className = `chip ${running ? 'chip-warn' : logged ? 'chip-ok' : 'chip-bad'}`;
  $('#chip').textContent = running ? '抓取中' : logged ? '已连接' : '未登录';

  $('#progress').classList.toggle('hidden', !running);
  if (running) {
    const pct = state.progress.total ? (state.progress.done / state.progress.total) * 100 : 12;
    $('.progress-fill').style.width = `${Math.max(4, pct)}%`;
  }

  $('#view-main').classList.toggle('hidden', !logged);
  $('#view-login').classList.toggle('hidden', logged);
  $('#link-logout').classList.toggle('hidden', !logged);

  if (!logged) {
    if (state.session.needsManualLogin) {
      $('#login-hint').textContent = state.session.lastError
        || '需要在浏览器里登录一次网络学堂；点“手动登录”打开登录页，登录成功后会自动回来。';
      $('#err').classList.remove('hidden');
      $('#err').textContent = state.session.lastError || '';
      if (state.session.lastError) $('#err').classList.add('hidden');
    }
    if (state.username && !$('#user').value) $('#user').value = state.username;
    return;
  }

  const cache = state.cache || {};
  const courses = cache.courses || [];
  const homework = [];
  for (const c of courses) {
    for (const hw of c.homework || []) {
      if (hw.completed) continue;
      homework.push({ hw, course: c });
    }
  }
  homework.sort((a, b) => (a.hw.deadline || Infinity) - (b.hw.deadline || Infinity));

  const now = Date.now();
  const due24 = homework.filter(({ hw }) => hw.deadline && hw.deadline - now < 24 * 3600 * 1000).length;
  const stats = cache.stats || {};

  setStat('#stat-pending', homework.length, homework.length ? 'danger' : 'ok');
  setStat('#stat-day', due24, due24 ? 'danger' : 'ok');
  setStat('#stat-notice', stats.notices || 0, '');
  setStat('#stat-file', stats.files || 0, '');

  $('#meta').textContent = cache.fetchedAt
    ? `${courses.length} 门课 · ${formatDateTime(cache.fetchedAt)}`
    : '尚未抓取';

  const top = homework.slice(0, 6);
  $('#upcoming').innerHTML = top.length
    ? top.map(({ hw, course }) => {
      const cls = hw.urgency ? `u-${hw.urgency}` : 'u-far';
      const right = hw.deadline
        ? `<span class="cd">${humanizeRemaining(hw.deadline - now)}</span>`
        : '<span class="cd">无截止</span>';
      const when = hw.deadline ? formatDateTime(hw.deadline) : '未标注截止时间';
      return `<div class="item ${cls}" data-url="${esc(hw.url)}">
          <div class="t">${esc(truncate(hw.title, 42))}</div>
          <div class="m"><span class="course">${esc(truncate(course.name, 18))} · ${esc(when)}</span>${right}</div>
        </div>`;
    }).join('')
    : '<div class="empty">没有待交作业 🎉</div>';

  $('#upcoming').querySelectorAll('.item').forEach((node) => {
    node.addEventListener('click', () => openUrl(node.getAttribute('data-url')));
  });
}

function setStat(sel, value, tone) {
  const node = $(sel);
  node.className = `stat ${tone ? `stat-${tone}` : ''}`;
  node.querySelector('b').textContent = String(value);
}

async function doLogin() {
  const username = $('#user').value.trim();
  const password = $('#pass').value;
  if (!username || !password) {
    $('#err').classList.remove('hidden');
    $('#err').textContent = '请填写账号与密码（用于在统一身份认证页自动填充）';
    return;
  }
  $('#btn-login').disabled = true;
  $('#btn-login').textContent = '处理中…';
  $('#err').classList.add('hidden');

  // 自动填充需要统一身份认证域名的可选权限，必须由点击触发申请
  let granted = false;
  try {
    granted = await chrome.permissions.contains(SITE.SSO_PERMISSION)
      || await chrome.permissions.request(SITE.SSO_PERMISSION);
  } catch {
    granted = false;
  }

  const res = await send(MSG.LOGIN, {
    username,
    password,
    remember: $('#remember').checked,
    openTab: true,
    autofill: granted,
    autoRefresh: true,
  });

  $('#btn-login').disabled = false;
  $('#btn-login').textContent = '保存并打开登录页';

  if (res && res.ok) {
    $('#pass').value = '';
    await loadState();
  } else {
    $('#err').classList.remove('hidden');
    $('#err').textContent = (res && (res.message || res.error)) || '未能自动登录（网络学堂需要统一身份认证）';
    if (res && res.needsManualLogin) startPolling();
  }
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  let tries = 0;
  pollTimer = setInterval(async () => {
    tries++;
    const res = await send(MSG.CHECK_SESSION);
    if (res && res.loggedIn) {
      clearInterval(pollTimer);
      pollTimer = null;
      await loadState();
      send(MSG.REFRESH, { force: true });
    } else if (tries > 60) {
      clearInterval(pollTimer);
      pollTimer = null;
      await loadState();
    }
  }, 2000);
}

function bind() {
  $('#btn-dashboard').addEventListener('click', openDashboard);
  $('#btn-refresh').addEventListener('click', async () => {
    $('#btn-refresh').disabled = true;
    $('#btn-refresh').textContent = '抓取中…';
    const res = await send(MSG.REFRESH, { force: true });
    $('#btn-refresh').disabled = false;
    $('#btn-refresh').textContent = '刷新';
    if (res && res.ok) await loadState();
    else if (res && res.authRequired) await loadState();
    else if (res && res.error) {
      $('#err').classList.remove('hidden');
      $('#err').textContent = res.error;
    }
  });

  $('#btn-login').addEventListener('click', doLogin);
  $('#pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  $('#btn-manual').addEventListener('click', async () => {
    openUrl(state.session.loginUrl || SITE.COURSE_LIST_URL);
    startPolling();
  });

  $('#link-open').addEventListener('click', () => openUrl(SITE.COURSE_LIST_URL));
  $('#link-settings').addEventListener('click', openDashboard);
  $('#link-logout').addEventListener('click', async () => {
    await send(MSG.LOGOUT);
    await loadState();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== TARGET.UI) return false;
    if (msg.event === EVENT.PROGRESS) { state.progress = msg.payload; render(); }
    if (msg.event === EVENT.STATE_CHANGED) loadState();
    return false;
  });
}

bind();
// 弹窗每次打开也重新确认会话，避免显示上次缓存的旧状态
(async () => {
  await loadState();
  try {
    const res = await send(MSG.CHECK_SESSION);
    if (res && res.ok) {
      state.session = { ...state.session, loggedIn: res.loggedIn, lastError: res.loggedIn ? '' : (res.detail || '') };
      render();
      if (res.loggedIn && !(state.cache && state.cache.fetchedAt)) send(MSG.REFRESH, { force: true });
    }
  } catch { /* 忽略 */ }
})();
