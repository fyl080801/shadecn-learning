import { authEnabled } from '../config.ts'

/**
 * 服务端渲染的登录页。
 *
 * 刻意做成一份自包含的 HTML：不带 bundle、不带 Vite client、不请求 /api/*。
 * 匿名访问者能看到这个页面，但拿不到 SPA 的任何一个字节。
 */
export interface LoginPageOptions {
  /** Keycloak 回来之后跳哪儿，调用方已经过滤过 */
  redirect: string
  /** OIDC 回调失败时带回来的原因（?error=） */
  error?: string
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(raw: string) {
  return raw.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

export function renderLoginPage({ redirect, error }: LoginPageOptions): string {
  const loginHref = `/api/auth/login?redirect=${encodeURIComponent(redirect)}`

  const errorBanner = error
    ? `<p class="banner banner-error" role="alert">${escapeHtml(error)}</p>`
    : ''

  // 没配 Keycloak 时按钮点了也只会 503，不如直接说明白
  const disabledNotice = authEnabled
    ? ''
    : `<p class="banner banner-warn">服务端没有配置 Keycloak（KEYCLOAK_ISSUER / KEYCLOAK_CLIENT_ID），登录不可用。</p>`

  const action = authEnabled
    ? `<a class="button" href="${loginHref}" rel="nofollow">使用 Keycloak 登录</a>`
    : `<span class="button button-disabled" aria-disabled="true">使用 Keycloak 登录</span>`

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>登录</title>
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <style>${STYLES}</style>
  </head>
  <body>
    <main class="card">
      <div class="badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
          <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
        </svg>
      </div>
      <h1>登录</h1>
      <p class="subtitle">用 Keycloak 账号继续</p>
      ${errorBanner}
      ${disabledNotice}
      ${action}
      <p class="hint">会跳到 Keycloak 完成认证，再带着会话跳回来</p>
    </main>
  </body>
</html>
`
}

/** 样式必须内联：这个页面要在「任何静态资源都还不许取」的前提下渲染出来 */
const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: oklch(0.985 0 0);
    --card: oklch(1 0 0);
    --fg: oklch(0.145 0 0);
    --muted: oklch(0.556 0 0);
    --border: oklch(0.922 0 0);
    --primary: oklch(0.205 0 0);
    --primary-fg: oklch(0.985 0 0);
    --danger: oklch(0.577 0.245 27.325);
    --warn: oklch(0.55 0.14 80);
  }
  /* 数值跟 src/styles/tailwind.css 的 .dark 对齐（比 shadcn 默认亮一档），
     不然从登录页进应用会明显亮一下 */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: oklch(0.215 0 0);
      --card: oklch(0.255 0 0);
      --fg: oklch(0.985 0 0);
      --muted: oklch(0.735 0 0);
      --border: oklch(1 0 0 / 14%);
      --primary: oklch(0.985 0 0);
      --primary-fg: oklch(0.215 0 0);
      --danger: oklch(0.704 0.191 22.216);
      --warn: oklch(0.78 0.13 80);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: var(--bg);
    color: var(--fg);
    font: 400 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI",
      "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card {
    width: 100%;
    max-width: 22rem;
    padding: 1.75rem 1.5rem;
    text-align: center;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    box-shadow: 0 1px 2px oklch(0 0 0 / 5%);
  }
  .badge {
    width: 3rem;
    height: 3rem;
    margin: 0 auto 0.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--primary) 10%, transparent);
    color: var(--primary);
  }
  .badge svg { width: 1.5rem; height: 1.5rem; }
  h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
  .subtitle { margin: 0.25rem 0 1.25rem; color: var(--muted); }
  .banner {
    margin: 0 0 1rem;
    padding: 0.75rem;
    text-align: left;
    border-radius: 0.5rem;
    word-break: break-word;
  }
  .banner-error {
    color: var(--danger);
    border: 1px solid color-mix(in oklch, var(--danger) 30%, transparent);
    background: color-mix(in oklch, var(--danger) 10%, transparent);
  }
  .banner-warn {
    color: var(--warn);
    border: 1px solid color-mix(in oklch, var(--warn) 30%, transparent);
    background: color-mix(in oklch, var(--warn) 10%, transparent);
  }
  .button {
    display: block;
    padding: 0.625rem 1rem;
    font-size: 1rem;
    font-weight: 500;
    text-decoration: none;
    border-radius: 0.5rem;
    background: var(--primary);
    color: var(--primary-fg);
  }
  .button:hover { opacity: 0.9; }
  .button-disabled { opacity: 0.5; cursor: not-allowed; }
  .hint { margin: 1rem 0 0; font-size: 0.75rem; color: var(--muted); }
`
