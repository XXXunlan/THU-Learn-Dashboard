/**
 * Service Worker：唯一的“大脑”。
 *
 * popup / dashboard / content script 都不自己发请求，只发消息；
 * 抓取、登录、缓存、角标、定时刷新全部在这里，保证多入口看到的状态一致。
 */

import { EVENT, MSG, TARGET, SITE } from '../common/constants.js';
import { createLogger, dumpLogs } from '../common/logger.js';
import {
  buildState, getSettings, setSettings, setCredentials,
  clearCredentials, clearCache, getCache, getDiagnostics, memory, patchSession, hydrateSession,
} from './store.js';
import { ensureLogin, checkSession, diagnoseSession, logout, autofillLoginTab, AuthError } from './auth.js';
import { crawlAll, countUrgent, CancelledError } from './crawler.js';
import { resolveCsrf, cachedToken } from './csrf.js';
import { pingOffscreen } from './offscreen-client.js';
import { runForensics } from './probe.js';
import { closeHelperTab } from './tab-scraper.js';
import { startSniff, stopSniff, appendRecord, unregisterCollectors, hasPermission, selfCheckYuketang } from './yuketang.js';

const log = createLogger('sw');
const ALARM_REFRESH = 'autoRefresh';
const DASHBOARD_URL = 'src/dashboard/dashboard.html';

/* ------------------------------- 与 UI 通信 ------------------------------- */

function broadcast(event, payload) {
  chrome.runtime.sendMessage({ target: TARGET.UI, event, payload }).catch(() => {
    /* 没有 UI 在监听是正常的 */
  });
}

function pushProgress(progress) {
  broadcast(EVENT.PROGRESS, progress);
}

/* --------------------------------- 角标 ---------------------------------- */

async function refreshBadge(cache) {
  try {
    const c = cache || (await getCache());
    const n = countUrgent(c);
    const text = n > 0 ? String(Math.min(n, 99)) : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: n > 0 ? '#c62828' : '#660874' });
    if (text && chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
  } catch (err) {
    log.warn('更新角标失败', err && err.message);
  }
}

/* --------------------------------- 抓取 ---------------------------------- */

let crawling = null;

async function runCrawl({ force = false, courseIds = null, reason = 'manual' } = {}) {
  if (crawling) {
    log.info('已有抓取在进行，复用该次任务');
    return crawling;
  }
  log.info('开始抓取', { reason, force });
  crawling = (async () => {
    try {
      const cache = await crawlAll({ force, onlyCourseIds: courseIds, onProgress: pushProgress });
      await refreshBadge(cache);
      broadcast(EVENT.STATE_CHANGED, await buildState());
      return { ok: true, cache };
    } catch (err) {
      const isAuth = err instanceof AuthError;
      const isCancel = err instanceof CancelledError;
      if (isAuth) {
        await patchSession({
          loggedIn: false,
          needsManualLogin: true,
          loginUrl: (err.info && err.info.loginUrl) || SITE.COURSE_LIST_URL,
          lastError: err.message,
        });
      } else if (!isCancel) {
        log.error('抓取失败', err);
        await patchSession({ lastError: err.message || String(err) });
      }
      broadcast(EVENT.STATE_CHANGED, await buildState());
      return { ok: false, cancelled: isCancel, authRequired: isAuth, error: err.message, info: err.info || null };
    } finally {
      crawling = null;
      memory.progress = memory.progress && memory.progress.running ? { ...memory.progress, running: false } : memory.progress;
    }
  })();
  return crawling;
}

/* --------------------------------- 登录 ---------------------------------- */

/** 打开（或复用）登录页标签页 */
async function openLoginTab(loginUrl) {
  const url = loginUrl || SITE.COURSE_LIST_URL;
  try {
    const tabs = await chrome.tabs.query({ url: ['https://*.tsinghua.edu.cn/*', 'https://learn.tsinghua.edu.cn/*'] });
    const existing = tabs.find((t) => t.url && /(login|id\.tsinghua|iaaa)/i.test(t.url));
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      return existing.id;
    }
  } catch { /* 查询失败就直接新建 */ }
  const tab = await chrome.tabs.create({ url, active: true });
  return tab.id;
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(true);
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/* --------------------------------- 定时 ---------------------------------- */

async function syncAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_REFRESH);
  const minutes = Number(settings.autoRefreshMinutes) || 0;
  if (minutes > 0) {
    chrome.alarms.create(ALARM_REFRESH, { periodInMinutes: Math.max(5, minutes), delayInMinutes: 1 });
    log.info(`已设置自动刷新：每 ${Math.max(5, minutes)} 分钟`);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_REFRESH) return;
  const [cache, settings] = await Promise.all([getCache(), getSettings()]);
  const stale = Date.now() - (cache.fetchedAt || 0) > Math.max(5, settings.autoRefreshMinutes || 60) * 60 * 1000;
  if (stale) await runCrawl({ reason: 'alarm' });
  else await refreshBadge(cache);
});

/* ------------------------------- 消息路由 -------------------------------- */

/**
 * 把整页 HTML 压成“只看结构”的精简版，用来塞进诊断包。
 *
 * 目的很单纯：**让拿到它的人能直接看清那一页到底有什么元素**。
 * script/style 的内容是纯噪声（几十上百 KB），注释也是，全部去掉；
 * 再把连续空白折叠、整体截断。一份 300KB 的页面通常能压到 20KB 以内。
 *
 * ⚠️ 注意不能把脚本替换成 `<script/>` —— HTML 里它不是自闭合标签，
 * 真实浏览器会把后面整个文档都吞进脚本内容，导出的快照就废了。用注释标记代替。
 */
function slimHtml(html, max = 200000) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '<!--script-->')
    .replace(/<style[\s\S]*?<\/style>/gi, '<!--style-->')
    .replace(/<!--(?!script|style)[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, max);
}

const HANDLERS = {
  async [MSG.GET_STATE]() {
    await hydrateSession();
    return { ok: true, state: await buildState() };
  },

  async [MSG.CHECK_SESSION]() {
    try {
      const s = await checkSession();
      await patchSession({
        loggedIn: s.loggedIn,
        needsManualLogin: !s.loggedIn,
        loginUrl: s.loggedIn ? '' : s.loginUrl || SITE.COURSE_LIST_URL,
        lastError: s.loggedIn ? '' : (s.detail || ''),
        loginMethod: s.via || '',
        evidence: s.evidence || null,
      });
      broadcast(EVENT.STATE_CHANGED, await buildState());
      return { ok: true, loggedIn: s.loggedIn, via: s.via, detail: s.detail, evidence: s.evidence };
    } catch (err) {
      await patchSession({ loggedIn: false, lastError: err.message });
      return { ok: false, loggedIn: false, error: err.message };
    }
  },

  /**
   * 全面取证：一次点击，把接口候选、站点自己的请求与响应、页面结构骨架
   * 全部打包成一个 JSON。目的是一轮就能把需要的信息拿齐，不要来回试。
   */
  async [MSG.RUN_FORENSICS]({ courseIndex = 0 } = {}) {
    try {
      const report = await runForensics({ courseIndex });
      return { ok: true, report };
    } catch (err) {
      log.error('全面取证失败', err);
      return { ok: false, error: (err && err.message) || String(err) };
    }
  },

  /**
   * 雨课堂取证：开始持续记录站点自己发出的请求（含响应体）。
   * 权限必须由用户在点击手势里授予，所以这里只如实回报「需要权限」，不自己申请。
   */
  async [MSG.START_SNIFF](payload = {}) {
    const res = await startSniff(payload);
    return res;
  },

  /** 结束记录并汇总成一份可导出的报告 */
  async [MSG.STOP_SNIFF]() {
    try {
      const report = await stopSniff();
      await unregisterCollectors();
      return { ok: true, report };
    } catch (err) {
      log.error('雨课堂记录汇总失败', err);
      return { ok: false, error: (err && err.message) || String(err) };
    }
  },

  /** 内容脚本每捕获一条请求就实时回传，避免页面导航把缓冲冲掉 */
  async [MSG.SNIFF_RECORD](record) {
    await appendRecord(record);
    return { ok: true };
  },

  /**
   * 雨课堂自检：把「为什么没抓到作业」一次说清楚。
   * 这条链路长（权限 → 登录 → 首页 → 认接口 → 逐课取 → 课程名匹配），
   * 任何一环断了在界面上都只表现为「没有雨课堂作业」，所以要有这样一次带过程的自检。
   */
  async [MSG.YKT_SELFCHECK]() {
    try {
      const cache = await getCache();
      const courses = (cache && cache.courses) || [];
      const res = await selfCheckYuketang({ learnCourses: courses });
      return { ok: true, lines: res.lines, summary: res.summary, linkOk: res.ok, courseCount: courses.length };
    } catch (err) {
      log.error('雨课堂自检失败', err);
      return { ok: false, error: (err && err.message) || String(err) };
    } finally {
      await closeHelperTab();
    }
  },

  /** 登录诊断：把判定会话的每一步证据原样返回给界面 */
  async [MSG.DIAGNOSE_SESSION]() {
    const report = await diagnoseSession();
    await patchSession({
      loggedIn: report.loggedIn,
      needsManualLogin: !report.loggedIn,
      loginMethod: report.decision.via,
      lastError: report.loggedIn ? '' : report.decision.detail,
      evidence: report.evidence,
    });
    broadcast(EVENT.STATE_CHANGED, await buildState());
    return { ok: true, report };
  },

  /**
   * 保存账号密码（用于在统一身份认证页面自动填充），并检查会话。
   * 注意：这里不会假装能替用户完成 SSO 登录。
   */
  async [MSG.LOGIN]({ username = '', password = '', remember = false, openTab = true, autofill = true, autoRefresh = true } = {}) {
    await setCredentials({ username, password, remember });
    const result = await ensureLogin({ force: true });

    if (result.loggedIn) {
      if (autoRefresh) runCrawl({ reason: 'after-login' });
      else broadcast(EVENT.STATE_CHANGED, await buildState());
      return { ok: true, loggedIn: true, method: result.method };
    }

    let tabId = null;
    if (openTab) {
      tabId = await openLoginTab(result.loginUrl);
      if (autofill && username && password) {
        await waitForTabComplete(tabId);
        const filled = await autofillLoginTab(tabId);
        broadcast(EVENT.STATE_CHANGED, await buildState());
        return {
          ok: false,
          loggedIn: false,
          needsManualLogin: true,
          loginUrl: result.loginUrl,
          tabId,
          autofill: filled,
          message: filled.ok
            ? '已在新标签页里填好账号密码，请完成验证码/二次认证后回到面板。'
            : `${result.message}（自动填充未成功：${filled.error}）`,
        };
      }
    }

    broadcast(EVENT.STATE_CHANGED, await buildState());
    return { ok: false, loggedIn: false, needsManualLogin: true, loginUrl: result.loginUrl, tabId, message: result.message };
  },

  /** 只做自动填充（用户已经在登录页上） */
  async [MSG.AUTOFILL_LOGIN]({ tabId } = {}) {
    let id = tabId;
    if (!id) {
      const tabs = await chrome.tabs.query({ url: ['https://*.tsinghua.edu.cn/*'] });
      const tab = tabs.find((t) => t.url && /(login|id\.tsinghua|iaaa)/i.test(t.url)) || tabs[0];
      id = tab && tab.id;
    }
    if (!id) return { ok: false, error: '没有找到已打开的网络学堂/统一身份认证标签页' };
    const res = await autofillLoginTab(id);
    return res;
  },

  async [MSG.LOGOUT]() {
    memory.abort = true;
    await logout();
    await clearCredentials();
    await clearCache();
    await refreshBadge({ courses: [] });
    broadcast(EVENT.STATE_CHANGED, await buildState());
    return { ok: true };
  },

  async [MSG.REFRESH]({ force = false, courseIds = null } = {}) {
    return runCrawl({ force, courseIds, reason: 'manual' });
  },

  async [MSG.CANCEL_REFRESH]() {
    memory.abort = true;
    return { ok: true };
  },

  async [MSG.UPDATE_SETTINGS]({ patch = {} } = {}) {
    const settings = await setSettings(patch);
    if ('autoRefreshMinutes' in patch) await syncAlarm();
    broadcast(EVENT.STATE_CHANGED, await buildState());
    return { ok: true, settings };
  },

  async [MSG.OPEN_URL]({ url, active = true } = {}) {
    if (!url) return { ok: false, error: '缺少 url' };
    const tab = await chrome.tabs.create({ url, active });
    return { ok: true, tabId: tab.id };
  },

  async [MSG.EXPORT_DIAGNOSTICS]() {
    await hydrateSession();
    const [diagnostics, settings, cache] = await Promise.all([getDiagnostics(), getSettings(), getCache()]);
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    // 学到的接口模板也要一起导出：接口那一路到底通不通，看它就知道了
    const { learnedTemplates = {} } = await chrome.storage.local.get('learnedTemplates');
    // 顺带确认离屏解析器是否健康 —— 兜底路径全靠它
    let offscreen = { ok: false };
    try {
      const pong = await pingOffscreen();
      offscreen = { ok: !!(pong && pong.pong), ready: !!(pong && pong.ready) };
    } catch (err) {
      offscreen = { ok: false, error: err.message };
    }
    return {
      ok: true,
      bundle: {
        generatedAt: new Date().toISOString(),
        extension: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        offscreen,
        settings,
        session: memory.session,
        cacheSummary: {
          fetchedAt: cache.fetchedAt,
          durationMs: cache.durationMs,
          stats: cache.stats,
          errors: cache.errors,
          notes: cache.notes,
          courses: (cache.courses || []).map((c) => ({
            id: c.id, name: c.name, counts: c.counts, stats: c.stats, errors: c.errors,
            announcements: c.announcements.length, files: c.files.length, homework: c.homework.length,
          })),
          sampleItems: (cache.courses || []).flatMap((c) => [
            ...c.homework.slice(0, 2).map((h) => ({ kind: 'homework', ...h, text: undefined })),
            ...c.announcements.slice(0, 1).map((n) => ({ kind: 'notice', ...n, text: undefined })),
            ...c.files.slice(0, 1).map((f) => ({ kind: 'file', ...f, text: undefined })),
          ]).slice(0, 24),
        },
        diagnostics,
        learnedTemplates,
        logs: dumpLogs(),
        // 带上**带 HTML 的精简快照** —— 上一版只导出了元信息，等于白存
        snapshots: (snapshots || []).map((s) => ({
          url: s.url, kind: s.kind, method: s.method, count: s.count,
          at: s.at, failed: !!s.failed, reason: s.reason,
          html: slimHtml(s.html),
        })),
      },
      snapshots,
    };
  },

  async [MSG.MANUAL_SNAPSHOT]({ html, url = '', kind = 'manual' } = {}) {
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    const next = [{ url, kind, method: 'manual', count: null, at: Date.now(), html: String(html || '').slice(0, 400000) }, ...snapshots].slice(0, 6);
    await chrome.storage.local.set({ snapshots: next });
    return { ok: true, count: next.length };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.SW) return false;
  const handler = HANDLERS[msg.type];
  if (!handler) {
    sendResponse({ ok: false, error: `未知指令: ${msg.type}` });
    return false;
  }
  Promise.resolve(handler(msg.payload || {}, sender))
    .then((res) => sendResponse(res))
    .catch((err) => {
      log.error('处理消息出错', msg.type, err);
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });
  return true; // 异步响应
});

/* ------------------------------ 生命周期 --------------------------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  log.info('扩展已安装/更新', details.reason);
  await syncAlarm();
  await refreshBadge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL(DASHBOARD_URL) });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  log.info('浏览器启动');
  await syncAlarm();
  const cache = await getCache();
  await refreshBadge(cache);
  const settings = await getSettings();
  if (settings.autoRefreshMinutes > 0 && Date.now() - (cache.fetchedAt || 0) > settings.autoRefreshMinutes * 60 * 1000) {
    runCrawl({ reason: 'startup' });
  }
});

// 用户浏览网络学堂时顺手把 _csrf 令牌缓存起来（**只在没有令牌时**才去取，
// 之前每完成一次页面加载都强刷一遍，纯属浪费）
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !tab.url.startsWith(SITE.ORIGIN)) return;
  if (cachedToken()) return;
  try {
    await resolveCsrf({ force: true });
  } catch { /* 忽略 */ }
});

log.info('Service Worker 已启动');
