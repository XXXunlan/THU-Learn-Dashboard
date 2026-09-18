/**
 * 登录表单识别。
 *
 * 关键决定：**不写死登录接口**。
 * 网络学堂不同时期用过本地表单（j_username/j_password 之类）和统一身份认证跳转，
 * 与其猜接口，不如把登录页拿回来读它自己的 <form>：action、method、隐藏域（csrf）、
 * 哪个字段是账号、哪个是密码 —— 全部现场识别。这样站点换登录实现也不用改代码。
 */

import { squash, absolutize } from '../common/utils.js';

const USERNAME_HINT = /(user|username|account|login|uid|zh|yhm|xh|学号|账号|用户名|name)/i;
const PASSWORD_HINT = /(pass|pwd|mm|密码)/i;
const CAPTCHA_HINT = /(captcha|verify|checkcode|vcode|authcode|validate|code|验证码)/i;
const SUBMIT_HINT = /(submit|login|登录)/i;
const TEXT_INPUT_TYPES = new Set(['text', 'email', 'tel', 'number', 'search', '']);

function fieldInfo(el) {
  const name = el.getAttribute('name') || '';
  const id = el.getAttribute('id') || '';
  return {
    tag: (el.tagName || '').toLowerCase(),
    type: (el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : 'text')).toLowerCase(),
    name,
    id,
    placeholder: el.getAttribute('placeholder') || '',
    value: el.getAttribute('value') || '',
    checked: el.hasAttribute('checked'),
    disabled: el.hasAttribute('disabled'),
    key: name || id,
  };
}

function isTextish(f) {
  if (f.tag === 'textarea') return false;
  if (f.tag === 'select') return false;
  return TEXT_INPUT_TYPES.has(f.type);
}

function nearbyCaptchaImage(form, input) {
  // 验证码输入框附近是否有图片；没有图片也可能只是“手机验证码”
  const parent = input.parentElement;
  if (!parent) return false;
  return !!parent.querySelector('img, canvas, svg');
}

/**
 * @param {Document} doc
 * @param {string} baseUrl 页面地址（form.action 为空时用它兜底）
 */
export function analyzeLoginForm(doc, baseUrl) {
  const forms = Array.from(doc.querySelectorAll('form'));
  const result = {
    found: false,
    reason: '',
    action: '',
    method: 'post',
    fields: [],
    usernameField: '',
    passwordField: '',
    submitField: '',
    hasCaptcha: false,
    crossOrigin: '',
    ssoLinks: [],
    allForms: forms.length,
  };

  // 统一身份认证入口（页面自己给的）——用于“自动登录不行就引导用户去 SSO”
  result.ssoLinks = Array.from(doc.querySelectorAll('a[href]'))
    .map((a) => absolutize(a.getAttribute('href'), baseUrl))
    .filter((h) => /(id|sso|login)\.tsinghua\.edu\.cn|iaaa|统一身份认证|sso/i.test(h))
    .slice(0, 3);

  let chosen = null;
  let chosenPwd = null;
  for (const form of forms) {
    const pwd = Array.from(form.querySelectorAll('input')).find((i) => (i.getAttribute('type') || '').toLowerCase() === 'password');
    if (pwd) { chosen = form; chosenPwd = pwd; break; }
  }

  if (!chosen) {
    result.reason = forms.length
      ? '页面上有表单，但没有密码输入框（可能是统一身份认证或二维码登录）'
      : '页面上没有 <form>（可能是前端渲染的登录页）';
    return result;
  }

  result.found = true;
  result.reason = 'ok';
  const rawAction = chosen.getAttribute('action') || '';
  result.action = absolutize(rawAction || baseUrl, baseUrl);
  result.method = (chosen.getAttribute('method') || 'post').toLowerCase();
  try {
    const a = new URL(result.action);
    const b = new URL(baseUrl);
    if (a.origin !== b.origin) result.crossOrigin = a.origin;
  } catch { /* ignore */ }

  const controls = Array.from(chosen.querySelectorAll('input, select, textarea'));
  result.fields = controls.map(fieldInfo).filter((f) => f.key);

  const pwdIdx = controls.indexOf(chosenPwd);
  // 表单提交只认 name，没有 name 的控件提交上去也没用，所以这里只取 name
  result.passwordField = chosenPwd.getAttribute('name') || '';
  result.passwordSelector = result.passwordField || chosenPwd.getAttribute('id') || '';

  const textFields = controls
    .map((el, idx) => ({ el, idx, f: fieldInfo(el) }))
    .filter(({ f }) => isTextish(f) && !f.disabled);

  // 1) 名字里带账号语义的优先
  let pick = textFields.find(({ f }) => (f.name && USERNAME_HINT.test(f.name)) || USERNAME_HINT.test(f.id));
  // 2) 其次取密码框前面最近的一个文本输入
  if (!pick) {
    const before = textFields.filter(({ idx }) => idx >= 0 && idx < pwdIdx);
    pick = before.length ? before[before.length - 1] : textFields[0];
  }
  result.usernameField = pick ? pick.f.name : '';
  result.usernameSelector = pick ? (pick.f.name || pick.f.id) : '';
  result.submittable = !!(result.usernameField && result.passwordField);

  const captcha = textFields.find(({ f }) => CAPTCHA_HINT.test(f.name) || CAPTCHA_HINT.test(f.id));
  if (captcha) {
    result.hasCaptcha = true;
    result.captchaField = captcha.f.name || captcha.f.id;
    result.captchaLikelyImage = nearbyCaptchaImage(chosen, captcha.el);
  }

  const submit = controls.find((el) => {
    const t = (el.getAttribute('type') || '').toLowerCase();
    const v = `${el.getAttribute('value') || ''} ${el.getAttribute('name') || ''}`;
    return (t === 'submit' || el.tagName === 'BUTTON') && (SUBMIT_HINT.test(v) || t === 'submit');
  });
  if (submit) result.submitField = submit.getAttribute('name') || '';
  result.submitValue = submit ? (submit.getAttribute('value') || '') : '';

  return result;
}

/** 判断当前页面是否已经是登录后的状态 */
export function looksLoggedIn(doc, url) {
  const u = String(url || '');
  if (/(\/login|\/sso|iaaa|passport|authserver)/i.test(u)) return false;
  if (doc.querySelector('input[type="password"]')) return false;
  const t = squash((doc.body && doc.body.textContent) || '').slice(0, 3000);
  if (/用户名|请输入密码|登录失败|账号或密码错误/.test(t) && !/退出|注销/.test(t)) return false;
  return /退出|注销|我的课程|课程列表|网络学堂/.test(t) || /\/f\/wlxt\//.test(u);
}

/**
 * 从一组候选 URL 里挑出最像登录页的那个（重定向链上可能有中转页）
 */
export function pickLoginUrl(candidates, finalUrl) {
  const list = (candidates || []).filter(Boolean);
  const explicit = list.find((u) => /\/f\/login|\/login|iaaa|id\.tsinghua|sso/i.test(u));
  return explicit || finalUrl || '';
}
