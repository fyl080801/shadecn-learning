import { loadServerConfig } from './config.ts'

/**
 * 换一份全新的模块图，并把**当前环境变量**解析出的登录配置交给新图里的登录模块（和模块 setup 时一样）。
 * 之后再 `import('@shadecn/mod-auth/…')` 拿到的就是按这份配置工作的那一套（discovery 缓存、开关都是新的）。
 * 调用前先 `vi.stubEnv`。
 */
export async function freshAuth() {
  const { authSettings } = await loadServerConfig()
  const { configureAuthSettings } = await import('@shadecn/mod-auth/settings')
  configureAuthSettings(authSettings)
  return authSettings
}
