/**
 * 汇总面板。
 *
 * 渲染原则：
 *  - 数据只来自后台缓存（state.cache），UI 不做任何网络请求；
 *  - 所有跳转都指向网络学堂里的真实详情页，点击卡片即打开；
 *  - 作业按截止时间升序，用四档颜色 + 倒计时把“还有多久”摆在最显眼的位置。
 */

import { MSG, EVENT, TARGET, SITE, SITE_YUKETANG, URGENCY, HOUR } from '../common/constants.js';
import {
  formatDateTime, formatDate, humanizeRemaining, formatBytes,
  relativeDay, truncate, squash,
} from '../common/utils.js';

const ALL = '__all__';

const state = {
  settings: null,
  cache: null,
  session: {},
  progress: null,
  activeCourse: ALL,
  activeTab: 'homework',
  filter: 'all',
  query: '',
  loading: true,
  loadError: '',
  manualLoginTimer: null,
  lastLoginInfo: null,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  statusChip: $('#status-chip'),
  refresh: $('#btn-refresh'),
  settings: $('#btn-settings'),
  search: $('#search'),
  progressBar: $('#progress-bar'),
  progressFill: $('.progress-fill'),
  progressText: $('.progress-text'),
  banner: $('#banner'),
  bannerText: $('#banner-text'),
  bannerActions: $('#banner-actions'),
  courseList: $('#course-list'),
  courseCount: $('#course-count'),
  lastUpdated: $('#last-updated'),
  hero: $('#course-hero'),
  tabs: $('#tabs'),
  tools: $('#tabs-tools'),
  panel: $('#panel'),
  drawer: $('#drawer'),
  loginModal: $('#login-modal'),
  loginUser: $('#login-user'),
  loginPass: $('#login-pass'),
  loginRemember: $('#login-remember'),
  loginError: $('#login-error'),
  loginDiag: $('#login-diag'),
  loginHint: $('#login-hint'),
  toast: $('#toast'),
};

/* ------------------------------- 小工具 -------------------------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function send(type, payload) {
  return chrome.runtime.sendMessage({ target: TARGET.SW, type, payload });
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2400);
}

/* 作业说明的悬停浮层：原生 title 有延迟、长度也受限，所以自己做一个 */
let descPop = null;
function showDescPopup(anchor) {
  const full = anchor.getAttribute('data-full') || '';
  if (!full) { hideDescPopup(); return; }
  if (!descPop) {
    descPop = document.createElement('div');
    descPop.className = 'desc-pop';
    document.body.appendChild(descPop);
  }
  descPop.textContent = full;
  descPop.style.visibility = 'hidden';
  descPop.style.display = 'block';

  const r = anchor.getBoundingClientRect();
  const w = Math.min(descPop.offsetWidth, window.innerWidth - 16);
  const h = descPop.offsetHeight;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));

  // 优先放在卡片下方；下方放不下就翻到上方；上下都放不下就贴着视口底部（保证一定看得见）
  let top;
  if (r.bottom + 8 + h <= window.innerHeight - 8) top = r.bottom + 8;
  else if (r.top - 8 - h >= 8) top = r.top - 8 - h;
  else top = Math.max(8, window.innerHeight - h - 12);

  descPop.style.maxWidth = `${w}px`;
  descPop.style.left = `${left}px`;
  descPop.style.top = `${top}px`;
  descPop.style.visibility = 'visible';
}

function hideDescPopup() {
  if (descPop) descPop.style.display = 'none';
}

function openUrl(url) {
  if (!url) return;
  send(MSG.OPEN_URL, { url });
}

/* ------------------------------- 数据访问 ------------------------------ */

function courses() {
  return (state.cache && state.cache.courses) || [];
}

function activeCourse() {
  if (state.activeCourse === ALL) return null;
  return courses().find((c) => c.id === state.activeCourse) || null;
}

function showCompleted() {
  return !!(state.settings && state.settings.showCompletedHomework);
}

function homeworkOf(course) {
  const list = (course.homework || []).filter((hw) => showCompleted() || !hw.completed);
  return list;
}

function matchesQuery(item, course) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return `${item.title} ${item.text || ''} ${course ? course.name : ''}`.toLowerCase().includes(q);
}

function filterHomeworkList(list) {
  const now = Date.now();
  const kept = list.filter(({ item }) => {
    if (state.filter === 'all') return true;
    if (state.filter === 'none') return !item.deadline;
    if (!item.deadline) return false;
    const diff = item.deadline - now;
    if (state.filter === 'overdue') return diff < 0;
    if (state.filter === 'day') return diff >= 0 && diff < 24 * HOUR;
    if (state.filter === '3days') return diff >= 0 && diff < 72 * HOUR;
    if (state.filter === 'week') return diff >= 0 && diff < 7 * 24 * HOUR;
    return true;
  });
  return kept.sort((a, b) => {
    const ad = a.item.deadline || 0;
    const bd = b.item.deadline || 0;
    if (ad && bd) return ad - bd;
    if (ad) return -1;
    if (bd) return 1;
    return (b.item.date || 0) - (a.item.date || 0);
  });
}

/** 把当前选中范围摊平成 [{item, course}] */
function collect(kind) {
  const list = [];
  const scope = state.activeCourse === ALL ? courses() : [activeCourse()].filter(Boolean);
  for (const course of scope) {
    const items = kind === 'homework' ? homeworkOf(course)
      : kind === 'notice' ? (course.announcements || [])
        : (course.files || []);
    for (const item of items) {
      if (!matchesQuery(item, course)) continue;
      list.push({ item, course });
    }
  }
  if (kind === 'homework') return filterHomeworkList(list);
  return list.sort((a, b) => (b.item.date || 0) - (a.item.date || 0));
}

/* -------------------------------- 渲染 --------------------------------- */

function renderStatus() {
  const chip = el.statusChip;
  const latest = state.cache && state.cache.fetchedAt;
  const logged = state.session && state.session.loggedIn;
  chip.className = 'chip';
  if (state.progress && state.progress.running) {
    chip.classList.add('chip-warn');
    chip.textContent = '抓取中…';
  } else if (!logged) {
    chip.classList.add('chip-bad');
    chip.textContent = '未登录';
  } else if (!latest) {
    chip.classList.add('chip-idle');
    chip.textContent = '待抓取';
  } else {
    chip.classList.add('chip-ok');
    chip.textContent = '已连接';
  }
  el.refresh.disabled = !!(state.progress && state.progress.running);
}

function renderProgress() {
  const p = state.progress;
  if (!p || !p.running) {
    el.progressBar.classList.add('hidden');
    return;
  }
  el.progressBar.classList.remove('hidden');
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 12;
  el.progressFill.style.width = `${Math.max(4, pct)}%`;
  el.progressText.textContent = p.message || '抓取中…';
}

function renderBanner() {
  const session = state.session || {};
  const cache = state.cache || {};
  const errors = cache.errors || [];
  const courseErrors = (cache.courses || []).filter((c) => c.errors && c.errors.length);

  const show = (kind, text, actions) => {
    el.banner.className = `banner banner-${kind}`;
    el.bannerText.textContent = text;
    el.bannerActions.innerHTML = '';
    for (const a of actions || []) {
      const b = document.createElement('button');
      b.className = a.primary ? 'btn btn-primary' : 'btn';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      el.bannerActions.appendChild(b);
    }
  };

  if (state.loadError) {
    show('error', state.loadError, [
      { label: '重试', primary: true, onClick: () => loadState() },
    ]);
    return;
  }
  // 只有真的确定不了学期时才提示去手动填 —— 一般的“按日期推断”已经在后台被课程数据验证过了
  const methods = (cache.stats && cache.stats.methods) || {};
  if (methods.needSemesterInput) {
    show('warn', `无法自动确定学期（当前用的是 ${methods.semester || '未知'}）。如果课程清单不对，请在设置里手动指定学期。`, [
      { label: '去设置', primary: true, onClick: () => el.drawer.classList.remove('hidden') },
      { label: '重试', onClick: () => refresh(true) },
    ]);
    return;
  }  if (!session.loggedIn) {
    show('info', session.lastError
      ? `需要登录网络学堂：${session.lastError}`
      : '尚未登录网络学堂。填写账号密码后扩展会打开登录页并自动填充，你只需完成验证码/二次认证。', [
      { label: '登录', primary: true, onClick: openLoginModal },
      { label: '打开网络学堂', onClick: () => openUrl(SITE.COURSE_LIST_URL) },
    ]);
    return;
  }
  if (!cache.fetchedAt) {
    show('info', '还没有数据，点击“刷新”开始抓取。', [
      { label: '立即抓取', primary: true, onClick: () => refresh(true) },
    ]);
    return;
  }
  if (errors.length || courseErrors.length) {
    const msg = errors.length
      ? errors[0].message
      : `${courseErrors.length} 门课程有部分板块抓取失败`;
    show('warn', `部分内容可能不完整：${truncate(msg, 120)}`, [
      { label: '重试', primary: true, onClick: () => refresh(true) },
      { label: '导出诊断', onClick: exportDiagnostics },
    ]);
    return;
  }
  el.banner.classList.add('hidden');
}

function renderSidebar() {
  const list = courses();
  el.courseCount.textContent = String(list.length);

  const parts = [];
  const totalPending = list.reduce((s, c) => s + homeworkOf(c).length, 0);
  const totalNotices = list.reduce((s, c) => s + (c.announcements || []).length, 0);
  const totalFiles = list.reduce((s, c) => s + (c.files || []).length, 0);

  parts.push(`<button class="course-item ${state.activeCourse === ALL ? 'is-active' : ''}" data-course="${ALL}">
      <span class="name">全部课程<span class="sub">作业 ${totalPending} · 公告 ${totalNotices} · 文件 ${totalFiles}</span></span>
      ${pill(totalPending, 'danger')}
    </button>`);

  for (const c of list) {
    const pending = homeworkOf(c).length;
    const notices = (c.announcements || []).length;
    const files = (c.files || []).length;
    if (state.settings && state.settings.hideEmptyCourses && !pending && !notices && !files) continue;
    const sub = [c.teacher, c.term].filter(Boolean).join(' · ') || `公告 ${notices} · 文件 ${files}`;
    parts.push(`<button class="course-item ${state.activeCourse === c.id ? 'is-active' : ''}" data-course="${esc(c.id)}" title="${esc(c.name)}">
        <span class="name">${esc(truncate(c.name, 22))}<span class="sub">${esc(truncate(sub, 30))}</span></span>
        ${pill(pending, pending ? 'danger' : 'zero')}
      </button>`);
  }

  if (!list.length) {
    parts.push('<div class="empty"><div class="big">📚</div><div>还没有课程数据</div></div>');
  }

  el.courseList.innerHTML = parts.join('');
  el.courseList.querySelectorAll('.course-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeCourse = btn.getAttribute('data-course');
      render();
    });
  });

  const cache = state.cache || {};
  // 底部顺便报出「说明拿到了几条 / 共几条作业」——
  // 这样"面板没显示说明"到底是数据没抓到还是没渲染出来，一眼就能分清，不用来回问。
  const allHw = courses().flatMap((c) => c.homework || []).filter((h) => !h.completed);
  const withDesc = allHw.filter((h) => h.description).length;
  const descStat = allHw.length ? ` · 说明 ${withDesc}/${allHw.length}` : '';
  el.lastUpdated.textContent = cache.fetchedAt
    ? `上次更新 ${formatDateTime(cache.fetchedAt)}（${(cache.durationMs / 1000).toFixed(1)}s）${descStat}`
    : '尚未抓取';
}

function pill(n, kind) {
  const cls = n === 0 ? 'pill pill-zero' : kind === 'danger' ? 'pill pill-danger' : 'pill pill-warn';
  return `<span class="${cls}">${n}</span>`;
}

function renderHero() {
  const course = activeCourse();
  const cache = state.cache || {};
  const stats = cache.stats || {};

  if (!course) {
    const pending = courses().reduce((s, c) => s + homeworkOf(c).length, 0);
    const soon = courses().reduce((s, c) => s + homeworkOf(c).filter((h) => h.urgency && h.urgency !== URGENCY.FAR).length, 0);
    el.hero.innerHTML = `
      <div class="hero-title"><h1>全部课程总览</h1>
        ${cache.fetchedAt ? `<span class="tag-kind">${courses().length} 门课程</span>` : ''}
      </div>
      <div class="hero-meta">
        <span>公告 ${stats.notices || 0}</span>
        <span>文件 ${stats.files || 0}</span>
        <span>作业 ${stats.homework || 0}</span>
        ${cache.fetchedAt ? `<span>抓取于 ${formatDateTime(cache.fetchedAt)}</span>` : ''}
      </div>
      <div class="hero-stats">
        <div class="stat ${pending ? 'stat-danger' : 'stat-ok'}"><b>${pending}</b><span>待交作业</span></div>
        <div class="stat"><b>${soon}</b><span>7 天内截止</span></div>
        <div class="stat"><b>${stats.notices || 0}</b><span>公告</span></div>
        <div class="stat"><b>${stats.files || 0}</b><span>文件</span></div>
      </div>
      <div class="hero-actions">
        <button class="btn" data-act="open-learn">打开网络学堂课程列表</button>
        <button class="btn" data-act="refresh">重新抓取</button>
      </div>`;
  } else {
    const pending = homeworkOf(course).length;
    const meta = [course.teacher, course.term, course.location, course.code].filter(Boolean);
    el.hero.innerHTML = `
      <div class="hero-title">
        <h1>${esc(course.name)}</h1>
        ${pending ? `<span class="tag-kind homework">${pending} 项待交</span>` : '<span class="tag-kind file">无待交作业</span>'}
      </div>
      <div class="hero-meta">${meta.map((m) => `<span class="tag">${esc(m)}</span>`).join('')}
        <span>公告 ${(course.announcements || []).length} · 文件 ${(course.files || []).length} · 作业 ${(course.homework || []).length}</span>
      </div>
      ${course.errors && course.errors.length ? `<div class="hero-meta"><span style="color:var(--warn)">抓取提示：${esc(truncate(course.errors[0].message, 90))}</span></div>` : ''}
      <div class="hero-actions">
        <button class="btn btn-primary" data-act="open-course">打开课程主页</button>
        <button class="btn" data-act="open-notice">课程公告</button>
        <button class="btn" data-act="open-file">课程文件</button>
        <button class="btn" data-act="open-homework">课程作业</button>
        <button class="btn" data-act="refresh-one">重新抓取本课程</button>
      </div>`;

    el.hero.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-act');
        const sections = course.sectionLinks || {};
        if (act === 'open-course') openUrl(course.url);
        else if (act === 'open-notice') openUrl(sections.notice || course.url);
        else if (act === 'open-file') openUrl(sections.file || course.url);
        else if (act === 'open-homework') openUrl(sections.homework || course.url);
        else if (act === 'refresh-one') refresh(true, [course.id]);
      });
    });
    return;
  }

  el.hero.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.getAttribute('data-act');
      if (act === 'open-learn') openUrl(SITE.COURSE_LIST_URL);
      else if (act === 'refresh') refresh(true);
    });
  });
}

function renderTabs() {
  // 标签页上的数字应当是“这一类一共有多少”，所以不受紧急度筛选影响
  const savedFilter = state.filter;
  state.filter = 'all';
  const hw = collect('homework').length;
  const nt = collect('notice').length;
  const fl = collect('file').length;
  state.filter = savedFilter;
  $('#tab-count-homework').textContent = String(hw);
  $('#tab-count-notice').textContent = String(nt);
  $('#tab-count-file').textContent = String(fl);

  el.tabs.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.getAttribute('data-tab') === state.activeTab);
  });

  // 工具区随标签页变化
  if (state.activeTab === 'homework') {
    const filters = [
      ['all', '全部'], ['overdue', '已逾期'], ['day', '24 小时内'],
      ['3days', '3 天内'], ['week', '7 天内'], ['none', '未标注截止'],
    ];
    el.tools.innerHTML = filters
      .map(([k, label]) => `<button class="filter-chip ${state.filter === k ? 'is-active' : ''}" data-filter="${k}">${label}</button>`)
      .join('') + `<label class="filter-chip" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="quick-show-completed" ${showCompleted() ? 'checked' : ''} style="accent-color:#660874" />显示已完成
        </label>`;
    el.tools.querySelectorAll('[data-filter]').forEach((b) => {
      b.addEventListener('click', () => { state.filter = b.getAttribute('data-filter'); render(); });
    });
    const cb = el.tools.querySelector('#quick-show-completed');
    if (cb) cb.addEventListener('change', async () => {
      await send(MSG.UPDATE_SETTINGS, { patch: { showCompletedHomework: cb.checked } });
    });
  } else {
    el.tools.innerHTML = '';
  }
}

/**
 * 作业没有说明时显示一行**如实**的占位文字。
 *
 * 为什么要显示而不是留空：留空会让人分不清「这门作业本来就没写说明」和
 * 「扩展没取到」。站点那边确实是空的（`descriptionSource = empty:作业说明`）时，
 * 就明说「该作业未填写说明」；只有真的取失败才说「未取到说明」。
 */
function descPlaceholder(item) {
  const src = String(item.descriptionSource || '');
  if (src.startsWith('empty:')) return '<p class="card-desc card-desc-empty">该作业未填写说明</p>';
  if (src.includes('rejected-container')) return '<p class="card-desc card-desc-empty" title="抓到的内容像是字段之上的容器，已丢弃">未取到说明</p>';
  if (item.detailEnriched === false && item.detailError) {
    return `<p class="card-desc card-desc-empty" title="${esc(item.detailError)}">未取到说明</p>`;
  }
  return '';
}

function homeworkCard(item, course) {
  const urgency = item.urgency || (item.deadline ? URGENCY.FAR : '');
  const right = item.deadline
    ? `<div class="deadline">${formatDateTime(item.deadline)}</div>
       <div class="countdown">${humanizeRemaining(item.deadline - Date.now())}</div>
       <div class="muted">${relativeDay(item.deadline)}</div>`
    : '<div class="muted">未标注截止时间</div>';

  // 雨课堂的完成度来自它自己的 leaf_schedules（题数进度），口径和网络学堂的
  // 「已交/未交」不同，所以分开措辞，并把原始进度一起显示出来，方便一眼核对。
  const isYkt = item.platform === 'yuketang';
  const prog = item.progressText ? ` ${item.progressText}` : '';
  const statusText = isYkt
    ? (item.completed ? `已完成${prog}` : item.status === 'pending' ? `未完成${prog}` : '状态待确认')
    : (item.completed ? '已完成' : item.status === 'pending' ? '未提交' : '状态待确认');
  const statusCls = item.completed ? 'status-done' : item.status === 'pending' ? 'status-pending' : 'status-unknown';

  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  const attachTitle = attachments.length
    ? `作业附件（${attachments.length}）：${attachments.map((a) => a.name).join('、')}`
    : '';

  // 雨课堂作业没有说明字段（已确认），空着会让人以为是没抓到；
  // 这里改放它的章节名 —— 那是我们确实拿到的、也有用的信息。
  const descLine = item.description
    ? `<p class="card-desc" data-full="${esc(item.description)}">${esc(item.description)}</p>`
    : (isYkt && item.chapterName
      ? `<p class="card-desc card-desc-empty" title="雨课堂作业没有「作业说明」这种字段，这里显示它所在的章节">章节：${esc(item.chapterName)}</p>`
      : descPlaceholder(item));

  return `<article class="card ${urgency ? `urgency-${urgency}` : ''}" data-url="${esc(item.url)}"${item.description ? '' : ` title="${esc(item.url || item.title)}"`}>
    <div class="card-main">
      <h3 class="card-title">${esc(item.title)}${
  isYkt
    ? '<span class="tag-platform" title="这条来自雨课堂（另一个平台与账号体系），点开会在雨课堂里打开">雨课堂</span>'
    : ''}${
  attachments.length
    ? `<span class="tag-attach" title="${esc(attachTitle)}">📎 ${attachments.length > 1 ? attachments.length : ''}附件</span>`
    : ''}</h3>
      <div class="card-meta">
        ${state.activeCourse === ALL && course ? `<span class="tag-course">${esc(truncate(course.name, 16))}</span>` : ''}
        <span class="status ${statusCls}">${statusText}</span>
        ${item.date ? `<span>发布于 ${formatDate(item.date)}</span>` : ''}
        ${item.deepScanned ? '<span>已核对详情</span>' : ''}
      </div>
      ${descLine}
    </div>
    <div class="card-right">${right}
      ${item.deadlineInferred ? '<div class="muted" title="行内没有「截止」字样，按最晚的日期推定">推定</div>' : ''}
    </div>
  </article>`;
}

function noticeCard(item, course) {
  // 未读标记用站点给的权威字段（sfyd/ydsj），**不用发布日期猜**。
  // 之前用“3 天内发布的都标 NEW”，结果已读的公告也一直挂着 NEW，读完刷新还在。
  const unread = item.unread === true;
  return `<article class="card" data-url="${esc(item.url)}" title="${esc(item.url || item.title)}">
    <div class="card-main">
      <h3 class="card-title">${esc(item.title)}</h3>
      <div class="card-meta">
        ${state.activeCourse === ALL && course ? `<span class="tag-course">${esc(truncate(course.name, 16))}</span>` : ''}
        <span class="tag-kind notice">公告</span>
        ${item.pinned ? '<span class="tag-new" style="background:#b26a00">置顶</span>' : ''}
        ${item.date ? `<span>${formatDate(item.date)}</span>` : ''}
        ${item.author ? `<span>${esc(item.author)}</span>` : ''}
        ${item.attachment ? `<span title="${esc(item.attachment)}">📎 有附件</span>` : ''}
        ${unread ? '<span class="tag-new">未读</span>' : ''}
      </div>
      ${item.text ? `<p class="card-excerpt">${esc(truncate(item.text, 120))}</p>` : ''}
    </div>
  </article>`;
}

function fileCard(item, course) {
  const kind = item.fileKind || 'file';
  const ext = (item.ext || '').toUpperCase().slice(0, 4) || 'FILE';
  return `<article class="card" data-url="${esc(item.url || item.downloadUrl)}" title="${esc(item.url || item.title)}">
    <div class="file-icon ${esc(kind)}">${esc(ext)}</div>
    <div class="card-main">
      <h3 class="card-title">${esc(item.title)}</h3>
      <div class="card-meta">
        ${state.activeCourse === ALL && course ? `<span class="tag-course">${esc(truncate(course.name, 16))}</span>` : ''}
        <span class="tag-kind file">文件</span>
        ${item.date ? `<span>${formatDate(item.date)}</span>` : ''}
        ${item.size ? `<span>${formatBytes(item.size)}</span>` : ''}
      </div>
      ${item.downloadUrl && item.downloadUrl !== item.url
        ? `<div class="card-actions"><button class="mini-btn" data-download="${esc(item.downloadUrl)}">下载</button></div>` : ''}
    </div>
  </article>`;
}

function emptyBox(text, isError) {
  return `<div class="empty ${isError ? 'empty-error' : ''}"><div class="big">${isError ? '⚠️' : '🎉'}</div><div>${esc(text)}</div></div>`;
}

function renderPanel() {
  if (state.loading) {
    el.panel.innerHTML = `<div class="skeleton">${'<div class="skeleton-row"></div>'.repeat(6)}</div>`;
    return;
  }
  const cache = state.cache || {};
  if (!cache.fetchedAt) {
    el.panel.innerHTML = emptyBox(state.session.loggedIn ? '还没有数据，点击右上角“刷新”开始抓取' : '请先登录网络学堂');
    return;
  }

  const course = activeCourse();
  const kind = state.activeTab;
  let html = '';

  if (kind === 'all') {
    const hw = collect('homework');
    const nt = collect('notice');
    const fl = collect('file');
    if (!hw.length && !nt.length && !fl.length) {
      el.panel.innerHTML = emptyBox('这个范围内没有内容');
      return;
    }
    html += section('待交作业', hw.map(({ item, course: c }) => homeworkCard(item, c)).join(''), hw.length || 1);
    html += section('公告', nt.map(({ item, course: c }) => noticeCard(item, c)).join(''), nt.length);
    html += section('文件', fl.map(({ item, course: c }) => fileCard(item, c)).join(''), fl.length);
  } else if (kind === 'homework') {
    const list = collect('homework');
    html = list.length
      ? `<div class="card-grid">${list.map(({ item, course: c }) => homeworkCard(item, c)).join('')}</div>`
      : emptyBox(state.filter === 'all'
        ? (course ? '这门课没有待交作业' : '所有课程都没有待交作业，休息一下 🎉')
        : '当前筛选条件下没有作业');
  } else if (kind === 'notice') {
    const list = collect('notice');
    html = list.length
      ? `<div class="card-grid">${list.map(({ item, course: c }) => noticeCard(item, c)).join('')}</div>`
      : emptyBox('暂无公告');
  } else {
    const list = collect('file');
    html = list.length
      ? `<div class="card-grid">${list.map(({ item, course: c }) => fileCard(item, c)).join('')}</div>`
      : emptyBox('暂无文件');
  }

  el.panel.innerHTML = html;
}

function section(title, inner, count) {
  if (!count) return '';
  return `<div class="section-block"><div class="section-heading">${esc(title)} · ${count}</div><div class="card-grid">${inner || emptyBox('暂无内容')}</div></div>`;
}

function render() {
  renderStatus();
  renderProgress();
  renderBanner();
  renderSidebar();
  renderHero();
  renderTabs();
  renderPanel();
}

/* ------------------------------- 交互行为 ------------------------------ */

async function refresh(force = true, courseIds = null) {
  el.refresh.disabled = true;
  const res = await send(MSG.REFRESH, { force, courseIds });
  if (res && res.ok) {
    toast('抓取完成');
    await loadState();
  } else if (res && res.cancelled) {
    toast('已取消');
  } else if (res && res.authRequired) {
    toast('需要登录');
    openLoginModal(res.info || {});
  } else {
    toast(`抓取失败：${(res && res.error) || '未知错误'}`);
  }
  el.refresh.disabled = false;
}

async function loadState() {
  try {
    const res = await send(MSG.GET_STATE);
    if (res && res.ok) {
      state.settings = res.state.settings;
      state.cache = res.state.cache;
      state.session = res.state.session;
      state.progress = res.state.progress;
      state.loadError = '';
    } else {
      state.loadError = (res && res.error) || '后台没有返回状态';
    }
  } catch (err) {
    // Service Worker 刚重启时可能短暂连不上，此时也要把界面画出来而不是空白
    state.loadError = `无法连接扩展后台：${err.message}`;
  }
  state.loading = false;
  syncSettingsForm();
  render();
  paintYuketangStatus();
}

/* -------------------------------- 登录 --------------------------------- */

function openLoginModal(info = {}) {
  state.lastLoginInfo = info;
  el.loginModal.classList.remove('hidden');
  const reasons = {
    sso: '网络学堂现在走清华大学统一身份认证（带验证码），扩展无法代替你完成登录。填好账号密码后点下面的按钮，扩展会打开登录页并自动填充，你只需完成验证码/二次认证。',
    'api-blocked': '会话可能还在，但接口没有返回数据。请在浏览器里打开一次网络学堂页面（让扩展读到页面的 _csrf 令牌）后重试。',
    'no-credentials': '请先填写账号密码（用于在登录页自动填充）。',
    captcha: '登录页需要验证码，请手动完成。',
    'need-permission': `自动填充需要 ${info.crossOrigin || 'id.tsinghua.edu.cn'} 的访问权限，请点击下方按钮授权。`,
  };
  el.loginHint.textContent = reasons[info.reason] || reasons.sso;

  // 把“登录页侦察”的结果如实展示出来，而不是给一句含糊的提示
  const recon = info.loginForm || (state.session && state.session.loginForm);
  const facts = [];
  if (recon) {
    if (recon.hasCaptcha) facts.push('登录页带验证码');
    else if (recon.hasPasswordField) facts.push('登录页有账号密码表单');
    if (recon.crossOrigin) facts.push(`表单提交到 ${recon.crossOrigin}`);
    if (recon.error) facts.push(`未能读取登录页：${recon.error}`);
  }
  el.loginHint.textContent += facts.length ? `（${facts.join('；')}）` : '';

  el.loginError.classList.add('hidden');
  if (info.message) showLoginError(info.message);
  renderLoginActions(info);
}

function renderLoginActions(info) {
  const actions = el.loginModal.querySelector('.modal-actions');
  actions.innerHTML = '';

  const mk = (label, cls, onClick) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    actions.appendChild(b);
  };

  if (info.reason === 'need-permission' && info.crossOrigin) {
    mk('授权该域名并重试', 'btn btn-primary', async () => {
      try {
        const granted = await chrome.permissions.request({ origins: [`${info.crossOrigin}/*`] });
        if (!granted) { showLoginError('未获得授权，改为手动登录'); return; }
      } catch (err) {
        showLoginError(`授权失败：${err.message}`);
        return;
      }
      doLogin();
    });
  } else {
    mk('保存并打开登录页', 'btn btn-primary', doLogin);
  }

  mk('我已在浏览器里登录', 'btn', async () => {
    openUrl(state.session.loginUrl || SITE.COURSE_LIST_URL);
    startManualLoginPolling();
  });
  mk('取消', 'btn btn-ghost', () => el.loginModal.classList.add('hidden'));
}

function showLoginError(msg) {
  el.loginError.textContent = msg;
  el.loginError.classList.remove('hidden');
}

/** 自动填充需要统一身份认证域名的权限（可选权限，必须由点击触发申请） */
async function ensureSsoPermission() {
  try {
    const has = await chrome.permissions.contains(SITE.SSO_PERMISSION);
    if (has) return true;
    return await chrome.permissions.request(SITE.SSO_PERMISSION);
  } catch {
    return false;
  }
}

async function doLogin() {
  const username = el.loginUser.value.trim();
  const password = el.loginPass.value;
  if (!username || !password) { showLoginError('请填写账号与密码（用于在统一身份认证页面自动填充）'); return; }

  const submit = el.loginModal.querySelector('.btn-primary');
  if (submit) { submit.disabled = true; submit.textContent = '处理中…'; }
  el.loginError.classList.add('hidden');

  const granted = await ensureSsoPermission();
  const res = await send(MSG.LOGIN, {
    username,
    password,
    remember: el.loginRemember.checked,
    openTab: true,
    autofill: granted,
    autoRefresh: true,
  });

  if (submit) { submit.disabled = false; submit.textContent = '保存并打开登录页'; }

  if (res && res.ok) {
    el.loginModal.classList.add('hidden');
    el.loginPass.value = '';
    toast('已登录，开始抓取…');
    await loadState();
    stopManualLoginPolling();
    return;
  }

  openLoginModal(res || {});
  if (res && res.needsManualLogin) startManualLoginPolling();
}

function startManualLoginPolling() {
  stopManualLoginPolling();
  let tries = 0;
  state.manualLoginTimer = setInterval(async () => {
    tries++;
    const res = await send(MSG.CHECK_SESSION);
    if (res && res.loggedIn) {
      stopManualLoginPolling();
      el.loginModal.classList.add('hidden');
      toast('已检测到登录，开始抓取…');
      await loadState();
      refresh(true);
    } else if (tries > 150) {
      stopManualLoginPolling();
      showLoginError('等待超时。登录完成后回到本页点「刷新」也可以。');
    } else if (tries % 5 === 0) {
      await loadState();
    }
  }, 2000);
}

function stopManualLoginPolling() {
  if (state.manualLoginTimer) {
    clearInterval(state.manualLoginTimer);
    state.manualLoginTimer = null;
  }
}

/** 登录诊断：把后台判定会话的每一步证据摊在弹窗里，回答“凭什么说我没登录” */
async function runLoginDiagnostics() {
  const box = el.loginDiag;
  box.classList.remove('hidden');
  box.textContent = '正在检查…';
  const res = await send(MSG.DIAGNOSE_SESSION);
  if (!res || !res.ok) {
    box.textContent = `诊断失败：${(res && res.error) || '后台没有响应'}`;
    return;
  }
  const r = res.report;
  const lines = [];
  lines.push(`结论：${r.loggedIn ? '已登录' : '未登录'}（依据：${r.decision.via}）`);
  lines.push(`说明：${r.decision.detail}`);
  lines.push('');
  for (const s of r.steps) lines.push(`${s.ok ? '✓' : '✗'} ${s.name}\n    ${s.detail}`);
  box.textContent = lines.join('\n');

  // 诊断完顺手把会话状态刷新到界面上
  await loadState();
  if (r.loggedIn) {
    el.loginModal.classList.add('hidden');
    refresh(true);
  }
}

/** 全面取证：一次点击，把所有可能需要的信息收集成一个 JSON 并下载 */
async function runForensics() {
  const status = $('#forensics-status');
  const btn = $('#btn-forensics');
  if (btn) btn.disabled = true;
  const started = Date.now();
  const tick = setInterval(() => {
    if (status) status.textContent = `正在取证…已用 ${Math.round((Date.now() - started) / 1000)} 秒（会逐个打开页面，请不要关闭浏览器）`;
  }, 1000);
  if (status) status.textContent = '正在取证…';
  try {
    const res = await send(MSG.RUN_FORENSICS, { courseIndex: 0 });
    if (!res || !res.ok) {
      if (status) status.textContent = `取证失败：${(res && res.error) || '后台没有响应'}`;
      return;
    }
    const blob = new Blob([JSON.stringify(res.report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `thu-learn-forensics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
    const size = (blob.size / 1024 / 1024).toFixed(1);
    if (status) status.textContent = `完成：${res.report.pages.length} 个页面快照、${res.report.endpointProbes.length} 个接口候选，共 ${size} MB（已开始下载）`;
    toast('全面取证完成，文件已开始下载');
  } catch (err) {
    if (status) status.textContent = `取证出错：${err.message}`;
  } finally {
    clearInterval(tick);
    if (btn) btn.disabled = false;
  }
}

/** 雨课堂：只申请权限（不开始记录）。刷新时会用到这个权限。 */
async function grantYuketang() {
  const status = $('#sniff-status');
  const btn = $('#btn-ykt-grant');
  if (btn) btn.disabled = true;
  try {
    // 权限请求必须发生在用户点击手势里，所以只能由界面发起
    const granted = await chrome.permissions.contains(SITE_YUKETANG.permission)
      || await chrome.permissions.request(SITE_YUKETANG.permission);
    if (status) {
      status.textContent = granted
        ? '已授权。下次刷新时会顺带抓雨课堂的作业（雨课堂那边需要你自己登录过）。'
        : `没有获得 ${SITE_YUKETANG.domain} 的访问权限，刷新时会跳过雨课堂。`;
    }
    if (granted) toast('已授权雨课堂');
  } catch (err) {
    if (status) status.textContent = `授权失败：${(err && err.message) || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * 面板上如实显示雨课堂的状态：有没有权限、上次抓到多少、有没有对不上的课。
 * 这里刻意不写"成功"这种模糊话 —— 对不上的课程要能一眼看出来。
 */
async function paintYuketangStatus() {
  const status = $('#sniff-status');
  if (!status) return;
  let granted = false;
  try { granted = await chrome.permissions.contains(SITE_YUKETANG.permission); } catch { /* ignore */ }

  const y = (state.cache && state.cache.stats && state.cache.stats.yuketang) || null;
  const parts = [granted ? '已授权 yuketang.cn' : `未授权 ${SITE_YUKETANG.domain} —— 点「授权雨课堂」后刷新才会带上雨课堂作业`];

  if (y) {
    if (y.needPermission) parts.push('上次刷新跳过了雨课堂');
    else if (!y.ok) parts.push('上次抓取没成功（详见「导出诊断包」里的 errors）');
    else {
      parts.push(`上次：雨课堂 ${y.classrooms} 门课、${y.found} 条作业，并入 ${y.added} 条`
        + `（匹配上 ${y.matched} 门${y.unmatched ? `，对不上 ${y.unmatched} 门` : ''}）`);
      if (y.listVia) parts.push(`课程列表来源：${y.listVia}`);
    }
  }
  status.textContent = parts.join('；');
}

/**
 * 雨课堂自检：把这条长链路的每一环实际观测值直接摆出来。
 * 不这么做的话，「没有雨课堂作业」这一个现象底下可能藏着六七种完全不同的原因，
 * 只能靠来回猜 —— 这个项目已经在"来回猜"上花掉太多轮了。
 */
async function checkYuketang() {
  const out = $('#ykt-check-out');
  const btn = $('#btn-ykt-check');
  if (btn) btn.disabled = true;
  if (out) { out.style.display = 'block'; out.textContent = '正在自检…（会打开一个最小化的后台窗口，约 10 秒）'; }
  try {
    const res = await send(MSG.YKT_SELFCHECK);
    if (!res || !res.ok) {
      if (out) out.textContent = `自检失败：${(res && res.error) || '后台没有响应'}`;
      return;
    }
    const head = `网络学堂已抓到 ${res.courseCount} 门课程，用作匹配基准。\n\n`;
    if (out) out.textContent = head + (res.lines || []).join('\n');
    // 自检完顺手刷新一次设置面板上的状态行
    paintYuketangStatus();
  } catch (err) {
    if (out) out.textContent = `自检出错：${(err && err.message) || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 雨课堂：开始持续记录站点自己的请求（含响应体） */
async function startSniff() {
  const status = $('#sniff-status');
  const btnStart = $('#btn-sniff-start');
  if (btnStart) btnStart.disabled = true;
  try {
    // 权限必须在点击手势里申请，所以这里由界面发起
    const granted = await chrome.permissions.contains(SITE_YUKETANG.permission)
      || await chrome.permissions.request(SITE_YUKETANG.permission);
    if (!granted) {
      if (status) status.textContent = `未获得 ${SITE_YUKETANG.domain} 的访问权限，无法记录。`;
      return;
    }
    const res = await send(MSG.START_SNIFF, { url: SITE_YUKETANG.indexUrl });
    if (!res || !res.ok) {
      if (status) status.textContent = `开始失败：${(res && res.message) || (res && res.error) || '未知原因'}`;
      return;
    }
    if (status) {
      status.textContent = '正在记录…请在雨课堂里点开「课程 → 作业」，最好再打开一份作业详情，然后回来点「结束记录并导出」。';
    }
    toast('已开始记录雨课堂请求');
  } finally {
    if (btnStart) btnStart.disabled = false;
  }
}

async function stopSniff() {
  const status = $('#sniff-status');
  const btnStop = $('#btn-sniff-stop');
  if (btnStop) btnStop.disabled = true;
  if (status) status.textContent = '正在汇总…';
  try {
    const res = await send(MSG.STOP_SNIFF);
    if (!res || !res.ok) {
      if (status) status.textContent = `汇总失败：${(res && res.error) || '未知原因'}`;
      return;
    }
    const r = res.report;
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yuketang-forensics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
    if (status) {
      status.textContent = `完成：记录到 ${r.recordCount} 条请求、${r.endpoints.length} 个不同接口、${r.pages.length} 个页面快照（已开始下载）`;
    }
    toast('雨课堂接口清单已导出');
  } finally {
    if (btnStop) btnStop.disabled = false;
  }
}

/* -------------------------------- 设置 --------------------------------- */

function syncSettingsForm() {
  const s = state.settings;
  if (!s) return;
  $('#set-autoRefresh').value = s.autoRefreshMinutes;
  const semInput = $('#set-semester');
  if (semInput) semInput.value = s.semesterOverride || '';
  const semHint = $('#semester-hint');
  if (semHint) {
    const methods = (state.cache && state.cache.stats && state.cache.stats.methods) || {};
    semHint.textContent = methods.semester
      ? `上次抓取使用的学期：${methods.semester}`
      : '留空时会先问站点的学期接口，再用课程清单反证；都不行才需要你手动填。';
  }
  $('#set-showCompleted').checked = !!s.showCompletedHomework;
  $('#set-deepScan').checked = !!s.deepScanHomework;
  $('#set-hideEmpty').checked = !!s.hideEmptyCourses;
  $('#set-floating').checked = s.floatingButton !== false;
  $('#set-autoLogin').checked = s.autoLogin !== false;
  $('#set-tabFallback').checked = s.tabFallback !== false;
  const enrichBox = $('#set-enrichHomework');
  if (enrichBox) enrichBox.checked = s.enrichHomework !== false;
  const yktBox = $('#set-yuketangHomework');
  if (yktBox) yktBox.checked = s.yuketangHomework !== false;
  const dbgBox = $('#set-debugMode');
  if (dbgBox) dbgBox.checked = s.debugMode === true;
  applyDebugVisibility(s.debugMode === true);
  $('#set-maxItems').value = s.maxItemsPerCourse;
  $('#set-concurrency').value = s.concurrency;
  $('#settings-note').textContent = state.session && state.session.loginMethod === 'auto-form'
    ? '当前通过自动表单登录。'
    : '';
}

/**
 * 调试功能（取证 / 自检 / 诊断导出）默认藏起来。
 *
 * 这些入口只在排查问题时才有用，平时摆在设置里既乱又容易让人误点
 * （「全面取证」会连着打开几十个页面、「开始记录雨课堂」会开一个标签页并持续记录）。
 * 统一用 `debug-only` 这个类来控制，新增调试入口时只要加上这个类即可。
 */
function applyDebugVisibility(on) {
  document.querySelectorAll('.debug-only').forEach((el) => {
    el.classList.toggle('hidden', !on);
  });
}

async function patchSettings(patch) {
  await send(MSG.UPDATE_SETTINGS, { patch });
  await loadState();
  toast('设置已保存');
}

/* -------------------------------- 诊断 --------------------------------- */

async function exportDiagnostics() {
  const res = await send(MSG.EXPORT_DIAGNOSTICS);
  if (!res || !res.ok) { toast('导出失败'); return; }
  const blob = new Blob([JSON.stringify(res.bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `thu-learn-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('诊断包已导出');
}

/* -------------------------------- 绑定 --------------------------------- */

/**
 * 容错的事件绑定：某个元素不存在时只记一条警告，不要抛异常。
 * 否则一个 id 写错就会中断 bind() 剩下的全部绑定，整个面板变成一块死界面——
 * 这种“一处小错炸掉整个 UI”的失败方式最难排查。
 */
function on(selector, event, handler) {
  const node = document.querySelector(selector);
  if (!node) {
    console.warn(`[dashboard] 找不到元素 ${selector}，跳过 ${event} 绑定`);
    return null;
  }
  node.addEventListener(event, handler);
  return node;
}

function bind() {
  el.refresh.addEventListener('click', () => refresh(true));
  el.settings.addEventListener('click', () => el.drawer.classList.remove('hidden'));
  el.drawer.addEventListener('click', (e) => {
    if (e.target.getAttribute && e.target.getAttribute('data-close')) el.drawer.classList.add('hidden');
  });

  let searchTimer = null;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = squash(el.search.value); render(); }, 160);
  });

  el.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest && e.target.closest('.tab');
    if (!tab) return;
    state.activeTab = tab.getAttribute('data-tab');
    render();
  });

  el.panel.addEventListener('click', (e) => {
    const dl = e.target.closest && e.target.closest('[data-download]');
    if (dl) { e.stopPropagation(); openUrl(dl.getAttribute('data-download')); return; }
    const card = e.target.closest && e.target.closest('.card');
    if (card) openUrl(card.getAttribute('data-url'));
  });

  // 作业说明：**整张卡片**悬停都展示全文。
  // 只绑在那两行窄条上太容易错过（用户会去悬停标题或卡片本身），
  // 所以改成从卡片事件里找内部的 .card-desc。
  el.panel.addEventListener('mouseover', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (!card) return;
    const desc = card.querySelector('.card-desc');
    if (desc) showDescPopup(desc);
  });
  el.panel.addEventListener('mouseout', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (!card) return;
    // 移动到别的卡片时才收起
    const to = e.relatedTarget;
    if (to && card.contains(to)) return;
    hideDescPopup();
  });
  el.panel.addEventListener('scroll', hideDescPopup, true);
  window.addEventListener('blur', hideDescPopup);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideDescPopup(); });

  // 设置项
  on('#set-autoRefresh', 'change', (e) => patchSettings({ autoRefreshMinutes: Number(e.target.value) || 0 }));
  on('#set-semester', 'change', (e) => {
    const raw = String(e.target.value || '').trim();
    const m = raw.match(/(\d{4}-\d{4}-[12])/);
    if (raw && !m) {
      toast('学期格式应为 2026-2027-1，已忽略这次输入');
      e.target.value = (state.settings && state.settings.semesterOverride) || '';
      return;
    }
    patchSettings({ semesterOverride: m ? m[1] : '' });
  });
  on('#set-showCompleted', 'change', (e) => patchSettings({ showCompletedHomework: e.target.checked }));
  on('#set-deepScan', 'change', (e) => patchSettings({ deepScanHomework: e.target.checked }));
  on('#set-enrichHomework', 'change', (e) => patchSettings({ enrichHomework: e.target.checked }));
  on('#set-yuketangHomework', 'change', (e) => patchSettings({ yuketangHomework: e.target.checked }));
  // 调试开关即时生效，不必等 loadState 回来才变
  on('#set-debugMode', 'change', (e) => {
    applyDebugVisibility(e.target.checked);
    patchSettings({ debugMode: e.target.checked });
  });
  on('#set-hideEmpty', 'change', (e) => patchSettings({ hideEmptyCourses: e.target.checked }));
  on('#set-floating', 'change', (e) => patchSettings({ floatingButton: e.target.checked }));
  on('#set-autoLogin', 'change', (e) => patchSettings({ autoLogin: e.target.checked }));
  on('#set-tabFallback', 'change', (e) => patchSettings({ tabFallback: e.target.checked }));
  on('#set-maxItems', 'change', (e) => patchSettings({ maxItemsPerCourse: Math.max(10, Number(e.target.value) || 60) }));
  on('#set-concurrency', 'change', (e) => patchSettings({ concurrency: Math.min(8, Math.max(1, Number(e.target.value) || 4)) }));

  on('#btn-forget', 'click', async () => {
    await send(MSG.LOGOUT);
    toast('已清除账号密码与缓存');
    await loadState();
  });
  on('#btn-export', 'click', exportDiagnostics);
  on('#btn-export2', 'click', exportDiagnostics);
  on('#btn-forensics', 'click', runForensics);
  on('#btn-sniff-start', 'click', startSniff);
  on('#btn-sniff-stop', 'click', stopSniff);
  on('#btn-ykt-grant', 'click', grantYuketang);
  on('#btn-ykt-check', 'click', checkYuketang);
  on('#btn-open-learn', 'click', () => openUrl(SITE.COURSE_LIST_URL));

  on('#btn-logout', 'click', async () => {
    await send(MSG.LOGOUT);
    toast('已退出登录');
    await loadState();
    openLoginModal();
  });

  // 登录弹窗
  on('#login-submit', 'click', doLogin);
  on('#login-manual', 'click', () => {
    openUrl(state.session.loginUrl || SITE.COURSE_LIST_URL);
    startManualLoginPolling();
  });
  on('#login-diag-btn', 'click', () => runLoginDiagnostics());
  on('#login-cancel', 'click', () => el.loginModal.classList.add('hidden'));
  el.loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  el.loginUser.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.loginPass.focus(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      el.drawer.classList.add('hidden');
      if (!state.session.loggedIn) el.loginModal.classList.add('hidden');
    }
    if (e.key === 'r' && (e.ctrlKey || e.metaKey) && e.shiftKey) { e.preventDefault(); refresh(true); }
  });

  // 后台广播
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== TARGET.UI) return false;
    if (msg.event === EVENT.PROGRESS) {
      state.progress = msg.payload;
      renderStatus();
      renderProgress();
    } else if (msg.event === EVENT.STATE_CHANGED) {
      loadState();
    }
    return false;
  });
}

/* -------------------------------- 启动 --------------------------------- */

async function init() {
  bind();
  await loadState();
  // 关键：面板每次打开都要**重新确认一次会话**。
  // 只显示上次缓存的状态会出现“用户明明登录了、面板还写着未登录”，
  // 因为 memory.session 里的 false 可能是几分钟前（甚至登录之前）写下的。
  try {
    const res = await send(MSG.CHECK_SESSION);
    if (res && res.ok) {
      state.session = { ...state.session, loggedIn: res.loggedIn, loginMethod: res.via, lastError: res.loggedIn ? '' : (res.detail || ''), evidence: res.evidence };
      render();
    }
  } catch { /* 后台暂时不可用时不阻塞界面 */ }
  if (!state.session.loggedIn) openLoginModal(state.session);
  if (state.cache && state.cache.fetchedAt) render();
  // 还没数据但会话有效时，直接抓一次，省得用户还要手动点刷新
  if (state.session.loggedIn && !(state.cache && state.cache.fetchedAt)) refresh(true);
}

init();
