import { createApp } from "vue"

import "@/style.css"
import LoginPage from "./LoginPage.vue"

/**
 * 登录页的入口。
 *
 * 它是 `login.html` 这个**第二个 Vite 入口**的起点，和 `src/main.ts` 并列 ——
 * 没有 router、没有 pinia，因为登录页只有一屏、也没有任何路由要跳。
 *
 * 匿名访问者能拿到这份 bundle（页面闸门只挡整页导航，不挡静态资源），
 * 但拿不到 `index.html`，所以 SPA 起不来 —— 见 `server/frontend/guard.ts`。
 */
createApp(LoginPage).mount("#login")
