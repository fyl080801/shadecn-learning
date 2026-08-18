import { createApp } from "vue"
import { createPinia } from "pinia"
import "./style.css"
// 主题在这里生效（模块副作用：往 <html> 上写 light / dark）。设置页是懒加载的，
// 挂在那边的话，只有进过一次设置页的会话才有主题。
import "./lib/theme"
import App from "./App.vue"
import router from "./router"

createApp(App).use(createPinia()).use(router).mount("#app")
