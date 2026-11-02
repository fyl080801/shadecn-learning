import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC = Symbol('IS_PUBLIC')

/** 标在路由或控制器上：`ApiSessionGuard` 不校验登录态。默认都要登录，公开是逐个声明的例外 */
export const Public = () => SetMetadata(IS_PUBLIC, true)
