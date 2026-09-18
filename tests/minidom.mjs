/**
 * minidom —— 零依赖的极简 DOM + HTML 解析器。
 *
 * 存在意义：`src/parsers/*` 里的解析器全部是“HTML 字符串 -> 结构化数据”的纯计算，
 * 但它们的入参是浏览器 DOMParser 产出的 Document。本机没有网络、不能装 jsdom，
 * 所以这里手写一个“刚好够用”的 DOM，让这些解析器能在 `node tests/run.mjs` 下被真正执行。
 *
 * 覆盖的 API（解析器实际用到的全部）：
 *   nodeType(1/3/9) / tagName(大写) / nodeName / textContent(getter+setter，递归拼接)
 *   parentNode / parentElement / children / childNodes
 *   getAttribute / setAttribute / removeAttribute / hasAttribute / getAttributeNames
 *   remove() / contains(el) / cloneNode(deep) / matches / closest / querySelector / querySelectorAll
 *
 * 覆盖的选择器子集（与项目里 grep 出来的用法一一对应）：
 *   `a, b`（逗号分组）、空白（后代）、`>`（子元素）、`*`（通配）、`tag`、`.class`、`#id`、
 *   `[attr]`、`[attr="value"]`、`[attr*="value"]`、`:not(.class)`、`:not(tag)`，另外顺手支持
 *   `:first-child` 与 `[attr^=]`/`[attr$=]`/`[attr~=]`/`[attr|=]`。
 *   **其余语法一律抛错**，绝不默默返回空集合 —— 否则解析器“什么都抓不到”会被误判成站点改版。
 *
 * 有意贴近真实浏览器的行为：
 *   - `<table><tr>` 中间的隐式 `<tbody>`（`table tbody tr` 与 `table tr` 必须同时可用）
 *   - script/style 是 raw text、textarea/title 是 RCDATA（前两者不解码实体，后两者解码）
 *   - void 元素、注释、未闭合标签、各种属性写法、常见实体
 */

/* ------------------------------------------------------------------ 常量 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** raw text：内容原样保留，不解码实体、不当标记解析 */
const RAWTEXT_TAGS = new Set(['script', 'style']);
/** RCDATA：内容不当标记解析，但要解码实体 */
const RCDATA_TAGS = new Set(['textarea', 'title']);

/** 隐式 head 里的元素：出现在 <head> 之前时归到 head */
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'base', 'style', 'script', 'noscript', 'template']);

/** 起始标签出现时应当先闭合的已打开标签（容忍 tag soup） */
const AUTO_CLOSE = {
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  p: new Set(['p']),
  option: new Set(['option']),
  optgroup: new Set(['optgroup', 'option']),
  thead: new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th']),
  tbody: new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th']),
  tfoot: new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th']),
  tr: new Set(['tr', 'td', 'th']),
  td: new Set(['td', 'th']),
  th: new Set(['td', 'th']),
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', bull: '\u2022',
  times: '\u00d7', divide: '\u00f7', laquo: '\u00ab', raquo: '\u00bb',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  deg: '\u00b0', sect: '\u00a7', para: '\u00b6', plusmn: '\u00b1',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
  sup2: '\u00b2', sup3: '\u00b3', frac12: '\u00bd', yen: '\u00a5', euro: '\u20ac',
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** 解码 HTML 实体（至少覆盖 &amp; &lt; &gt; &quot; &#39; &nbsp;） */
export function decodeEntities(str) {
  return String(str == null ? '' : str).replace(ENTITY_RE, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole;
  });
}

/* ------------------------------------------------------------- 节点类 */

class MiniNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get nodeName() {
    return this.nodeType === 3 ? '#text' : '#node';
  }

  get textContent() {
    if (this.nodeType === 3) return this.data;
    let out = '';
    for (const c of this.childNodes) out += c.nodeType === 3 ? c.data : c.textContent;
    return out;
  }

  set textContent(value) {
    if (this.nodeType === 3) { this.data = String(value == null ? '' : value); return; }
    for (const c of this.childNodes.slice()) c.parentNode = null;
    this.childNodes = [];
    const text = String(value == null ? '' : value);
    if (text) this.appendChild(new MiniText(text, this.ownerDocument || null));
  }

  appendChild(node) {
    if (!node) throw new TypeError('mini-dom: appendChild(null)');
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  contains(other) {
    if (!other) return false;
    let n = other;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  remove() {
    if (!this.parentNode) return this;
    const list = this.parentNode.childNodes;
    const i = list.indexOf(this);
    if (i >= 0) list.splice(i, 1);
    this.parentNode = null;
    return this;
  }

  cloneNode(deep = false) {
    if (this.nodeType === 3) return new MiniText(this.data, this.ownerDocument || null);
    /* 子类实现 */
    throw new Error('mini-dom: cloneNode 未实现');
  }

  querySelector(selector) {
    return queryAll(this, selector, true);
  }

  querySelectorAll(selector) {
    return queryAll(this, selector, false);
  }

  matches(selector) {
    if (this.nodeType !== 1) return false;
    return parseSelector(selector).some((seq) => matchesSeq(this, seq));
  }

  closest(selector) {
    const groups = parseSelector(selector);
    let node = this;
    while (node && node.nodeType === 1) {
      if (groups.some((seq) => matchesSeq(node, seq))) return node;
      node = node.parentElement;
    }
    return null;
  }
}

class MiniText extends MiniNode {
  constructor(data, ownerDocument = null) {
    super(3);
    this.data = String(data == null ? '' : data);
    this.ownerDocument = ownerDocument;
  }

  get nodeName() { return '#text'; }
  get nodeValue() { return this.data; }
  get tagName() { return undefined; }

  cloneNode() { return new MiniText(this.data, this.ownerDocument); }

  toString() { return this.data; }
}

class MiniElement extends MiniNode {
  constructor(tagName, ownerDocument = null) {
    super(1);
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this._attrs = new Map(); // lower-case name -> { name, value }
  }

  get nodeName() { return this.tagName; }

  getAttribute(name) {
    const entry = this._attrs.get(String(name).toLowerCase());
    return entry ? entry.value : null;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this._attrs.set(key, { name: String(name), value: String(value == null ? '' : value) });
  }

  removeAttribute(name) { this._attrs.delete(String(name).toLowerCase()); }

  hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }

  getAttributeNames() { return Array.from(this._attrs.values(), (a) => a.name); }

  get id() { return this.getAttribute('id') || ''; }

  get className() { return this.getAttribute('class') || ''; }

  cloneNode(deep = false) {
    const el = new MiniElement(this.tagName, this.ownerDocument);
    for (const { name, value } of this._attrs.values()) el.setAttribute(name, value);
    if (deep) for (const c of this.childNodes) el.appendChild(c.cloneNode(true));
    return el;
  }

  toString() { return `<${this.tagName.toLowerCase()}>`; }
}

class MiniDocument extends MiniNode {
  constructor(url = '') {
    super(9);
    this.__baseUrl = url;
    this.URL = url;
  }

  get nodeName() { return '#document'; }

  createElement(tag) { return new MiniElement(tag, this); }

  createTextNode(data) { return new MiniText(data, this); }

  get documentElement() {
    return this.childNodes.find((n) => n.nodeType === 1 && n.tagName === 'HTML') || null;
  }

  _inHeadOrBody(name) {
    const root = this.documentElement;
    if (!root) return null;
    return root.childNodes.find((n) => n.nodeType === 1 && n.tagName === name) || null;
  }

  get head() { return this._inHeadOrBody('HEAD'); }

  get body() { return this._inHeadOrBody('BODY'); }

  cloneNode() { throw new Error('mini-dom: 不支持克隆 Document'); }
}

/* ---------------------------------------------------------- 选择器引擎 */

const selectorCache = new Map();

function unsupported(selector, detail) {
  return new Error(`mini-dom: 不支持的 CSS 选择器 ${JSON.stringify(String(selector))} —— ${detail}`);
}

/** 按顶层分隔符切分（忽略括号 / 方括号 / 引号内的分隔符） */
function splitTopLevel(input, sep) {
  const out = [];
  let depth = 0;
  let quote = '';
  let buf = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 把一条复杂选择器切成 [compound, comb, compound, ...] */
function tokenizeComplex(input) {
  const items = [];
  let cur = '';
  let sawSpace = false;
  const flush = () => {
    if (cur) { items.push({ type: 'compound', value: cur }); cur = ''; }
  };
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '(') {
      const start = i;
      let depth = 0;
      while (i < input.length) {
        if (input[i] === '(') depth++;
        else if (input[i] === ')') { depth--; i++; if (depth === 0) break; continue; }
        i++;
      }
      cur += input.slice(start, i);
      sawSpace = false;
      continue;
    }
    if (/\s/.test(c)) { sawSpace = true; i++; continue; }
    if (c === '>') {
      flush();
      items.push({ type: 'comb', value: '>' });
      sawSpace = false;
      i++;
      continue;
    }
    if (sawSpace) {
      flush();
      if (items.length && items[items.length - 1].type !== 'comb') items.push({ type: 'comb', value: ' ' });
      sawSpace = false;
    }
    cur += c;
    i++;
  }
  flush();
  while (items.length && items[0].type === 'comb') items.shift();
  while (items.length && items[items.length - 1].type === 'comb') items.pop();
  return items;
}

function parseAttributeTest(spec, selector) {
  const m = /^\s*([\w:.-]+)\s*(?:([*^$~|!]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*)?$/.exec(spec);
  if (!m) throw unsupported(selector, `无法解析属性选择器 [${spec}]`);
  const name = m[1];
  const op = m[2] || '';
  let value = '';
  if (op) {
    value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : '');
    value = value.replace(/\\(.)/g, '$1');
  }
  return { name, op, value };
}

function parseCompound(input, selector) {
  const compound = { tag: null, id: null, classes: [], attrs: [], nots: [], firstChild: false };
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '*') {
      if (compound.tag) throw unsupported(selector, '一个 compound 里出现了两个标签名');
      compound.tag = '*';
      i++;
      continue;
    }
    if (c === '#') {
      const m = /^#([\w-]+)/.exec(input.slice(i));
      if (!m) throw unsupported(selector, `# 后面缺少合法 id：${input}`);
      compound.id = m[1];
      i += m[0].length;
      continue;
    }
    if (c === '.') {
      const m = /^\.([\w-]+)/.exec(input.slice(i));
      if (!m) throw unsupported(selector, `. 后面缺少合法类名：${input}`);
      compound.classes.push(m[1]);
      i += m[0].length;
      continue;
    }
    if (c === '[') {
      const m = /^\[([^\]]*)\]/.exec(input.slice(i));
      if (!m) throw unsupported(selector, `属性选择器缺少 ]：${input}`);
      compound.attrs.push(parseAttributeTest(m[1], selector));
      i += m[0].length;
      continue;
    }
    if (c === ':') {
      const rest = input.slice(i);
      let m;
      if ((m = /^::?[a-zA-Z-]+\(([^)]*)\)/.exec(rest))) {
        const fn = /^::?([a-zA-Z-]+)\(/.exec(rest)[1].toLowerCase();
        if (fn !== 'not') throw unsupported(selector, `不支持伪类函数 :${fn}()`);
        compound.nots.push(parseCompound(m[1].trim(), selector));
        i += m[0].length;
        continue;
      }
      if ((m = /^::?([a-zA-Z-]+)/.exec(rest))) {
        const name = m[1].toLowerCase();
        if (name === 'first-child') { compound.firstChild = true; i += m[0].length; continue; }
        throw unsupported(selector, `不支持伪类 :${name}`);
      }
      throw unsupported(selector, `无法解析的选择器片段 ${input}`);
    }
    const m = /^[a-zA-Z][\w-]*/.exec(input.slice(i));
    if (m) {
      if (compound.tag) throw unsupported(selector, '一个 compound 里出现了两个标签名');
      compound.tag = m[0].toLowerCase();
      i += m[0].length;
      continue;
    }
    throw unsupported(selector, `位置 ${i} 处的字符无法解析：${JSON.stringify(c)}`);
  }
  if (!compound.tag && !compound.id && !compound.classes.length && !compound.attrs.length
    && !compound.nots.length && !compound.firstChild) {
    throw unsupported(selector, `空的 compound："${input}"`);
  }
  return compound;
}

function parseComplex(input, selector) {
  const items = tokenizeComplex(input);
  const seq = [];
  let pending = null;
  for (const item of items) {
    if (item.type === 'comb') { pending = item.value; continue; }
    seq.push({ combinator: seq.length ? (pending || ' ') : null, compound: parseCompound(item.value, selector) });
    pending = null;
  }
  if (!seq.length) throw unsupported(selector, '空选择器');
  return seq;
}

function parseSelector(selector) {
  const key = String(selector);
  const cached = selectorCache.get(key);
  if (cached) return cached;
  const groups = splitTopLevel(key, ',').map((g) => parseComplex(g, key));
  if (!groups.length) throw unsupported(key, '空选择器');
  selectorCache.set(key, groups);
  return groups;
}

function classListOf(el) {
  const raw = el.getAttribute('class');
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function matchCompound(el, compound) {
  if (el.nodeType !== 1) return false;
  if (compound.tag && compound.tag !== '*' && el.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.id && el.getAttribute('id') !== compound.id) return false;
  if (compound.classes.length) {
    const list = classListOf(el);
    for (const c of compound.classes) if (!list.includes(c)) return false;
  }
  for (const test of compound.attrs) {
    const value = el.getAttribute(test.name);
    if (value === null) return false;
    if (!test.op) continue;
    switch (test.op) {
      case '=': if (value !== test.value) return false; break;
      case '*=': if (!value.includes(test.value)) return false; break;
      case '^=': if (!value.startsWith(test.value)) return false; break;
      case '$=': if (!value.endsWith(test.value)) return false; break;
      case '~=': if (!value.split(/\s+/).includes(test.value)) return false; break;
      case '|=': if (value !== test.value && !value.startsWith(`${test.value}-`)) return false; break;
      case '!=': if (value === test.value) return false; break;
      default: return false;
    }
  }
  for (const not of compound.nots) {
    if (matchCompound(el, not)) return false;
  }
  if (compound.firstChild) {
    const parent = el.parentElement;
    if (!parent || parent.children[0] !== el) return false;
  }
  return true;
}

function matchesSeq(el, seq) {
  const last = seq[seq.length - 1];
  if (!matchCompound(el, last.compound)) return false;
  let node = el;
  for (let k = seq.length - 2; k >= 0; k--) {
    const combinator = seq[k + 1].combinator;
    const compound = seq[k].compound;
    if (combinator === '>') {
      node = node.parentElement;
      if (!node || !matchCompound(node, compound)) return false;
    } else {
      let p = node.parentElement;
      while (p && !matchCompound(p, compound)) p = p.parentElement;
      if (!p) return false;
      node = p;
    }
  }
  return true;
}

function queryAll(root, selector, firstOnly) {
  const groups = parseSelector(selector);
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (groups.some((seq) => matchesSeq(child, seq))) {
        out.push(child);
        if (firstOnly) return true;
      }
      if (walk(child) && firstOnly) return true;
    }
    return false;
  };
  walk(root);
  return firstOnly ? (out[0] || null) : out;
}

/* ------------------------------------------------------------ HTML 解析 */

/** 找到标签结束的 `>`（跳过引号内的） */
function findTagEnd(s, from) {
  let quote = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;

function parseAttributes(source) {
  const out = [];
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source))) {
    const name = m[1];
    const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : '');
    out.push([name, decodeEntities(raw)]);
  }
  return out;
}

function findRawClose(source, from, tag) {
  const idx = source.toLowerCase().indexOf(`</${tag}`, from);
  return idx;
}

/**
 * 解析 HTML 片段 / 整页。
 * @param {string} html
 * @param {string} url 页面地址（仅记录到 document.__baseUrl）
 * @returns {MiniDocument}
 */
export function parseHTML(html, url = '') {
  const source = String(html == null ? '' : html);
  const doc = new MiniDocument(String(url || ''));

  const htmlEl = doc.createElement('html');
  const headEl = doc.createElement('head');
  const bodyEl = doc.createElement('body');
  doc.appendChild(htmlEl);
  htmlEl.appendChild(headEl);
  htmlEl.appendChild(bodyEl);

  const stack = [doc, htmlEl];
  let bodyStarted = false;

  const top = () => stack[stack.length - 1];

  /**
   * 决定新节点挂到哪儿。处于“文档根 / html”层级时，按浏览器的做法分配到 head 或 body。
   * push=false 用于自包含的元素（raw text、void），它们不需要把自己留在打开标签栈上 ——
   * 否则文档开头的 <script> 会把 head 一直留在栈顶，后面的 <div> 就全被塞进 head 了。
   */
  function containerFor(tag, push = true) {
    const t = top();
    if (t === doc || t === htmlEl) {
      if (!bodyStarted && HEAD_TAGS.has(tag)) {
        if (push) stack.push(headEl);
        return headEl;
      }
      bodyStarted = true;
      if (push) stack.push(bodyEl);
      return bodyEl;
    }
    return t;
  }

  function mergeAttrs(el, attrs) {
    for (const [n, v] of attrs) el.setAttribute(n, v);
  }

  function startTag(tag, attrs, selfClosing) {
    if (tag === 'html') {
      mergeAttrs(htmlEl, attrs);
      stack.length = 0;
      stack.push(doc, htmlEl);
      return;
    }
    if (tag === 'head') {
      mergeAttrs(headEl, attrs);
      stack.length = 0;
      stack.push(doc, htmlEl, headEl);
      return;
    }
    if (tag === 'body') {
      mergeAttrs(bodyEl, attrs);
      bodyStarted = true;
      stack.length = 0;
      stack.push(doc, htmlEl, bodyEl);
      return;
    }

    const autoClose = AUTO_CLOSE[tag];
    if (autoClose) {
      while (stack.length > 1 && stack[stack.length - 1].tagName
        && autoClose.has(stack[stack.length - 1].tagName.toLowerCase())) {
        stack.pop();
      }
    }

    let parent = containerFor(tag);

    // 真实浏览器会把直接挂在 <table> 下的 <tr> 塞进隐式 <tbody>
    if (tag === 'tr' && parent.tagName === 'TABLE') {
      const tbody = doc.createElement('tbody');
      parent.appendChild(tbody);
      stack.push(tbody);
      parent = tbody;
    }

    const el = doc.createElement(tag);
    for (const [n, v] of attrs) el.setAttribute(n, v);
    parent.appendChild(el);

    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(el);
  }

  function endTag(tag) {
    for (let k = stack.length - 1; k >= 1; k--) {
      const el = stack[k];
      if (el.tagName && el.tagName.toLowerCase() === tag) { stack.length = k; return; }
    }
    // 找不到对应开标签就忽略（tag soup 的常态）
  }

  function addText(raw) {
    if (!raw) return;
    const container = containerFor('');
    container.appendChild(doc.createTextNode(decodeEntities(raw)));
  }

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) { addText(source.slice(i)); break; }
    if (lt > i) addText(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end < 0 ? source.length : end).trim().replace(/\/$/, '').toLowerCase();
      if (name) endTag(name);
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    const tagEnd = findTagEnd(source, lt + 1);
    const inner = source.slice(lt + 1, tagEnd < 0 ? source.length : tagEnd);
    i = tagEnd < 0 ? source.length : tagEnd + 1;

    const nameMatch = /^\s*([a-zA-Z][^\s/>]*)/.exec(inner);
    if (!nameMatch) continue; // `< 3` 这类裸尖括号，当文本处理更接近浏览器；这里直接忽略
    const tag = nameMatch[1].toLowerCase();
    const rest = inner.slice(nameMatch[0].length);
    const selfClosing = /\/\s*$/.test(rest);
    const attrs = parseAttributes(selfClosing ? rest.replace(/\/\s*$/, '') : rest);

    if (RAWTEXT_TAGS.has(tag) || RCDATA_TAGS.has(tag)) {
      const closeIdx = findRawClose(source, i, tag);
      const raw = closeIdx < 0 ? source.slice(i) : source.slice(i, closeIdx);
      const parent = containerFor(tag, false);
      const el = doc.createElement(tag);
      for (const [n, v] of attrs) el.setAttribute(n, v);
      parent.appendChild(el);
      if (raw) {
        el.appendChild(doc.createTextNode(RAWTEXT_TAGS.has(tag) ? raw : decodeEntities(raw)));
      }
      if (closeIdx < 0) break;
      const gt = source.indexOf('>', closeIdx);
      i = gt < 0 ? source.length : gt + 1;
      continue;
    }

    startTag(tag, attrs, selfClosing);
  }

  return doc;
}
