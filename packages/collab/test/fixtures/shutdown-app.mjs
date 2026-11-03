/**
 * 真 SIGTERM 用例的子进程（`shutdown.test.ts`）：真实产物、`@learning/foundation` 的启动路径，和 `apps/platform` 的 `main.ts` 一样。
 * 写在 .mjs 里是因为这个文件由 Node 原生执行：不走 vitest 的 alias 和 swc，装饰器只能当函数调。
 */
import 'reflect-metadata'
import { CanvasApiModule } from '@learning/canvas'
import { ClusterModule } from '@learning/cluster'
import { CollabGatewayModule } from '@learning/collab'
import { ConfigModule } from '@learning/config'
import { DataAccessModule } from '@learning/data-access'
import { bootstrapService } from '@learning/foundation'
import { ApiSessionGuard, SessionIdentityModule, SessionService, UserService } from '@learning/session'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'

class Root {}
Module({
  imports: [ConfigModule, DataAccessModule, ClusterModule, SessionIdentityModule, CanvasApiModule, CollabGatewayModule],
  providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
})(Root)

const app = await bootstrapService(Root, { name: 'shutdown-fixture' })
const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'sigterm', name: 'sigterm' })
const token = await app.get(SessionService).create({
  userId: user.id,
  provider: 'oidc',
  tokens: { accessToken: 'x', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, sessionState: null },
})
console.log(`READY ${JSON.stringify({ url: await app.getUrl(), cookie: `sid=${token}` })}`)
