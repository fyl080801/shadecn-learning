import { SessionPageAuth } from '@learning/session'
import { WEB_PAGE_AUTH } from '@learning/web'
import { Global, Module } from '@nestjs/common'

/**
 * web 和 session 互不依赖，在这里接线：把 SessionPageAuth 绑定到 web 要的 token。
 * 依赖链 SessionPageAuth → SessionService → DataAccess → ORM 工厂（同步表结构）全由 Nest 解析，所以和 AppModule 的 imports 顺序无关。
 */
@Global()
@Module({
  providers: [{ provide: WEB_PAGE_AUTH, useExisting: SessionPageAuth }],
  exports: [WEB_PAGE_AUTH],
})
export class PageAuthModule {}
