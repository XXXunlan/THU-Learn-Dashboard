/**
 * 请求嗅探器（注入到页面的 MAIN world，document_start 时机）。
 *
 * 为什么需要它：这些 pageList 接口是 DataTables 风格的服务端分页，
 * 参数名无法从压缩代码里确认，靠猜必然失败（实测 10 门课全部退回页面兜底）。
 * 与其继续猜，不如**让站点自己告诉我们**：它渲染列表时必然要发那个请求，
 * 我们在旁边把它记下来，之后照着它的样子重放 —— 只把课程 id 换掉。
 *
 * 这个脚本跑在页面自己的 JS 环境里（world: MAIN），所以能包到页面用的
 * XMLHttpRequest / fetch。它只记录、不修改、不阻塞，任何异常都自己吞掉。
 */

(function sniffer() {
  if (window.__thuLearnSnifferInstalled) return;
  window.__thuLearnSnifferInstalled = true;

  const MAX = 60;
  const buffer = [];
  /**
   * 记录哪些请求？
   *
   * 原来写死成 `/b/(wlxt|kc)/`，那只适用于清华网络学堂。现在改成**通用规则**：
   * 同源 + 不是静态资源。这样雨课堂（/api/v3/…）之类的站点也能直接复用，
   * 不必为每个站点改嗅探器。
   */
  const STATIC_RE = /\.(js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|mp4|webm|mp3|map|json\.txt)(\?|$)/i;
  /**
   * 雨课堂是**跨子域**架构：页面在 pro.yuketang.cn，而一部分接口在别的子域上
   * （教室详情里的 `university_domain` 就指向 tsinghua.yuketang.cn）。
   * 只放行同源会把这类请求整片丢掉 —— 上一轮取证就正是这样漏掉了课程列表。
   * 所以对 *.yuketang.cn 放宽成「同一主域」，其余站点仍然严格要求同源。
   */
  const SIBLING_RE = /(^|\.)yuketang\.cn$/i;
  function isInteresting(url) {
    try {
      const u = new URL(url, location.href);
      const sameOrigin = u.origin === location.origin;
      const sibling = SIBLING_RE.test(u.hostname) && SIBLING_RE.test(location.hostname);
      if (!sameOrigin && !sibling) return false;
      if (STATIC_RE.test(u.pathname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** 只记 header 的**名字**，不记值 —— 诊断包可能会被贴出来，别把令牌带出去 */
  function headerNames(init) {
    try {
      const h = init && init.headers;
      if (!h) return [];
      if (typeof h.forEach === 'function' && typeof h.get === 'function') {   // Headers
        const out = [];
        h.forEach((_v, k) => out.push(k));
        return out;
      }
      if (Array.isArray(h)) return h.map(([k]) => k);
      if (typeof h === 'object') return Object.keys(h);
    } catch { /* ignore */ }
    return [];
  }

  /**
   * 少数几个「客户端标识头」是**例外**：它们要记值。
   *
   * 为什么破这个例：雨课堂的 `mooc-api` 系列接口会返回
   * `{"msg":"XTBZ IS REQUIRED","error_code":40000,"success":false}` ——
   * 也就是**必须带某个自定义头**，而它的值只存在于站点自己发的请求里。
   * 不记值就只能靠猜（这个项目在"猜"上吃的亏已经够多了）。
   *
   * 这份白名单是**逐一列出**的，不是"除了敏感头都记" ——
   * 方向必须是"默认不记、特例才记"，否则迟早会把 Authorization 之类的漏出去。
   */
  const SAFE_HEADERS = new Set([
    'xtbz', 'x-client', 'x-platform', 'x-requested-with',
    'university-id', 'uv-id', 'platform-id', 'x-version', 'client-version', 'x-source',
  ]);
  function safeHeadersFrom(getValue) {
    const out = {};
    try {
      for (const name of SAFE_HEADERS) {
        const v = getValue(name);
        if (v !== undefined && v !== null && v !== '') out[name] = String(v).slice(0, 80);
      }
    } catch { /* ignore */ }
    return out;
  }

  /** 统一记成绝对地址：相对地址在后台没法归类，也没法重放 */
  function absolute(url) {
    try { return new URL(url, location.href).href; } catch { return String(url || ''); }
  }

  function push(entry) {
    try {
      if (entry && entry.url) entry.url = absolute(entry.url);
      buffer.push(entry);
      if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
      window.postMessage({ __thuLearnSniff: entry }, '*');
    } catch { /* 记录失败绝不能影响页面 */ }
  }

  function bodyToString(body) {
    try {
      if (!body) return '';
      if (typeof body === 'string') return body.slice(0, 4000);
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString().slice(0, 4000);
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const out = [];
        body.forEach((v, k) => out.push(`${k}=${String(v).slice(0, 200)}`));
        return out.join('&').slice(0, 4000);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * 响应体也要留一份。
   *
   * 这是整个嗅探里**最有价值**的部分：知道站点发了什么请求只是第一步，
   * 看到它拿到了什么响应，才能确定接口到底是不是我们要的那一个、
   * 字段叫什么、以及"是不是根本没返回数据"。
   */
  const RESPONSE_LIMIT = 20000;
  function snippet(text) {
    return String(text == null ? '' : text).slice(0, RESPONSE_LIMIT);
  }

  /* ------------------------------ XHR ------------------------------ */

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setRequestHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function patchedOpen(method, url, ...rest) {
      try { this.__thuLearn = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), safe: {} }; } catch { /* ignore */ }
      return open.call(this, method, url, ...rest);
    };

    // 站点用 axios 发请求，自定义头都是走 setRequestHeader 设的 ——
    // 不拦这里就拿不到 XTBZ 这类「必须有但只在站点请求里出现」的头。
    XHR.prototype.setRequestHeader = function patchedSetHeader(name, value) {
      try {
        const info = this.__thuLearn;
        const key = String(name || '').toLowerCase();
        if (info && info.safe && SAFE_HEADERS.has(key)) info.safe[key] = String(value == null ? '' : value).slice(0, 80);
      } catch { /* ignore */ }
      return setRequestHeader.call(this, name, value);
    };

    XHR.prototype.send = function patchedSend(body) {
      try {
        const info = this.__thuLearn;
        if (info && isInteresting(info.url)) {
          const record = {
            via: 'xhr',
            method: info.method,
            url: info.url,
            body: bodyToString(body),
            safeHeaders: { ...(info.safe || {}) },
            at: Date.now(),
          };
          this.addEventListener('load', () => {
            try {
              record.status = this.status;
              record.responseSnippet = snippet(this.responseText);
              push(record);
            } catch { /* ignore */ }
          });
        }
      } catch { /* ignore */ }
      return send.call(this, body);
    };
  }

  /* ------------------------------ fetch ------------------------------ */

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      let safe = {};
      try {
        const h = init && init.headers;
        if (h && typeof h.forEach === 'function' && typeof h.get === 'function') {
          safe = safeHeadersFrom((n) => h.get(n));
        } else if (h && typeof h === 'object' && !Array.isArray(h)) {
          safe = safeHeadersFrom((n) => {
            const hit = Object.keys(h).find((k) => k.toLowerCase() === n);
            return hit ? h[hit] : undefined;
          });
        }
      } catch { /* ignore */ }
      const record = isInteresting(url)
        ? {
          via: 'fetch',
          method,
          url,
          body: bodyToString(init && init.body),
          headerNames: headerNames(init),
          safeHeaders: safe,
          at: Date.now(),
        }
        : null;
      const promise = nativeFetch.apply(this, arguments);
      if (record) {
        promise.then((res) => {
          try {
            record.status = res.status;
            res.clone().text()
              .then((t) => { record.responseSnippet = snippet(t); push(record); })
              .catch(() => push(record));
          } catch { push(record); }
        }).catch(() => push(record));
      }
      return promise;
    };
  }

  /** 供内容脚本按需读取（同一 world 内可直接调，postMessage 只是备份通道） */
  window.__thuLearnGetSniffed = () => buffer.slice(-MAX);
})();
