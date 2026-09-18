/**
 * 通用采集脚本（ISOLATED world）。
 *
 * 与 sniffer.js 的分工：
 *   sniffer.js  跑在页面自己的 JS 环境里（MAIN），负责**捕获**请求；
 *   本脚本      跑在内容脚本环境里（ISOLATED），负责**收集并回传**后台。
 *
 * 关键设计：每捕获到一条就**立刻发给后台**，而不是攒在页面里。
 * 因为雨课堂这类 SPA 会不停换页，页面一导航，页面里的缓冲区就没了；
 * 只有把记录送进后台，跨页面的记录才连得起来。
 *
 * 这个脚本刻意保持极简：只做缓冲、回传、快照，不注入任何界面元素。
 */

(function collector() {
  if (window.__thuLearnCollectorReady) return;
  window.__thuLearnCollectorReady = true;

  const MAX = 120;
  const buffer = [];

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !data.__thuLearnSniff) return;
    const record = data.__thuLearnSniff;
    // 页面里那份缓冲（用于本页快照）
    buffer.push(record);
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
    // 立刻回传后台：跨页面导航也不会丢
    try {
      chrome.runtime.sendMessage({ target: 'sw', type: 'sniffRecord', payload: record }).catch(() => {});
    } catch { /* 扩展刚更新时可能短暂失败 */ }
  });

  /** 页面侧的结构信息：章节/卡片这类容器，帮助判断“作业列表长什么样” */
  function pageOutline() {
    const text = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    const tables = Array.from(document.querySelectorAll('table')).slice(0, 12).map((t) => ({
      id: t.id || '', cls: t.getAttribute('class') || '',
      heads: Array.from(t.querySelectorAll('th')).map(text).slice(0, 12),
      rows: t.querySelectorAll('tbody tr').length,
    }));
    const lists = Array.from(document.querySelectorAll('[class*="list"], [class*="card"], ul, ol'))
      .slice(0, 40)
      .map((el) => ({ tag: el.tagName.toLowerCase(), cls: el.getAttribute('class') || '', children: el.children.length, sample: text(el).slice(0, 80) }))
      .filter((x) => x.children >= 2);
    return {
      title: document.title,
      tables,
      lists: lists.slice(0, 20),
      localStorageKeys: (() => { try { return Object.keys(window.localStorage).slice(0, 40); } catch { return []; } })(),
      sessionStorageKeys: (() => { try { return Object.keys(window.sessionStorage).slice(0, 40); } catch { return []; } })(),
      cookieNames: String(document.cookie || '').split(';').map((s) => s.split('=')[0].trim()).filter(Boolean),
      bodyTextSample: text(document.body).slice(0, 1500),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 60).map((a) => ({ text: text(a).slice(0, 40), href: a.getAttribute('href') })),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'content') return false;
    if (msg.type === 'ping') {
      sendResponse({ ok: true, url: location.href, collector: true });
    } else if (msg.type === 'getSniffed') {
      sendResponse({ ok: true, sniffed: buffer.slice() });
    } else if (msg.type === 'probeText') {
      const t = String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
      sendResponse({ ok: true, textLength: t.length, ready: document.readyState === 'complete' });
    } else if (msg.type === 'fetchJson') {
      // 从**页面自己的源**发请求，而不是从 Service Worker 发。
      // 原因：雨课堂的会话 cookie 大概率是 SameSite=Lax，而扩展后台发出的请求
      // 被浏览器视为跨站，那种情况下 cookie 根本不会带上，接口会返回未登录。
      // 在页面上下文里发就是同源请求，cookie/SameSite 全都天然满足。
      const url = String((msg && msg.url) || '');
      let host = '';
      try { host = new URL(url).hostname; } catch { host = ''; }
      if (!/(^|\.)yuketang\.cn$/i.test(host)) {
        sendResponse({ ok: false, error: '只允许对雨课堂域发起取数请求' });
        return false;
      }
      fetch(url, {
        method: msg.method || 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
        headers: { Accept: 'application/json, text/plain, */*', ...(msg.headers || {}) },
      })
        .then((res) => res.text().then((text) => {
          sendResponse({ ok: true, status: res.status, url: res.url || url, text: text.slice(0, 300000) });
        }))
        .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
      return true;   // 异步应答
    } else if (msg.type === 'snapshot') {
      // 渲染后的正文：SPA 的字段名常常只在界面上露出来，而原始 HTML 前 20 万字符
      // 几乎全是脚本，等于什么都没记到（上一轮取证的作业说明就是这么丢的）。
      const text = String((document.body && document.body.innerText) || '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      sendResponse({
        ok: true,
        html: document.documentElement.outerHTML,
        text: text.slice(0, 60000),
        url: location.href,
        sniffed: buffer.slice(),
        outline: pageOutline(),
      });
    } else {
      sendResponse({ ok: false, error: `未知指令 ${msg.type}` });
    }
    return false;
  });
})();
