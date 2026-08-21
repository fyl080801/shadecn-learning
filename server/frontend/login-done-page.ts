/**
 * 登录窗口的终点站。
 *
 * 「重新登录」不整页跳走，而是新开一个窗口走完整套 OIDC；走完之后那个窗口落在
 * 这一页，它只做两件事：告诉开它的那一页「登录好了」，然后把自己关掉。
 * 页面本身是自包含的 HTML —— 它是登录流程的一环，不该去加载 SPA。
 *
 * 会话是 httpOnly cookie，原页面拿不到也不需要拿：收到消息后自己再问一次
 * `/api/auth/me` 就行（前端还有一条轮询兜底，见 SessionExpiredDialog.vue）。
 */

/** 登录完成后落地的路径；前端 `src/lib/auth.ts` 有一份同名常量 */
export const LOGIN_DONE_PATH = '/auth/login-done'

/** 消息标记，原页面靠它 + origin 两道校验认这条消息 */
export const LOGIN_DONE_MESSAGE = 'app-auth:login-done'

export function renderLoginDonePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>登录完成</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main class="box">
      <p class="title">登录成功</p>
      <p class="hint">可以关掉这个窗口，回到原来的页面继续。</p>
    </main>
    <script>
      (function () {
        var message = { source: "app-auth", type: ${JSON.stringify(LOGIN_DONE_MESSAGE)} }
        var origin = window.location.origin
        // 开这个窗口的那一页在等这条消息；opener 有可能被中间页面切断，
        // 那边还有一条 /api/auth/me 轮询兜底，所以这里失败也不必补救
        try { if (window.opener) window.opener.postMessage(message, origin) } catch (e) {}
        // 关不掉（没有 opener，比如有人直接敲这个地址）就把上面那句提示留在屏幕上
        setTimeout(function () { window.close() }, 300)
      })()
    </script>
  </body>
</html>
`
}

const STYLES = `
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: Canvas;
    color: CanvasText;
  }
  .box { text-align: center; }
  .title { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  .hint { margin: 0; font-size: 13px; opacity: 0.65; }
`
