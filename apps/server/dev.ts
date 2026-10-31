import './env.ts'
// 顺序同 index.ts：.env 之后、其余一切之前接管 console
import './logger/install.ts'
import { boot } from './boot.ts'
import { agentModule } from './modules/agent.ts'
import { collabModule } from './modules/collab.ts'
import { frontendDevModule } from './modules/frontend-dev.ts'
import { storageModule } from './modules/storage.ts'

/**
 * 开发入口（`pnpm dev` / `pnpm dev:cluster` 跑它）：和 `index.ts` 唯一的区别是前端换成 Vite 中间件。
 * 它不进构建 —— esbuild 的入口只有 `index.ts`，所以 Vite 永远不会出现在产物里（docs/28 §3.8）。
 */
const shutdown = await boot({ modules: [storageModule, collabModule, agentModule, frontendDevModule] })

// dev 下真正 listen 的是 tsx watch fork 出来的这个进程，上面还压着 tsx、sh、pnpm 三层。
// 终端里 Ctrl+C 时信号发给整个前台进程组，四层都收得到；但从 IDE 点停止、kill 顶层 pid、
// 或者直接关掉终端标签时，信号只送到最上面一两层，这里收不到 —— 于是端口还占着、连接还连着，
// 进程被 init 收养成了孤儿，下次启动就是 EADDRINUSE。攒几天能攒出几十个。
// 父进程一死 ppid 就会变成 1，据此自我了断（走正常 shutdown，Y.Doc 该落库的照样落库）。
// 定时器 unref 掉：它只是个哨兵，不该成为进程活着的理由
const parentPid = process.ppid
const orphanTimer = setInterval(() => {
  if (process.ppid !== parentPid) {
    console.log('[dev] 父进程已退出，自动关闭以释放端口')
    clearInterval(orphanTimer)
    void shutdown()
  }
}, 2000)
orphanTimer.unref()
