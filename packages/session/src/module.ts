import { Module } from '@nestjs/common'
import { SessionIdentityModule } from './identity.module.js'
import { LoginModule } from './login.module.js'

/**
 * 完整的用户、会话和登录：{@link SessionIdentityModule} + {@link LoginModule}。对外的页面服务（`apps/platform`）用它。
 * `SessionIdentityModule` 是全局模块，所以不需要在这里再 export。
 */
@Module({ imports: [SessionIdentityModule, LoginModule] })
export class SessionModule {}
