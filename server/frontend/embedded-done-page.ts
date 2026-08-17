/**
 * 内嵌登录窗口的终点站。
 *
 * 「重新登录」不整页跳走，而是在一个模态窗里开个 iframe 走完整套 OIDC；
 * 走完之后浏览器落在这一页，它只做一件事：告诉父窗口「登录好了」。
 * 页面本身仍然是自包含的 HTML —— 它是登录流程的一环，不该去加载 SPA。
 *
 * 会话是 httpOnly cookie，父窗口拿不到也不需要拿：收到消息后自己再问一次
 * `/api/auth/me` 就行（前端还有一条轮询兜底，见 SessionExpiredDialog.vue）。
 */

/** 内嵌登录完成后落地的路径；前端 `src/lib/auth.ts` 有一份同名常量 */
export const EMBEDDED_LOGIN_DONE_PATH = '/auth/embedded-done'

/** 消息标记，父窗口靠它 + origin 两道校验认这条消息 */
export const EMBEDDED_LOGIN_MESSAGE = 'app-auth:login-done'

export function renderEmbeddedDonePage(): string {
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
      <p class="hint">正在返回原来的页面…</p>
    </main>
    <script>
      (function () {
        var message = { source: "app-auth", type: ${JSON.stringify(EMBEDDED_LOGIN_MESSAGE)} }
        var origin = window.location.origin
        // 模态里的 iframe 发给 parent；「在新窗口登录」那条路发给 opener
        try { if (window.parent !== window) window.parent.postMessage(message, origin) } catch (e) {}
        try { if (window.opener) window.opener.postMessage(message, origin) } catch (e) {}
        // 既不是 iframe 也不是弹窗（比如有人直接敲这个地址）：没什么可通知的，回首页
        if (window.parent === window && !window.opener) window.location.replace("/")
        else if (window.opener) setTimeout(function () { window.close() }, 300)
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
