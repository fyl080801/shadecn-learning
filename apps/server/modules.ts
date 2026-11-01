import agent from '@shadecn/mod-agent'
import apps from '@shadecn/mod-apps'
import auth from '@shadecn/mod-auth'
import canvas from '@shadecn/mod-canvas'
import collab from '@shadecn/mod-collab'
import notes from '@shadecn/mod-notes'
import storage from '@shadecn/mod-storage'
import type { AnyServerModule } from '@shadecn/server-kit/kernel'

/**
 * 模块清单（docs/28 §3.1）：这个产物带哪些能力。**加一个能力 = 在这里加一行**，别处一行都不用改 ——
 * 配置段、表、入口、角色、依赖都在模块自己的声明里，底座（`@shadecn/server-core`）按清单装配。
 *
 * 清单是静态的：产物由 esbuild 打包，不能按配置文件里写的包名动态 import；配置只负责开关（`modules.<name>.enabled`）。
 * 顺序不重要 —— 内核按依赖排序。
 */
export const modules: readonly AnyServerModule[] = [auth, canvas, storage, collab, agent, notes, apps]
