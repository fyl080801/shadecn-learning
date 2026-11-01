import { vi } from 'vitest'
import type { AgentConfig } from '@shadecn/mod-agent/config'
import type { AuthSettings } from '@shadecn/mod-auth/config'
import type { StorageConfig } from '@shadecn/mod-storage/config'

/**
 * 重新加载配置（底座的 `config.ts` + 各模块解析好的配置段），按改造前的形状交回来，用例照旧按名字断言。
 *
 * 配置都是模块加载时算出来的常量，所以每次都 `resetModules` 再 import：调用前先 `vi.stubEnv`。
 * 模块的配置段按模块清单解析（模块定义的 `config.parse`，和 `prepare()` 同一条路，只是不建 ORM），这里把几段摊平：
 * `agentConfig` / `agentModelsFile` / `s3Config` / `s3Enabled` / `switchedOffModules`，以及登录那段（`authConfig` / `authEnabled` …）。
 *
 * 登录段按**开发环境**解析（生产缺配置时 `parse` 直接抛）：要断言「生产拒绝启动」的用例调 `assertAuthConfig()`，
 * 它按真实的 `isDev` 再判一次 —— 和 `parse` 里是同一个函数（`assertAuthSettings`）。
 */
export async function loadServerConfig() {
  vi.resetModules()
  const config = await import('@shadecn/server-core/config')
  const { resolveFullConfig } = await import('@shadecn/server-core/config-source')
  const { runtime } = await import('@shadecn/server-core/platform')
  const { parseModuleConfigs } = await import('@shadecn/server-kit/kernel')
  const { assertAuthSettings } = await import('@shadecn/mod-auth/config')
  const { callbackUriFor, secureCookieFor } = await import('@shadecn/mod-auth/settings')
  const { modules } = await import('../../modules.ts')

  const moduleConfigs = parseModuleConfigs(modules, resolveFullConfig(modules), { ...runtime, isDev: true })
  const agent = moduleConfigs.values.get('agent') as AgentConfig
  const storage = moduleConfigs.values.get('storage') as StorageConfig
  const auth = moduleConfigs.values.get('auth') as AuthSettings
  return {
    ...config,
    moduleConfigs,
    agentConfig: agent.host,
    agentModelsFile: agent.paths.modelsFile,
    s3Config: { ...storage.s3, maxUploadBytes: storage.maxUploadBytes, keyPrefix: storage.keyPrefix },
    s3Enabled: storage.s3 !== null && !moduleConfigs.switchedOff.has('storage'),
    switchedOffModules: moduleConfigs.switchedOff,
    authSettings: auth,
    authEnabled: auth.enabled,
    keycloakEnabled: auth.keycloakEnabled,
    githubEnabled: auth.githubEnabled,
    authConfig: {
      ...auth.keycloak,
      ttl: auth.ttl,
      secret: auth.secret,
      postLogoutRedirectUri: `${config.appOrigin}/login`,
      secureCookie: secureCookieFor(config.appOrigin),
    },
    githubConfig: auth.github,
    callbackUriFor,
    secureCookieFor,
    assertAuthConfig: () => assertAuthSettings(auth, config.isDev),
  }
}
