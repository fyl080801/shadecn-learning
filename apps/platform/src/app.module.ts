import { CanvasApiModule } from '@learning/canvas'
import { ClusterModule } from '@learning/cluster'
import { ConfigModule } from '@learning/config'
import { DataAccessModule } from '@learning/data-access'
import { ApiSessionGuard, SessionModule } from '@learning/session'
import { WebModule } from '@learning/web'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ClusterDatabaseCheckModule } from './cluster-database.module.js'
import { PageAuthModule } from './page-auth.module.js'

/**
 * 只列模块，不解析配置：各模块经全局的 `ConfigService` 取 config.yaml 里自己那段（文件位置和各段：`config.example.yaml`）。
 * 模块之间的依赖全由 Nest 解析，和这里的先后无关。
 */
@Module({
  imports: [ConfigModule, DataAccessModule, SessionModule, PageAuthModule, WebModule, ClusterModule, ClusterDatabaseCheckModule, CanvasApiModule],
  // /api 下默认要登录；开发环境同样校验，没有「未配置就放行」
  providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
})
export class AppModule {}
