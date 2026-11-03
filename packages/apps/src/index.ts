/**
 * @learning/apps —— `executeApp` 和可插拔的驱动、应用表、画布节点的生成任务（docs/29、docs/30 §2、§8）。{@link AppsModule} 是唯一的入口，别的模块注入 {@link AppsService}。
 *
 * 表归这里（`entities.ts`），经 `DATA_ACCESS_ENTITIES` 登记；和 `@shadecn/mod-apps` 是两份定义，互不同步。
 * **依赖边界**（`test/package.test.ts` 钉着）：不依赖 `@shadecn/*`；`@learning/*`、`@nestjs/*`、`@mikro-orm/core`、`yjs` 都是 peerDependency，进程里的注入 token、实体基类和 `Y.Map` 只有应用装的那一份。pi-ai 没有这种要求，是自己的依赖。
 */
export { AppsModule } from './apps.module.js'
export { AppsService, type AppsServiceOptions } from './apps.service.js'
export { AppError, type AppInfo, type AppOutput, type AppResult, type ExecuteOptions, type TaskHandle } from './contract.js'
export { AppTask } from './entities.js'
