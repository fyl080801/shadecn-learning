import { CanvasApiModule } from '@learning/canvas'
import { ClusterModule } from '@learning/cluster'
import { ConfigModule } from '@learning/config'
import { DataAccessModule } from '@learning/data-access'
import { ApiSessionGuard, ClusterDatabaseCheckModule, SessionModule } from '@learning/session'
import { WebModule } from '@learning/web'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { PageAuthModule } from './page-auth.module.js'

/**
 * 平台除协同入口之外的全部：页面、登录、画布 REST。协同副本单独跑时，平台就是这些（入口 `main-without-collab.ts`，docs/30 §3）。
 * 只列模块，不解析配置：各模块经全局的 `ConfigService` 取 config.yaml 里自己那段（文件位置和各段：`config.example.yaml`）。
 * 模块之间的依赖全由 Nest 解析，和这里的先后无关。
 */
@Module({
  imports: [ConfigModule, DataAccessModule, SessionModule, PageAuthModule, WebModule, ClusterModule, ClusterDatabaseCheckModule, CanvasApiModule],
  // /api 下默认要登录；开发环境同样校验，没有「未配置就放行」
  providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
})
export class PlatformBaseModule {}
