import { installLogging } from './index.ts'

/**
 * 副作用模块：import 它就等于装好了日志。
 *
 * **为什么不是在 `server/index.ts` 里直接调 `installLogging()`**：ESM 的 import 声明会被
 * 提升，模块体（也就是那句函数调用）要等**所有**静态 import 的模块都初始化完才跑。
 * 那时 `db.ts` 已经连过库、`config.ts` 已经算过配置，这中间任何一句 `console.*`
 * 都漏在接管之外 —— 而启动阶段恰恰是最需要日志的时候。
 *
 * 写成副作用模块，它就按 import 出现的顺序执行：排在 `./env.ts` 后面第二位，
 * 于是后面所有模块的初始化都在接管之内。
 */
installLogging()
