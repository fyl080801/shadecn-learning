import { createCollabModule } from '@shadecn/mod-collab'
import type { ServerApp } from '../app.ts'
import { authorizeCollab, isAllowedCollabOrigin } from '../auth/ws.ts'
import { instanceId, isClustered, redisKeyPrefix, redisUrl } from '../config.ts'
import { collabLogging } from '../logger/collab.ts'
import { flowDocs } from '../store/flow-docs.ts'

/**
 * 协同模块的装配点：能力在 `@shadecn/mod-collab`，这里只把底座的东西交进去 ——
 * 会话 / 成员鉴权（`auth/ws.ts`）、画布内容存取（`store/flow-docs.ts`）、实例身份和 Redis、日志扩展。
 *
 * **import 这个文件就装配好了端口**（`createCollabModule` 构造时调 `configureCollab`）：测试的 setup 也 import 它，
 * 不起服务端也能直接调协同的落库 / REST 写入函数。
 */
export const collabModule = createCollabModule<ServerApp>({
  auth: { authorize: authorizeCollab, isAllowedOrigin: isAllowedCollabOrigin },
  flowDocs,
  instanceId,
  redis: isClustered ? { url: redisUrl, prefix: redisKeyPrefix } : null,
  extensions: () => [collabLogging()],
})

