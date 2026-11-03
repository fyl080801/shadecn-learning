/**
 * @learning/agent —— Nest 服务的画布 agent（docs/20、docs/22、docs/31 §4）。{@link AgentModule} 是唯一的入口，没有别的模块要注入它的东西。
 * 编排、网关协议、runner 在 `@learning/agent-core`（框架无关），这里只有宿主：配置、实体、判权、登记、画布访问、runtime，和两个 HTTP 入口（面板的 SSE、runner 的网关）。
 *
 * 表归这里（`entities.ts`），经 `DATA_ACCESS_ENTITIES` 登记；和 `@shadecn/mod-agent` 是两份定义，互不同步。
 * **依赖边界**（`test/package.test.ts` 钉着）：不依赖 `@shadecn/*`；`@learning/*` 的业务包和底座、`@nestjs/*`、`@mikro-orm/core`、`yjs` 都是 peerDependency，进程里的注入 token、实体基类和 `Y.Map` 只有应用装的那一份。
 * `@learning/agent-core`、`@learning/llm` 没有注入 token，是自己的依赖。
 */
export { AgentModule } from './agent.module.js'
export { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from './entities.js'
