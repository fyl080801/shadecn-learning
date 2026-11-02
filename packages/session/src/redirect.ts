/**
 * `?redirect=` 只认站内路径，其余回 `/`。语义同 `@shadecn/mod-auth` 的 safeRedirect，多挡一类：
 * 带控制字符的（`/<TAB>/evil.com`：Node 允许响应头里有 TAB，浏览器解析 URL 时会把它删掉，就成了 `//evil.com`）。
 * 非 ASCII 和空格转义后再用，否则写进 Location 时 Node 抛 ERR_INVALID_CHAR。
 * `@learning/web` 有同样的一份：这两个包互不依赖，用例表各自钉着。
 */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/')) return '/'
  if (target.startsWith('//') || target.startsWith('/\\')) return '/'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(target)) return '/'
  return target.replace(/[^!-~]+/g, encodeURIComponent)
}
