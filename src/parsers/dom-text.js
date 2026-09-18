/**
 * DOM 文本读取的小工具。独立成文件，避免解析器之间互相 import 出环。
 * 这里的所有函数都容忍 null / 非元素节点 —— 解析真实页面时缺节点是常态。
 */

export function textOf(node) {
  if (!node) return '';
  return String(node.textContent == null ? '' : node.textContent)
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 与 textOf 同义，命名更强调“拿不到就返回空串” */
export function textOfSafe(node) {
  try {
    return textOf(node);
  } catch {
    return '';
  }
}

/** 元素自身文本，但不含指定后代（例如排除“下载”按钮的文字） */
export function textOfExcluding(node, selector) {
  if (!node || !node.cloneNode) return '';
  const clone = node.cloneNode(true);
  try {
    for (const junk of clone.querySelectorAll(selector)) junk.remove();
  } catch { /* ignore */ }
  return textOf(clone);
}

export function attr(el, name) {
  if (!el || !el.getAttribute) return '';
  return el.getAttribute(name) || '';
}
