/**
 * 后台标签页兜底抓取。
 *
 * 为什么需要它：列表页是 DataTables 服务端分页渲染的，页面原始 HTML 里没有数据；
 * 万一接口参数与站点期望的不一致，直接 fetch 就会一无所获。
 * 这时改让浏览器自己去打开那个列表页 —— 站点自己的 JS 一定知道怎么取数据 ——
 * 等它把表格画出来之后，再从渲染好的 DOM 里读。
 *
 * 三个必须遵守的约束（都是踩过坑的）：
 *
 * 1) **串行**。只有这一个辅助标签页，而课程是并发抓取的。曾经因此出过很隐蔽的 bug：
 *    A 课把它导航到自己的页面后 B 课立刻又导航走，A 课等到的“渲染完成”其实是 B 课的页面，
 *    于是 A 课拿到 B 课的数据。所以下面用 Promise 队列把访问串行化。
 *
 * 2) **不要出现在用户眼前**。以前用 tabs.create(active:false) 建这个页面，
 *    它虽然不抢焦点，但**仍然留在用户的标签栏里并且 URL 不停变化** —— 实测非常干扰。
 *    现在把它放进一个独立的、最小化的窗口里，用户基本看不到。
 *
 * 3) **不要死等**。以前每个页面固定等 3.5 秒，30 次就是 105 秒纯等待。
 *    现在改成轮询“目标表格渲染好了吗”，好了立刻走（通常 0.5～1.5 秒），
 *    只有真的空列表才会等到上限。
 */

import { ORIGIN } from '../api/endpoints.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('tab-scraper');

let helperTabId = null;
let helperWindowId = null;

/** 串行队列：保证同一时刻只有一个任务在操作那个辅助标签页 */
let tabQueue = Promise.resolve();
function withHelperTab(task) {
  const run = tabQueue.then(task, task);
  tabQueue = run.then(() => {}, () => {});   // 队列不能因为某次失败就断掉
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHelperTab() {
  if (helperTabId !== null) {
    try {
      await chrome.tabs.get(helperTabId);
      return helperTabId;
    } catch {
      helperTabId = null;
      helperWindowId = null;
    }
  }

  // 优先放进独立窗口并最小化：这样它不会在用户自己的标签栏里晃
  try {
    const win = await chrome.windows.create({
      url: 'about:blank',
      focused: false,
      state: 'minimized',
      type: 'normal',
    });
    helperWindowId = win.id;
    helperTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    if (helperTabId !== null) {
      log.info('已创建辅助窗口（最小化，用于渲染兜底）');
      return helperTabId;
    }
  } catch (err) {
    log.warn('创建最小化辅助窗口失败，退回普通标签页', err && err.message);
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  helperTabId = tab.id;
  return helperTabId;
}

export async function closeHelperTab() {
  const tabId = helperTabId;
  const winId = helperWindowId;
  helperTabId = null;
  helperWindowId = null;
  if (winId !== null) {
    try { await chrome.windows.remove(winId); return; } catch { /* 窗口可能已关 */ }
  }
  if (tabId !== null) {
    try { await chrome.tabs.remove(tabId); } catch { /* ignore */ }
  }
}

function waitForComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** 向内容脚本发消息，页面刚导航完时内容脚本可能还没就绪，所以重试几次 */
async function askContentScript(tabId, message, attempts = 8) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (res) return res;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200 + i * 200);
  }
  throw new Error(`内容脚本没有响应：${(lastErr && lastErr.message) || '未知原因'}`);
}

/**
 * 等目标表格渲染好，而不是死等固定时长。
 * 一旦内容脚本报告“表格已经就位”（有行，或者是明确渲染出的空表），立刻返回。
 * @returns {{rows:number, ready:boolean, waitedMs:number, table:string}}
 */
async function waitForRows(tabId, kind, maxMs) {
  const started = Date.now();
  let last = { rows: 0, ready: false, table: '' };
  while (Date.now() - started < maxMs) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'probeRows', kind });
      if (res && res.ok) {
        last = { rows: res.rows || 0, ready: !!res.ready, table: res.table || '' };
        if (last.rows > 0) return { ...last, waitedMs: Date.now() - started };
        if (last.ready) {
          // 表格已经渲染出来但是空的 —— 再给一小段时间让 AJAX 补数据
          await sleep(600);
          const again = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'probeRows', kind }).catch(() => null);
          if (again && again.ok && again.rows > 0) {
            return { rows: again.rows, ready: true, table: again.table || last.table, waitedMs: Date.now() - started };
          }
          return { ...last, waitedMs: Date.now() - started };
        }
      }
    } catch { /* 内容脚本还没就绪，继续等 */ }
    await sleep(250);
  }
  return { ...last, waitedMs: Date.now() - started };
}

/**
 * 等页面正文「稳定下来」而不是死等固定时长。
 *
 * 用于详情页这类**没有列表表格**的页面：没有表格可等，旧的 waitForRows
 * 只能把超时耗满（每条作业白等 3 秒，抓取结尾就像卡住了一样）。
 * 这里改成轮询正文长度，连续两次不变就认为渲染完了 —— 通常 1 秒左右即可。
 */
async function waitForStableText(tabId, maxMs = 3000, minMs = 700) {
  const started = Date.now();
  let last = -1;
  let stable = 0;
  let len = 0;
  while (Date.now() - started < maxMs) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'probeText' });
      len = (res && res.textLength) || 0;
      if (Date.now() - started >= minMs && len > 0 && len === last) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      last = len;
    } catch { /* 内容脚本还没就绪，继续等 */ }
    await sleep(220);
  }
  return { textLength: len, waitedMs: Date.now() - started };
}

/**
 * 打开一个页面，等站点自己渲染完，把整页 HTML 快照取回来。
 *
 * 拿到 HTML 后交给离屏解析器（与主路径共用同一套解析引擎），
 * 这样“兜底”和“主路径”不会各写一套互相不一致的逻辑。
 *
 * @param {string} url
 * @param {{settleMs?:number, kind?:string, tabLabel?:string, waitFor?:'list'|'settle'}} opts
 *   tabLabel：课程页是「聚合页 + 标签切换」，只有点了标签对应板块才会加载数据。
 *   waitFor：'list' 等列表表格出现（列表页）；'settle' 等正文稳定（详情页等没有表格的页面）。
 */
export async function snapshotViaTab(url, { settleMs = 3500, kind = 'auto', tabLabel = '', waitFor = 'list' } = {}) {
  return withHelperTab(async () => {
    const absolute = url.startsWith('http') ? url : ORIGIN + url;
    const tabId = await getHelperTab();
    await chrome.tabs.update(tabId, { url: absolute, active: false });
    await waitForComplete(tabId, 20000);

    let probe;
    if (waitFor === 'settle') {
      probe = await waitForStableText(tabId, Math.max(1200, settleMs));
    } else {
      await waitForRows(tabId, kind, Math.min(settleMs, 1800));
      let activated = null;
      if (tabLabel) {
        const res = await askContentScript(tabId, { target: 'content', type: 'activateTab', label: tabLabel }, 4)
          .catch(() => null);
        activated = res;
        if (res && res.ok) {
          log.info(`已点开「${tabLabel}」标签（${res.via}），等它加载数据…`);
          await waitForRows(tabId, kind, settleMs);
        }
      }
      probe = await waitForRows(tabId, kind, 1200);
      probe.activated = activated;
    }

    const res = await askContentScript(tabId, { target: 'content', type: 'snapshot' });
    if (!res || !res.ok || !res.html) {
      throw new Error((res && res.error) || '没有拿到页面内容');
    }
    log.info(`兜底页面就绪：${probe.rows != null ? `${probe.rows} 行 / ` : ''}等了 ${probe.waitedMs}ms${probe.table ? `（${probe.table}）` : ''}`);
    return {
      html: res.html,
      url: res.url || absolute,
      rows: res.rows || 0,
      ready: probe.ready,
      waitedMs: probe.waitedMs,
      activated: probe.activated || null,
      // 站点自己刚刚发过的 /b/ 请求（含响应体）—— 学接口最可靠的来源
      sniffed: Array.isArray(res.sniffed) ? res.sniffed : [],
      tabId,
    };
  });
}

/**
 * 同上，但走内容脚本里那套“按表头定位列”的表格读取。
 * 作为离屏解析器之外的第二个独立实现，两者互为印证。
 */
export async function scrapeViaTab(url, kind, { settleMs = 3500 } = {}) {
  return withHelperTab(async () => {
    const absolute = url.startsWith('http') ? url : ORIGIN + url;
    const tabId = await getHelperTab();
    await chrome.tabs.update(tabId, { url: absolute, active: false });
    await waitForComplete(tabId, 20000);
    await waitForRows(tabId, kind, settleMs);
    const res = await askContentScript(tabId, { target: 'content', type: 'scrape', kind });
    if (!res || !res.ok) throw new Error((res && res.error) || '页面里没有读到列表');
    return { items: res.items, method: res.method || 'tab-dom' };
  });
}

/**
 * 在辅助标签页里打开一个地址，并把「这段时间内独占该标签页」交给调用方。
 *
 * 与 snapshotViaTab 的区别：那个是「打开 → 取一份快照 → 立刻释放」，
 * 这个允许在**同一次占用内**继续向这个页面发若干个请求。
 *
 * 雨课堂必须这样才能做对：它的接口要靠页面自身的源去发（cookie 才带得全），
 * 所以打开首页之后得一直占着这个标签页、把每门课的作业都取完再放；
 * 中途一旦被别的任务导航走，后面那些请求就全落空了。
 */
export async function inHelperTab(url, fn, { settleMs = 4500, waitFor = 'settle' } = {}) {
  return withHelperTab(async () => {
    const absolute = url.startsWith('http') ? url : ORIGIN + url;
    const tabId = await getHelperTab();
    await chrome.tabs.update(tabId, { url: absolute, active: false });
    await waitForComplete(tabId, 25000);

    const probe = waitFor === 'settle'
      ? await waitForStableText(tabId, settleMs)
      : await waitForRows(tabId, 'auto', settleMs);

    const snapshot = await askContentScript(tabId, { target: 'content', type: 'snapshot' }).catch(() => null);

    /** 让**页面自己**发这个请求：同源、cookie 与 SameSite 全都天然满足。headers 用于带上学到的自定义头 */
    const fetchJson = async (target, headers) => {
      const res = await askContentScript(tabId, { target: 'content', type: 'fetchJson', url: target, headers: headers || {} })
        .catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));
      return res || { ok: false, error: '内容脚本没有响应' };
    };

    return fn({ tabId, snapshot, probe, fetchJson, sleep });
  });
}
