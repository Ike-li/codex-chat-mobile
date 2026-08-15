// text-utils.js —— 共享文本工具函数

/**
 * 截断字符串到指定长度，超长时附加截断标记。
 * @param {string} value
 * @param {number} cap
 * @param {string} [suffix=' …（已截断）']
 * @returns {string}
 */
export function truncate(value, cap, suffix = ' …（已截断）') {
  if (typeof value !== 'string') return '';
  return value.length > cap ? value.slice(0, cap) + suffix : value;
}
