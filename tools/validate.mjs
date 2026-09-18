/**
 * 静态完整性校验（零依赖）。
 *
 * 加载扩展前跑一遍，能挡掉最常见的“一装就报错”：
 *   1) manifest.json 里引用的文件是否都存在
 *   2) 所有 ES module 的相对 import 是否都能解析到真实文件
 *   3) HTML 里引用的 css/js 是否存在
 *   4) UI 脚本里 $('#id') / getElementById 用到的 id，是否真的写在对应 HTML 里
 *      —— 这是最容易漏、又一定会在运行时炸的一类错误
 *   5) 消息协议是否对齐：UI 发的 MSG.* 在 Service Worker 里都有 handler，反之亦然
 *
 * 用法：node tools/validate.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];
let checks = 0;

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => readFileSync(p, 'utf8');

function walk(dir, filter, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      walk(full, filter, out);
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

function check(cond, message) {
  checks += 1;
  if (!cond) problems.push(message);
}

/* ---------------------- 1. manifest 引用的文件 ---------------------- */

const manifestPath = join(ROOT, 'manifest.json');
check(existsSync(manifestPath), 'manifest.json 不存在');
const manifest = JSON.parse(read(manifestPath));

const referenced = [];
const visitManifest = (node, path) => {
  if (typeof node === 'string') {
    if (/\.(js|css|html|png|json)$/i.test(node) && !node.startsWith('http')) referenced.push({ file: node, where: path });
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => visitManifest(v, `${path}[${i}]`));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) visitManifest(v, `${path}.${k}`);
  }
};
visitManifest(manifest, 'manifest');
for (const { file, where } of referenced) {
  // web_accessible_resources 允许写 glob，那不是文件路径
  if (file.includes('*')) continue;
  check(existsSync(join(ROOT, file)), `manifest 引用了不存在的文件：${file}（${where}）`);
}

check(manifest.manifest_version === 3, 'manifest_version 必须是 3');
check(Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0, '缺少 host_permissions');

/* --------------------------- 2. import 解析 --------------------------- */

const jsFiles = walk(join(ROOT, 'src'), (f) => f.endsWith('.js'));
const importRe = /(?:^|\n)\s*import\s*(?:\{([^}]*)\}|(\w+))?\s*(?:from\s*)?['"]([^'"]+)['"]/g;

/** 收集一个模块对外暴露的具名导出 */
function exportsOf(file) {
  const text = read(file);
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default');
  return names;
}

const exportCache = new Map();
function exportsFor(file) {
  if (!exportCache.has(file)) exportCache.set(file, exportsOf(file));
  return exportCache.get(file);
}

for (const file of jsFiles) {
  const text = read(file);
  importRe.lastIndex = 0;
  let m;
  while ((m = importRe.exec(text))) {
    const [, named, , spec] = m;
    if (!spec.startsWith('.')) {
      problems.push(`${rel(file)} 引用了裸模块 ${spec}（本项目零依赖，不应出现）`);
      checks += 1;
      continue;
    }
    const target = resolve(dirname(file), spec);
    check(existsSync(target), `${rel(file)} 的 import 解析不到文件：${spec}`);
    if (!existsSync(target) || !named) continue;

    // 具名导入必须真的存在 —— 少了这一层，写错导出名会在浏览器里直接炸掉整个模块
    const available = exportsFor(target);
    for (const part of named.split(',')) {
      const raw = part.trim();
      if (!raw) continue;
      const imported = raw.split(/\s+as\s+/)[0].trim();
      if (!imported || imported.startsWith('type ')) continue;
      check(
        available.has(imported),
        `${rel(file)} 从 ${spec} 导入了 '${imported}'，但该模块没有这个导出`,
      );
    }
  }
}

/* ------------------------- 3. HTML 里的资源 ------------------------- */

const htmlFiles = walk(ROOT, (f) => f.endsWith('.html') && !rel(f).startsWith('tests/'));
for (const file of htmlFiles) {
  const html = read(file);
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const target = m[1];
    if (/^(https?:|data:|#|mailto:)/.test(target)) continue;
    check(existsSync(resolve(dirname(file), target)), `${rel(file)} 引用了不存在的资源：${target}`);
  }
}

/* ------------------- 4. UI 脚本用到的 DOM id ------------------- */

const PAIRS = [
  ['src/dashboard/dashboard.js', 'src/dashboard/dashboard.html'],
  ['src/popup/popup.js', 'src/popup/popup.html'],
];

for (const [jsRel, htmlRel] of PAIRS) {
  const js = read(join(ROOT, jsRel));
  const html = read(join(ROOT, htmlRel));
  const htmlIds = new Set([...html.matchAll(/\sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of js.matchAll(/\$\(\s*'#([A-Za-z][\w-]*)'\s*\)/g)) used.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) used.add(m[1]);
  for (const id of used) {
    check(htmlIds.has(id), `${jsRel} 里用到了 #${id}，但 ${htmlRel} 中没有这个 id`);
  }
  notes.push(`${jsRel}: 使用 ${used.size} 个 DOM id，${htmlRel} 定义了 ${htmlIds.size} 个`);
}

/* ------------------- 5. 消息协议一致性 ------------------- */

const constants = read(join(ROOT, 'src/common/constants.js'));
const msgBlock = constants.match(/export const MSG = \{([\s\S]*?)\};/);
check(!!msgBlock, 'constants.js 里找不到 MSG 定义');
const MSG = {};
if (msgBlock) {
  for (const m of msgBlock[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) MSG[m[1]] = m[2];
}

const swText = read(join(ROOT, 'src/background/service-worker.js'));
const handled = new Set([...swText.matchAll(/\[MSG\.(\w+)\]/g)].map((m) => m[1]));

for (const [name, value] of Object.entries(MSG)) {
  const senders = jsFiles.filter(
    (f) => !f.endsWith('service-worker.js') && !f.endsWith('constants.js') && new RegExp(`MSG\\.${name}\\b`).test(read(f)),
  );
  if (senders.length) {
    check(handled.has(name), `常量 MSG.${name}('${value}') 在 UI 侧被发送，但 Service Worker 里没有对应 handler`);
  } else if (!handled.has(name)) {
    notes.push(`MSG.${name}('${value}') 既没有被发送也没有被处理（可能是残留常量）`);
  }
}
for (const name of handled) {
  check(name in MSG, `Service Worker 处理了 MSG.${name}，但 constants.js 里没有这个常量`);
}
notes.push(`消息协议：定义 ${Object.keys(MSG).length} 个，Service Worker 处理 ${handled.size} 个`);

/* --------------------------- 6. 权限白名单 --------------------------- */

const KNOWN = new Set(['storage', 'tabs', 'alarms', 'offscreen', 'scripting', 'cookies', 'notifications', 'activeTab']);
for (const p of manifest.permissions || []) {
  check(KNOWN.has(p), `manifest 里出现了预期外的权限：${p}（请确认是有意添加）`);
}

/* ------------------------------ 输出 --------------------------------- */

console.log('=== THU Learn Dashboard 静态校验 ===\n');
console.log(`检查项：${checks}`);
for (const n of notes) console.log(`· ${n}`);
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exitCode = 1;
} else {
  console.log('\n✓ 全部通过');
}
