/**
 * 会话与登录。
 *
 * 关于登录方式，这里必须说实话：
 * 现在的网络学堂走清华大学统一身份认证（id.tsinghua.edu.cn），登录页带验证码，
 * 大概率还有二次认证。所以**不存在“扩展直接 POST 账号密码就能登录”这回事**，
 * 任何号称能做到的实现都是过时的（站点自己的旧接口 j_spring_security_check 也已废弃）。
 *
 * 因此扩展的策略是：
 *   1) 复用浏览器里已有的会话（这是主路径，cookie 由 Chrome 自己带）；
 *   2) 没登录时，帮用户把登录页打开；
 *   3) 用户已在扩展里填过账号密码的话，**自动填充**到统一身份认证的登录表单里，
 *      用户只需要点验证码/确认 —— 这一步用 chrome.scripting 注入，属于用户主动触发的动作；
 *   4) 轮询会话，一旦建立就自动开始抓取。
 */

import { SITE } from '../common/constants.js';
import { createLogger } from '../common/logger.js';
import { probeJson } from '../api/client.js';
import { API } from '../api/endpoints.js';
import { parsePageInfo, parseLoginForm } from './offscreen-client.js';
import { resolveCsrf, cachedToken, tokenSource } from './csrf.js';
import { getCredentials, getSettings, patchSession } from './store.js';

const log = createLogger('auth');

export class AuthError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'AuthError';
    this.info = info;
  }
}

/**
 * 会话判定的**纯函数**（不碰网络，因此可以直接单测）。
 *
 * 这里修掉了两个必然导致「登录了却提示未登录」的错误：
 *
 *  1) 旧实现把「学生课程列表页发生重定向」直接当成未登录。
 *     但站点自己就会对**已登录**的请求做重定向 —— 证据是它真实的 URL 形态
 *     `/f/wlxt/index/course/student/;jsessionid=…wlxt20181?websiteShowLanguage=zh_CN`，
 *     即 URL 重写 session id、追加语言参数都会产生 302。于是登录成功反而被判成未登录。
 *     → 现在只有「/b/ 开头的 JSON 接口」被重定向才算未登录
 *       （已登录的会话绝不会把 JSON 接口重定向走）。
 *
 *  2) 旧实现用 /j_spring_security/ 当“登录页”标记，而这个前缀同样匹配
 *     `/f/j_spring_security_logout` —— 那恰恰是**登录之后**页面上才会出现的退出链接。
 *     → 现在只认真正的登录提交端点 `j_spring_security_check`。
 *
 * @param {{kind:string,status?:number,json?:any,snippet?:string,reason?:string}} api  probeJson 的结果
 * @param {null|{status?:number,finalUrl?:string,hasPasswordInput?:boolean,isLoginUrl?:boolean,hasCourseShell?:boolean,error?:string}} page 页面探测结果
 * @param {null|{ok?:boolean,loggedIn?:boolean,hasCourseShell?:boolean,renderedCourses?:number,href?:string}} tab 打开的网络学堂标签页里内容脚本的自述
 */
export function decideSession(api, page, tab) {
  // 1) 接口返回 JSON：登录页只会返回 HTML，所以这是最强的“已登录”证据
  if (api && api.kind === 'json') {
    return { loggedIn: true, via: 'api-json', detail: '接口正常返回 JSON，会话有效' };
  }

  // 2) 同源地面证据：内容脚本就跑在站点页面上，它看到课程容器就说明浏览器里的会话是好的。
  //    这一条专门用于一种情况 —— 扩展后台的 fetch 因为 SameSite/权限等原因带不上 cookie，
  //    但用户其实已经登录了。此时不该告诉用户“未登录”。
  if (tab && tab.ok && tab.loggedIn && (tab.hasCourseShell || (tab.renderedCourses || 0) > 0)) {
    const conflict = api && api.kind === 'redirect'
      ? '（注意：扩展后台自己的接口请求被重定向了，说明后台请求可能没带上 cookie，抓取会自动改用页面兜底路径）'
      : '';
    return {
      loggedIn: true,
      via: 'tab',
      detail: `你打开的页面「${tab.title || tab.href}」上渲染出了 ${tab.renderedCourses || 0} 门课程，浏览器里的会话是有效的${conflict}`,
    };
  }

  // 3) 接口被重定向：已登录的会话不会把 /b/ 接口重定向走
  if (api && api.kind === 'redirect') {
    return {
      loggedIn: false,
      via: 'api-redirect',
      detail: `接口被重定向（HTTP ${api.status || '3xx'}），说明会话已失效 —— 需要登录`,
    };
  }

  // 4) 接口返回 HTML 而不是 JSON：未登录时服务器会把登录页直接吐回来
  if (api && api.kind === 'html') {
    return {
      loggedIn: false,
      via: 'api-html',
      detail: '接口返回了 HTML 而不是 JSON（未登录，或站点接口已改版）',
    };
  }

  // 5) 接口不可用（网络问题 / 权限问题），只能看页面
  if (!page) {
    if (tab && tab.ok && tab.hasPasswordInput) {
      return { loggedIn: false, via: 'tab-login', detail: '你打开的页面就是登录页' };
    }
    return { loggedIn: false, via: 'unknown', detail: `无法判断会话状态：${(api && api.reason) || '接口与页面都没有结果'}` };
  }
  if (page.error) {
    return { loggedIn: false, via: 'page-error', detail: `无法访问网络学堂：${page.error}` };
  }
  // 正向证据优先：登录页里不可能出现课程列表的容器
  if (page.hasCourseShell) {
    return { loggedIn: true, via: 'page-shell', detail: '课程列表页里出现了课程容器，会话有效' };
  }
  if (page.hasPasswordInput) {
    return { loggedIn: false, via: 'page-password', detail: '页面里有密码输入框，说明这是登录页' };
  }
  if (page.isLoginUrl) {
    return { loggedIn: false, via: 'page-login-url', detail: `被带到了登录页：${page.finalUrl}` };
  }
  if (page.status === 200) {
    // 注意：这里**不看是否发生过重定向** —— 已登录时站点也会重定向，见上面的说明
    return { loggedIn: true, via: 'page', detail: '课程列表页正常返回，且不像登录页' };
  }
  return { loggedIn: false, via: 'page-status', detail: `课程列表页返回 HTTP ${page.status}` };
}

/** 登录页特征 —— 只认真正的登录提交端点，绝不匹配 /f/j_spring_security_logout */
const LOGIN_PAGE_MARKER = /j_spring_security_check|请输入密码|用户名\s*[:：]|id\.tsinghua\.edu\.cn\/(do\/off|ui\/auth)/i;
const LOGIN_URL_RE = /(\/login|\/sso|iaaa|passport|authserver|id\.tsinghua\.edu\.cn)/i;
/** 课程列表页的“正向证据”：登录页里不可能有这些容器 */
const COURSE_SHELL_RE = /id=["']selfcourse["']|id=["']suoxuecourse["']|id=["']tablist["']|course\/student/i;

/**
 * 把一段页面 HTML 判成结构化特征。纯函数，可以直接拿真实页面片段做单测
 * —— 「退出链接不等于登录页」这条就是这么钉死的。
 */
export function classifyPageHtml(html, finalUrl = '') {
  const text = String(html || '');
  return {
    finalUrl,
    hasPasswordInput: /<input[^>]+type\s*=\s*["']?password/i.test(text),
    isLoginUrl: LOGIN_URL_RE.test(finalUrl || ''),
    hasCourseShell: COURSE_SHELL_RE.test(text),
    marker: (text.match(LOGIN_PAGE_MARKER) || [])[0] || '',
    htmlLength: text.length,
  };
}

/** 探测一个页面（跟随重定向走到底，拿到最终地址与最终 HTML） */
async function probePage(url) {
  try {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
    const html = await res.text();
    return { status: res.status, redirected: res.redirected, ...classifyPageHtml(html, res.url || url) };
  } catch (err) {
    return { error: (err && err.message) || String(err), url };
  }
}

/** 问一下已经打开的网络学堂标签页：在它眼里会话是好的吗？ */
async function probeTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://learn.tsinghua.edu.cn/*' });
    for (const tab of tabs.slice(0, 3)) {
      const res = await chrome.tabs
        .sendMessage(tab.id, { target: 'content', type: 'sessionReport' })
        .catch(() => null);
      if (res && res.ok) {
        return {
          ok: true,
          href: res.href,
          title: res.title,
          hasPasswordInput: res.hasPasswordInput,
          hasCourseShell: res.hasCourseShell,
          renderedCourses: res.renderedCourses,
          cookieNames: res.cookieNames,
          csrfFound: res.csrfFound,
          loggedIn: !res.hasPasswordInput && !LOGIN_URL_RE.test(res.href || ''),
        };
      }
    }
  } catch { /* 没有标签页或内容脚本未就绪都算“没有这一路证据” */ }
  return null;
}

/**
 * 会话探测。以 **JSON 接口为重**、标签页同源证据为佐、页面为辅，
 * 并把每一步的原始证据一并返回，这样面板上的「登录诊断」能把判定过程
 * 原样展示出来，而不是只给一句“未登录”。
 */
export async function checkSession() {
  const csrf = cachedToken() || (await resolveCsrf().catch(() => ''));

  let api = await probeJson(API.currentSemester, { csrf });
  // 带上令牌反被拒时，清掉令牌再试一次（有些会话不需要 / 不接受它）
  if (api.kind !== 'json' && csrf) {
    const retry = await probeJson(API.currentSemester, { csrf: '' });
    if (retry.kind === 'json') api = retry;
  }

  const tab = api.kind === 'json' ? null : await probeTab();
  const page = api.kind === 'json' ? null : await probePage(SITE.COURSE_LIST_URL);
  const decision = decideSession(api, page, tab);

  return {
    ...decision,
    loginUrl: page && page.isLoginUrl ? page.finalUrl : SITE.LOGIN_URL,
    evidence: {
      csrf: csrf ? `有（${tokenSource() || '来源未知'}）` : '没有',
      api: { kind: api.kind, status: api.status, url: api.url, snippet: api.snippet, reason: api.reason },
      tab: tab
        ? {
          href: tab.href, title: tab.title, renderedCourses: tab.renderedCourses,
          hasCourseShell: tab.hasCourseShell, hasPasswordInput: tab.hasPasswordInput,
          cookieNames: tab.cookieNames, csrfFound: tab.csrfFound,
        }
        : '没有打开的网络学堂标签页',
      page: page
        ? {
          status: page.status, finalUrl: page.finalUrl, hasPasswordInput: page.hasPasswordInput,
          isLoginUrl: page.isLoginUrl, hasCourseShell: page.hasCourseShell, error: page.error,
        }
        : '未探测（接口已确认）',
    },
  };
}

/**
 * 登录诊断：把“判定会话”用到的每一步原始证据都摊开。
 *
 * 存在的理由很直接：只告诉用户“未登录”没有任何用。要能回答
 * “我明明登录了，凭什么说我没登录” —— 那就把接口返回了什么、
 * 页面最终落在哪、打开的标签页里看到了什么，全部原样列出来。
 */
export async function diagnoseSession() {
  const report = { at: Date.now(), steps: [] };
  const step = (name, ok, detail) => { report.steps.push({ name, ok: !!ok, detail }); };

  let ssoGranted = false;
  try { ssoGranted = await chrome.permissions.contains(SITE.SSO_PERMISSION); } catch { /* ignore */ }
  step('扩展权限', true,
    `learn.tsinghua.edu.cn：清单内必需权限；id.tsinghua.edu.cn：${ssoGranted ? '已授权' : '未授权（只影响登录页自动填充）'}`);

  let tabReport = null;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://learn.tsinghua.edu.cn/*' });
    if (!tabs.length) {
      step('网络学堂标签页', true, '当前没有打开的网络学堂标签页（不影响抓取，但少了一路证据）');
    } else {
      const res = await chrome.tabs
        .sendMessage(tabs[0].id, { target: 'content', type: 'sessionReport' })
        .catch((e) => ({ ok: false, error: e.message }));
      tabReport = res;
      step('页面自述（来自内容脚本）', res && res.ok,
        res && res.ok
          ? `地址 ${res.href}；标题「${res.title}」；密码框=${res.hasPasswordInput}；课程容器=${res.hasCourseShell}；页面上渲染出的课程数=${res.renderedCourses}；可见 cookie=${(res.cookieNames || []).join(',') || '无'}；能找到 _csrf=${res.csrfFound}`
          : `内容脚本未响应：${(res && res.error) || '未知原因'}`);
    }
  } catch (err) {
    step('网络学堂标签页', false, err.message);
  }

  let csrf = cachedToken();
  if (!csrf) csrf = await resolveCsrf({ force: true }).catch(() => '');
  step('_csrf 令牌', true, csrf ? `已取得（来源：${tokenSource() || '未知'}）` : '没有取到（会先不带令牌请求一次）');

  const api = await probeJson(API.currentSemester, { csrf });
  step('接口探测（会话的权威证据）', api.kind === 'json',
    `结果类型=${api.kind}，HTTP ${api.status}`
    + (api.snippet ? `；响应开头：${api.snippet.slice(0, 80)}` : '')
    + (api.reason ? `；错误：${api.reason}` : ''));

  const page = await probePage(SITE.COURSE_LIST_URL);
  step('课程列表页', !page.error,
    page.error
      ? `请求失败：${page.error}`
      : `HTTP ${page.status}；最终地址 ${page.finalUrl}；密码框=${page.hasPasswordInput}；像登录页=${page.isLoginUrl}；有课程容器=${page.hasCourseShell}`);

  const decision = decideSession(api, page, tabReport);
  report.decision = decision;
  report.loggedIn = decision.loggedIn;
  report.evidence = { csrf: !!csrf, api, page, tab: tabReport };
  return report;
}

/** 当前该去哪里登录（未登录时） */export async function resolveLoginUrl() {
  for (const url of [SITE.COURSE_LIST_URL, SITE.LOGIN_URL]) {
    try {
      const res = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
      if (LOGIN_URL_RE.test(res.url) || /<input[^>]+type=["']?password/i.test(await res.clone().text())) {
        return res.url;
      }
    } catch {
      /* 跟随重定向可能因为缺少目标域权限而失败，忽略 */
    }
  }
  // 跟随重定向拿不到时，直接给用户统一身份认证入口
  return 'https://id.tsinghua.edu.cn/';
}

/**
 * 登录页侦察：把登录页拿回来，用离屏解析器读它自己的表单结构。
 * 目的不是“替用户登录”，而是**如实告诉用户这一页长什么样**——
 * 有没有验证码、账号/密码字段叫什么，这样面板给的提示才不是空话。
 */
async function reconLoginPage(loginUrl) {
  try {
    const res = await fetch(loginUrl, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
    const html = await res.text();
    if (/^\s*\{/.test(html)) return { url: res.url, note: '登录入口返回了 JSON，可能已经是已登录状态' };
    const [info, form] = await Promise.all([parsePageInfo(html, res.url), parseLoginForm(html, res.url)]);
    return {
      url: res.url,
      title: info.title,
      pageKind: info.pageKind,
      hasPasswordField: !!form.form.found,
      hasCaptcha: !!form.form.hasCaptcha,
      usernameField: form.form.usernameField || '',
      passwordField: form.form.passwordField || '',
      ssoLinks: form.form.ssoLinks || [],
      crossOrigin: form.form.crossOrigin || '',
    };
  } catch (err) {
    // 看到最常见的两种情况：没有目标域权限（跨域登录页），或网络不通
    return { url: loginUrl, error: err.message };
  }
}

/**
 * 保证已登录。
 * @returns {Promise<{loggedIn:boolean, method?:string, needsManualLogin?:boolean, loginUrl?:string, message?:string, loginForm?:object}>}
 */
export async function ensureLogin({ force = false } = {}) {
  const settings = await getSettings();

  if (!force) {
    const probe = await checkSession();
    if (probe.loggedIn) {
      await patchSession({ loggedIn: true, needsManualLogin: false, loginUrl: '', lastError: '', loginMethod: probe.via });
      return { loggedIn: true, method: probe.via };
    }
  }

  const loginUrl = await resolveLoginUrl();
  const recon = await reconLoginPage(loginUrl);

  let message = '网络学堂使用学校统一身份认证登录，扩展无法代替你完成登录。点「打开登录页」登录一次，扩展会自动检测到并开始抓取。';
  if (!settings.autoLogin) {
    message = '已关闭「自动填充账号密码」，请手动登录网络学堂。';
  } else if (recon && recon.hasCaptcha) {
    message = '登录页带验证码（统一身份认证），扩展无法代填代过。已保存账号密码的话会帮你填好账号密码，你只需输入验证码。';
  } else if (recon && recon.hasPasswordField) {
    message = '登录页有账号密码表单，扩展可以帮你自动填充，但登录动作仍需你确认。';
  } else if (recon && recon.error) {
    message = `未能读取登录页（${recon.error}）；不影响使用，直接点「打开登录页」手动登录即可。`;
  }

  await patchSession({
    loggedIn: false,
    needsManualLogin: true,
    loginUrl: (recon && recon.url) || loginUrl,
    lastError: '',
    loginForm: recon || null,
  });
  return { loggedIn: false, needsManualLogin: true, loginUrl: (recon && recon.url) || loginUrl, reason: 'sso', message, loginForm: recon };
}

/**
 * 把已保存的账号密码填进统一身份认证的登录表单。
 * 必须由用户在扩展界面点击后调用（chrome.scripting 需要用户手势）。
 */
export async function autofillLoginTab(tabId) {
  const creds = await getCredentials();
  if (!creds.username || !creds.password) {
    return { ok: false, error: '还没有保存账号密码，请先在扩展里填写并勾选「记住密码」' };
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [creds.username, creds.password],
      func: (username, password) => {
        const forms = Array.from(document.querySelectorAll('form'));
        const form = forms.find((f) => f.querySelector('input[type="password"]'));
        if (!form) return { filled: false, reason: '这个页面里没有密码输入框（可能是验证码/扫码页）' };
        const inputs = Array.from(form.querySelectorAll('input'));
        const pwd = inputs.find((i) => (i.getAttribute('type') || '').toLowerCase() === 'password');
        const textish = inputs.filter((i) => {
          const t = (i.getAttribute('type') || 'text').toLowerCase();
          return ['text', 'email', 'tel', 'number'].includes(t);
        });
        const named = textish.find((i) => /user|name|account|zh|yhm|xh/i.test(`${i.name} ${i.id}`));
        const user = named || textish[0];
        const setValue = (el, value) => {
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        if (user) setValue(user, username);
        if (pwd) setValue(pwd, password);
        return { filled: true, userField: user ? (user.name || user.id) : '', pwdField: pwd ? (pwd.name || pwd.id) : '' };
      },
    });
    const result = (injection && injection.result) || {};
    log.info('自动填充结果', result);
    return result.filled ? { ok: true, ...result } : { ok: false, error: result.reason || '没有找到可填充的登录表单' };
  } catch (err) {
    return { ok: false, error: `填充失败：${err.message}（可能需要先授予 id.tsinghua.edu.cn 的访问权限）` };
  }
}

/** 让站点自己注销，然后清掉本地状态 */
export async function logout() {
  try {
    const res = await fetch(new URL('/f/j_spring_security_logout', SITE.ORIGIN).href, {
      credentials: 'include',
      redirect: 'follow',
    });
    log.info('已请求注销', res.status);
  } catch (err) {
    log.warn('注销请求失败（忽略）', err && err.message);
  }
  await patchSession({ loggedIn: false, needsManualLogin: true, loginUrl: '', lastError: '', loginMethod: '', username: '' });
  return { ok: true };
}
