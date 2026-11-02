/**
 * @learning/config —— Nest 服务的配置：`<dataDir>/config.yaml` 经 {@link ConfigModule}（全局）注入成 {@link ConfigService}。
 * 只负责找文件、解析、按段取值；各段的校验和默认值归读它的模块。测试入口是 `@learning/config/testing`，这里不导出。
 */
export { ConfigService } from './config.service.js'
export { ConfigModule } from './module.js'
