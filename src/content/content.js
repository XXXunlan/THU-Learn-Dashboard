/**
 * 内容脚本：只在 learn.tsinghua.edu.cn 上跑（普通脚本，不能用 import）。
 *
 * 承担三件事：
 *  1) 页面右下角的悬浮入口 —— 随时打开汇总面板；
 *  2) 回答后台的 `getCsrf`：站点自己的 `_csrf` 令牌藏在页面环境里，
 *     只有内容脚本够得着（localStorage / document.cookie / 站点自己的全局函数）；
 *  3) 回答后台的 `scrape`：把已经渲染好的 DataTables 表格读成结构化条目，
 *     这是接口直连失败时的兜底路径。
 *
 * 抓取本身仍然在 Service Worker 里做，这里只是“借页面一双眼睛”。
 */

(function initContentScript() {
  if (window.__thuLearnDashboardInjected) return;
  window.__thuLearnDashboardInjected = true;

  const UI = 'ui';
  const MSG = {
    GET_STATE: 'getState',
    REFRESH: 'refresh',
    MANUAL_SNAPSHOT: 'manualSnapshot',
    OPEN_URL: 'openUrl',
  };
  const send = (type, payload) => chrome.runtime.sendMessage({ target: 'sw', type, payload });

  /* ------------------------- 1. 取 _csrf ------------------------- */

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function fromCookie() {
    const names = ['XSRF-TOKEN', 'csrf_token', 'CSRF-TOKEN', '_csrf', 'csrfToken'];
    const jar = String(document.cookie || '').split(';');
    for (const raw of jar) {
      const [k, ...rest] = raw.split('=');
      const key = (k || '').trim();
      const val = rest.join('=').trim();
      if (!val) continue;
      if (names.some((n) => n.toLowerCase() === key.toLowerCase())) return { token: decodeURIComponent(val), via: `cookie:${key}` };
    }
    return null;
  }

  function fromLocalStorage() {
    try {
      const keys = ['_csrf', 'csrf_token', 'csrfToken', 'XSRF-TOKEN', 'csrf'];
      for (const k of keys) {
        const v = window.localStorage.getItem(k);
        if (v && v.length >= 8) return { token: v.replace(/^"|"$/g, ''), via: `localStorage:${k}` };
      }
      // 站点用 storejs 存过东西，退一步在所有 key 里找 UUID
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        const v = String(window.localStorage.getItem(k) || '');
        if (/csrf/i.test(k) && UUID_RE.test(v)) return { token: v.match(UUID_RE)[0], via: `localStorage*:${k}` };
      }
    } catch {
      /* 隐私模式下可能抛错 */
    }
    return null;
  }

  function fromSiteHelper() {
    // 站点自己有 handleUrlWithCsrf(url)，直接问它要最快也最准
    try {
      if (typeof window.handleUrlWithCsrf === 'function') {
        const probe = window.handleUrlWithCsrf('/__thu_learn_probe__');
        const m = String(probe).match(/(?:_csrf|csrf_token)=([^&]+)/i) || String(probe).match(UUID_RE);
        if (m) return { token: decodeURIComponent(m[1] || m[0]), via: 'page-helper' };
      }
    } catch {
      /* 忽略 */
    }
    try {
      if (window._csrf && typeof window._csrf === 'string' && window._csrf.length >= 8) return { token: window._csrf, via: 'global:_csrf' };
      const meta = document.querySelector('meta[name="_csrf"], meta[name="csrf-token"], meta[name="csrf_token"]');
      if (meta && meta.getAttribute('content')) return { token: meta.getAttribute('content'), via: 'meta' };
    } catch {
      /* 忽略 */
    }
    return null;
  }

  function getCsrf() {
    for (const fn of [fromSiteHelper, fromCookie, fromLocalStorage]) {
      const hit = fn();
      if (hit && hit.token) return hit;
    }
    return null;
  }

  /* --------------------- 2. 读已渲染的列表 --------------------- */

  // MAIN world 的嗅探器（sniffer.js）会把它看到的 /b/ 请求 postMessage 过来。
  // 这里只做环形缓冲与转发 —— 它记录的是**站点自己的真实请求**，比我们猜参数可靠得多。
  const sniffed = [];
  const SNIFF_MAX = 60;
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !data.__thuLearnSniff) return;
    sniffed.push(data.__thuLearnSniff);
    if (sniffed.length > SNIFF_MAX) sniffed.splice(0, sniffed.length - SNIFF_MAX);
  });

  function getSniffed() {
    // 优先直接读 MAIN world 的缓冲，拿不到就用 postMessage 收到的那份
    try {
      const direct = window.__thuLearnGetSniffed && window.__thuLearnGetSniffed();
      if (Array.isArray(direct) && direct.length) return direct;
    } catch { /* world 隔离时访问会抛错，忽略 */ }
    return sniffed.slice();
  }

  const HEADER_RULES = {
    homework: {
      title: /作业题目|标题|题目|名称/,
      deadline: /截止日期|截止时间|截止倒计时|截止/,
      submit: /提交日期|提交时间/,
      teacher: /批阅教师|教师/,
      grade: /成绩|得分/,
      mode: /完成方式|方式/,
      status: /状态/,
    },
    notice: {
      title: /标题|公告|名称/,
      author: /发布者|发布人|作者/,
      date: /发布时间|时间|日期/,
    },
    file: {
      title: /标题|名称|文件/,
      type: /类型|文件类型/,
      size: /大小|文件大小/,
      date: /上传时间|时间|日期|发布时间/,
    },
  };

  function cellText(td) {
    return String(td.textContent || '').replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function headerIndexMap(table, kind) {
    const rules = HEADER_RULES[kind] || HEADER_RULES.notice;
    const map = {};
    const heads = table.querySelectorAll('thead th, thead td');
    const list = heads.length ? heads : table.querySelectorAll('tr:first-child th');
    list.forEach((th, i) => {
      const label = cellText(th);
      for (const [field, re] of Object.entries(rules)) {
        if (re.test(label) && map[field] === undefined) map[field] = i;
      }
    });
    return map;
  }

  function pickTable(kind) {
    const ids = {
      homework: ['#zyalltable', '#examplesearch'],
      notice: ['#ggalltable', '#examplesearch'],
      file: ['#kjalltable', '#examplesearch'],
    }[kind] || ['#examplesearch'];
    let best = null;
    let bestRows = 0;
    for (const sel of ids) {
      for (const t of document.querySelectorAll(sel)) {
        const rows = t.querySelectorAll('tbody tr');
        const usable = Array.from(rows).filter((r) => !r.querySelector('.dataTables_empty'));
        if (usable.length > bestRows) { best = t; bestRows = usable.length; }
      }
    }
    return best;
  }

  /** 页面上可见文本的总长度 —— 用来判断「页面内容是否已经稳定」 */
  function probeText() {
    const body = document.body || document.documentElement;
    const text = String((body && body.innerText) || (body && body.textContent) || '');
    return { ok: true, textLength: text.replace(/\s+/g, ' ').trim().length, ready: document.readyState === 'complete' };
  }

  function probeRows(kind) {    const ids = {
      homework: ['#zyalltable', '#examplesearch'],
      notice: ['#ggalltable', '#examplesearch'],
      file: ['#kjalltable', '#examplesearch'],
    }[kind] || ['#examplesearch', 'table.dataTable'];
    const EMPTY_STATE = /没有您要搜索的内容|表中数据为空|暂无数据|暂无记录|没有数据|no\s+data\s+available|no\s+matching\s+records/i;
    let rows = 0;
    let ready = false;
    let table = '';
    for (const sel of ids) {
      for (const t of document.querySelectorAll(sel)) {
        const tbody = t.querySelector('tbody');
        if (!tbody) continue;
        const all = Array.from(tbody.querySelectorAll('tr'));
        const real = all.filter((r) => !r.querySelector('.dataTables_empty')
          && !(cellText(r).length < 40 && EMPTY_STATE.test(cellText(r))));
        if (real.length > rows) { rows = real.length; table = t.id || t.className; }
        // tbody 存在且（有行 或 有明确的空表占位）→ DataTables 已经渲染完了
        if (all.length > 0) ready = true;
      }
    }
    // 没有已知容器时，退一步看整页有没有 DataTable
    if (!ready) {
      const any = document.querySelector('table.dataTable tbody');
      if (any && any.querySelectorAll('tr').length) { ready = true; table = table || 'table.dataTable'; }
    }
    return { ok: true, rows, ready, table };
  }

  /**
   * 点开某个板块的标签。
   *
   * 为什么需要它：课程页是**聚合页 + 标签切换**（站点自己的 JS 里有 tabchange(1..6)，
   * 各个板块的容器默认带 hidden 类）。页面加载时通常只初始化默认那一个标签，
   * 其他板块的数据要**点了标签才会去加载** —— 所以直接快照会拿到一堆空表格。
   */
  function activateTab(label) {
    const wanted = String(label || '').trim();
    if (!wanted) return { ok: false, error: '没有指定标签名' };
    const KEY = { 公告: 1, 文件: 2, 课件: 2, 作业: 3, 讨论: 4, 答疑: 5, 笔记: 6 };
    const idx = KEY[wanted];

    // 1) 站点自己的 tabchange(n) 最可靠
    if (idx && typeof window.tabchange === 'function') {
      try {
        window.tabchange(idx);
        return { ok: true, via: `tabchange(${idx})` };
      } catch { /* 继续尝试点击 */ }
    }

    // 2) 找到文字匹配的标签/更多链接并点击
    const candidates = Array.from(document.querySelectorAll('a, li, .tab, .more, [onclick]'));
    const hit = candidates.find((el) => {
      const t = cellText(el);
      if (t !== wanted && !(t.startsWith(wanted) && t.length <= wanted.length + 2)) return false;
      const oc = el.getAttribute('onclick') || '';
      return /tabchange|click|show/i.test(oc) || el.tagName === 'A';
    });
    if (hit) {
      try {
        hit.click();
        const oc = hit.getAttribute('onclick') || '';
        return { ok: true, via: oc ? `click[${oc.slice(0, 40)}]` : 'click' };
      } catch (err) {
        return { ok: false, error: `点击失败：${err.message}` };
      }
    }
    return { ok: false, error: `页面上没有找到「${wanted}」标签` };
  }

  function scrapeRows(kind) {
    const EMPTY_STATE = /没有您要搜索的内容|表中数据为空|暂无数据|暂无记录|没有数据|no\s+data\s+available|no\s+matching\s+records/i;
    const table = pickTable(kind);
    if (!table) return { ok: false, error: `页面上找不到 ${kind} 的列表（可能数据还没加载出来）` };
    const idx = headerIndexMap(table, kind);
    const rows = Array.from(table.querySelectorAll('tbody tr')).filter((r) => {
      if (r.querySelector('.dataTables_empty')) return false;
      const text = cellText(r);
      // DataTables 没有数据时会塞一行“没有您要搜索的内容”，那不是条目
      return !(text.length < 40 && EMPTY_STATE.test(text));
    });
    const items = [];
    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (!tds.length) continue;
      const anchor = Array.from(tr.querySelectorAll('a[href]')).find((a) => {
        const h = a.getAttribute('href') || '';
        return !/^javascript:/i.test(h) && String(a.textContent || '').trim().length >= 2;
      });
      const cells = {};
      for (const [field, i] of Object.entries(idx)) {
        if (tds[i]) cells[field] = cellText(tds[i]);
      }
      // 表头没匹配上时退化为整行文本，让后台的日期解析器去兜
      const wholeRow = cellText(tr);
      items.push({
        title: cells.title || (anchor ? String(anchor.textContent || '').trim() : '') || wholeRow.slice(0, 80),
        url: anchor ? new URL(anchor.getAttribute('href'), location.href).href : '',
        cells,
        rowText: wholeRow.slice(0, 400),
      });
    }
    return {
      ok: true,
      items,
      method: `tab-dom:${table.id || table.className}:${rows.length}`,
      headerMap: idx,
    };
  }

  /* ------------------- 3. 悬浮入口（保持轻量） ------------------- */

  const CSS = `
    .thul-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2430}
    .thul-fab button{border:none;cursor:pointer;font-family:inherit}
    .thul-btn{display:flex;align-items:center;gap:8px;border-radius:999px;padding:10px 16px;background:#660874;color:#fff;box-shadow:0 6px 18px rgba(102,8,116,.35);font-size:13px;font-weight:600}
    .thul-btn:hover{background:#7d1a8c}
    .thul-ghost{background:#fff;color:#660874;box-shadow:0 4px 14px rgba(20,20,40,.18);font-weight:500}
    .thul-ghost:hover{background:#f6f1f7}
    .thul-card{background:#fff;border-radius:14px;box-shadow:0 12px 32px rgba(20,20,40,.22);padding:12px;width:238px;display:none;flex-direction:column;gap:8px}
    .thul-card.thul-open{display:flex}
    .thul-title{font-weight:700;color:#660874;display:flex;justify-content:space-between;align-items:center;font-size:13px}
    .thul-meta{color:#6b7280;font-size:12px}
    .thul-badge{border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;color:#fff;background:#2e7d32}
    .thul-toast{position:fixed;right:20px;bottom:96px;z-index:2147483001;background:#1f2430;color:#fff;padding:8px 14px;border-radius:10px;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;opacity:0;transition:opacity .2s}
    .thul-toast.thul-show{opacity:.96}
  `;

  let root = null;
  let collapsed = true;
  let state = { pending: 0, fetchedAt: 0 };

  function toast(msg) {
    let el = document.querySelector('.thul-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'thul-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('thul-show');
    clearTimeout(el.__t);
    el.__t = setTimeout(() => el.classList.remove('thul-show'), 2200);
  }

  function render() {
    if (!root) return;
    const when = state.fetchedAt
      ? new Date(state.fetchedAt).toLocaleString('zh-CN', { hour12: false })
      : '尚未抓取';
    root.querySelector('.thul-meta').textContent = `上次更新：${when}`;
    const badge = root.querySelector('.thul-badge');
    badge.textContent = state.pending ? `${state.pending} 项待交` : '暂无待交';
    badge.style.background = state.pending ? '#c62828' : '#2e7d32';
    root.querySelector('.thul-fabbtn').textContent = collapsed ? '学堂面板' : '收起';
  }

  function build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.documentElement.appendChild(style);

    root = document.createElement('div');
    root.className = 'thul-fab';
    root.innerHTML = `
      <div class="thul-card">
        <div class="thul-title"><span>清华网络学堂面板</span><span class="thul-badge">—</span></div>
        <div class="thul-meta">尚未抓取</div>
        <button class="thul-btn" data-act="open">打开汇总面板</button>
        <button class="thul-btn thul-ghost" data-act="refresh">重新抓取全部课程</button>
        <button class="thul-btn thul-ghost" data-act="sample">采集当前页样本（排障用）</button>
      </div>
      <button class="thul-btn thul-fabbtn">学堂面板</button>`;

    root.addEventListener('click', async (e) => {
      const target = e.target;
      if (target.classList && target.classList.contains('thul-fabbtn')) {
        collapsed = !collapsed;
        root.querySelector('.thul-card').classList.toggle('thul-open', !collapsed);
        render();
        return;
      }
      const act = target.getAttribute && target.getAttribute('data-act');
      if (!act) return;
      if (act === 'open') {
        send(MSG.OPEN_URL, { url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
      } else if (act === 'refresh') {
        toast('已开始抓取，可在面板查看进度…');
        send(MSG.REFRESH, { force: true });
      } else if (act === 'sample') {
        const res = await send(MSG.MANUAL_SNAPSHOT, {
          html: document.documentElement.outerHTML,
          url: location.href,
          kind: 'manual',
        });
        toast(res && res.ok ? '已保存当前页样本' : '保存失败');
      }
    });

    document.body.appendChild(root);
    refreshState();
  }

  async function refreshState() {
    try {
      const res = await send(MSG.GET_STATE);
      if (res && res.ok) {
        state = {
          pending: (res.state.cache && res.state.cache.stats && res.state.cache.stats.pending) || 0,
          fetchedAt: (res.state.cache && res.state.cache.fetchedAt) || 0,
        };
        render();
      }
    } catch {
      /* 扩展刚更新时可能短暂失败 */
    }
  }

  /* --------------------------- 消息处理 --------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'content') {
      if (msg && msg.target === UI && msg.event === 'stateChanged') refreshState();
      return false;
    }
    try {
      if (msg.type === 'getCsrf') {
        const hit = getCsrf();
        sendResponse(hit ? { ok: true, token: hit.token, via: hit.via } : { ok: false, error: '页面里没有找到 _csrf' });
      } else if (msg.type === 'sessionReport') {
        // 只报告 cookie 的**名字**，不报告值 —— 诊断信息可能会被导出或贴出来
        const cookieNames = String(document.cookie || '')
          .split(';')
          .map((s) => s.split('=')[0].trim())
          .filter(Boolean);
        sendResponse({
          ok: true,
          href: location.href,
          title: document.title,
          hasPasswordInput: !!document.querySelector('input[type="password"]'),
          hasCourseShell: !!document.querySelector('#selfcourse, #suoxuecourse, #tablist'),
          renderedCourses: document.querySelectorAll('#selfcourse .item, #suoxuecourse .item').length,
          cookieNames,
          csrfFound: !!getCsrf(),
        });
      } else if (msg.type === 'snapshot') {
        // 把“站点自己渲染完的”整页 HTML 交回后台，由离屏解析器统一处理；
        // 顺带把它自己发的 /b/ 请求带回去，供接口层学习
        sendResponse({
          ok: true,
          html: document.documentElement.outerHTML,
          url: location.href,
          rows: document.querySelectorAll('#examplesearch tbody tr, #zyalltable tbody tr, #ggalltable tbody tr, #kjalltable tbody tr').length,
          sniffed: getSniffed(),
        });
      } else if (msg.type === 'activateTab') {
        sendResponse(activateTab(msg.label));
      } else if (msg.type === 'probeText') {
        sendResponse(probeText());
      } else if (msg.type === 'probeRows') {
        sendResponse(probeRows(msg.kind || 'notice'));
      } else if (msg.type === 'getSniffed') {
        sendResponse({ ok: true, sniffed: getSniffed() });
      } else if (msg.type === 'scrape') {
        sendResponse(scrapeRows(msg.kind || 'notice'));
      } else if (msg.type === 'ping') {
        sendResponse({ ok: true, url: location.href });
      } else {
        sendResponse({ ok: false, error: `未知指令 ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
    return false;
  });

  function start() {
    send(MSG.GET_STATE)
      .then((res) => {
        const enabled = !res || !res.ok || !res.state || res.state.settings.floatingButton !== false;
        if (enabled) build();
      })
      .catch(() => build());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
