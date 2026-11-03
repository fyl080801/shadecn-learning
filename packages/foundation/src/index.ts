/**
 * @learning/foundation —— Nest 服务的启动底座：{@link bootstrapService} 统一 Fastify、关闭钩子、监听端口、启动日志和两条健康探针。
 * 只依赖 `@learning/config`（peer：`ConfigService` 的类就是注入 token，进程里只能有一份）。
 */
export { type BootstrapOptions, bootstrapService, boundHttpClose, HTTP_CLOSE_GRACE_MS } from './bootstrap.js'
export type { Readiness, ReadinessCheck } from './health.js'
export { serverHost, serverPort } from './server-options.js'
