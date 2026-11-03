import { CollabGatewayModule } from '@learning/collab'
import { Module } from '@nestjs/common'
import { PlatformBaseModule } from './platform-base.module.js'

/** 默认形态：一个进程一个端口，全部功能都在这里，协同入口也在 */
@Module({
  imports: [PlatformBaseModule, CollabGatewayModule],
})
export class AppModule {}
