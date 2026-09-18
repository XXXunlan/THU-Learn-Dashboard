/**
 * 状态存储。
 *
 * 三块分开存是有意的：
 *  - local.settings     用户偏好
 *  - local.cache        抓取结果（面板直接渲染）
 *  - session.credentials 本次浏览器会话内的账号密码（关掉浏览器就没了）
 *  - local.credentials   只有用户显式勾选“记住密码”才会写入（明文，会在 UI 里明确警告）
 */

import { DEFAULT_SETTINGS, STORE_KEY } from '../common/constants.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('store');

const EMPTY_CACHE = {
  fetchedAt: 0,
  startedAt: 0,
  finishedAt: 0,
  durationMs: 0,
  courses: [],
  errors: [],
  stats: { courses: 0, notices: 0, files: 0, homework: 0, pending: 0, methods: {} },
  scope: 'idle',
};

export const memory = {
  progress: null,
  session: {
    loggedIn: false,
    checkedAt: 0,
    needsManualLogin: false,
    loginUrl: '',
    username: '',
    lastError: '',
    loginMethod: '',
    loginForm: null,
  },
  abort: false,
};

/* ---------------------------------- 设置 ---------------------------------- */

export async function getSettings() {
  const { [STORE_KEY.SETTINGS]: saved = {} } = await chrome.storage.local.get(STORE_KEY.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORE_KEY.SETTINGS]: next });
  log.info('设置已更新', Object.keys(patch));
  return next;
}

/* ---------------------------------- 缓存 ---------------------------------- */

export async function getCache() {
  const { [STORE_KEY.CACHE]: cache } = await chrome.storage.local.get(STORE_KEY.CACHE);
  return cache || { ...EMPTY_CACHE };
}

export async function setCache(cache) {
  const next = { ...EMPTY_CACHE, ...cache };
  await chrome.storage.local.set({ [STORE_KEY.CACHE]: next });
  return next;
}

export async function clearCache() {
  await chrome.storage.local.remove(STORE_KEY.CACHE);
}

/* --------------------------------- 凭据 ---------------------------------- */

export async function setCredentials({ username = '', password = '', remember = false }) {
  // 会话内凭据：storage.session 只对扩展可信上下文可见，浏览器关闭即清除
  try {
    await chrome.storage.session.set({ [STORE_KEY.CREDENTIALS]: { username, password } });
  } catch (err) {
    log.warn('storage.session 不可用，凭据仅留在内存中', err);
  }
  memory.session.username = username || memory.session.username;
  if (remember) {
    await chrome.storage.local.set({ [STORE_KEY.CREDENTIALS]: { username, password, savedAt: Date.now() } });
  } else {
    await chrome.storage.local.remove(STORE_KEY.CREDENTIALS);
  }
}

export async function getCredentials() {
  let session = {};
  try {
    session = (await chrome.storage.session.get(STORE_KEY.CREDENTIALS))[STORE_KEY.CREDENTIALS] || {};
  } catch { /* ignore */ }
  if (session.password) return { ...session, source: 'session' };
  const local = (await chrome.storage.local.get(STORE_KEY.CREDENTIALS))[STORE_KEY.CREDENTIALS];
  if (local && local.password) return { ...local, source: 'local' };
  return { username: session.username || '', password: '', source: 'none' };
}

export async function clearCredentials() {
  try { await chrome.storage.session.remove(STORE_KEY.CREDENTIALS); } catch { /* ignore */ }
  await chrome.storage.local.remove(STORE_KEY.CREDENTIALS);
}

/* --------------------------------- 诊断 ---------------------------------- */

export async function getDiagnostics() {
  const { [STORE_KEY.DIAGNOSTICS]: d } = await chrome.storage.local.get(STORE_KEY.DIAGNOSTICS);
  return d || { runs: [] };
}

export async function appendDiagnostic(entry) {
  const d = await getDiagnostics();
  d.runs = [entry, ...(d.runs || [])].slice(0, 12);
  await chrome.storage.local.set({ [STORE_KEY.DIAGNOSTICS]: d });
  return d;
}

/* --------------------------------- 汇总态 --------------------------------- */

export async function buildState() {
  const [settings, cache, credentials] = await Promise.all([getSettings(), getCache(), getCredentials()]);
  return {
    settings,
    cache,
    session: { ...memory.session },
    progress: memory.progress,
    hasSavedPassword: !!credentials.password && credentials.source === 'local',
    username: credentials.username || memory.session.username || '',
  };
}

export async function patchSession(patch) {
  memory.session = { ...memory.session, ...patch, checkedAt: Date.now() };
  // Service Worker 会被随时回收，会话态需要落盘才能在重启后恢复
  try {
    await chrome.storage.local.set({ sessionState: memory.session });
  } catch { /* ignore */ }
  return memory.session;
}

/** SW 重启后把上次的会话态读回来 */
export async function hydrateSession() {
  if (memory.session.checkedAt) return memory.session;
  try {
    const { sessionState } = await chrome.storage.local.get('sessionState');
    if (sessionState && sessionState.checkedAt) memory.session = { ...memory.session, ...sessionState };
  } catch { /* ignore */ }
  return memory.session;
}
