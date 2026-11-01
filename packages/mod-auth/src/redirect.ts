/**
 * 所有 `?redirect=` 的统一收口 —— 登录入口、OIDC 回调、页面闸门都用它。
 * 只允许站内路径，挡掉 open redirect（//evil.com、/\evil.com 都回落到 /）。
 */
export function safeRedirect(target: string | null | undefined): string {
  if (!target || !target.startsWith('/')) return '/'
  if (target.startsWith('//') || target.startsWith('/\\')) return '/'
  return target
}
