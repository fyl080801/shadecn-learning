/**
 * 登录协议层（OIDC、GitHub OAuth、对外域名判定）：不依赖配置、实体和全局状态，参数显式传入。
 * `@shadecn/mod-auth` 和 `@learning/session`（经 `@learning/data-access` 转出）共用这一份，安全代码不复制。
 */
export * from './types.ts'
export * from './oidc.ts'
export * from './github.ts'
export * from './origin.ts'
