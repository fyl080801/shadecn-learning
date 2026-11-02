/**
 * @learning/foundation —— Nest 服务的启动底座：{@link bootstrapService} 统一 Fastify、关闭钩子、监听端口、启动日志和 `/api/health`。
 * 只依赖 `@learning/config`（peer：`ConfigService` 的类就是注入 token，进程里只能有一份）。
 */
export { type BootstrapOptions, bootstrapService } from './bootstrap.js'
export { serverPort } from './server-options.js'
