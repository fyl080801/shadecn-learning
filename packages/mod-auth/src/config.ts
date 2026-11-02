import { setting, type ConfigPath } from '@shadecn/server-kit/config'
import { defineModuleConfig, moduleEnvName } from '@shadecn/server-kit/kernel'

/**
 * 登录模块的配置段：`modules.auth`（docs/28 §3.3）。环境变量名由路径推导（`modules.auth.sessionSecret` → `MODULES_AUTH_SESSION_SECRET`），环境变量优先于文件。
 *
 * - `MODULES_AUTH_SESSION_SECRET`：会话 token 做 HMAC 的密钥（库里存的是 HMAC 结果，光拖库伪造不出 cookie）；也是派生用途专属密钥的根（agent 的 run 令牌）；
 * - `MODULES_AUTH_SESSION_TTL`：会话最长存活时间（秒），默认 7 天；
 * - Keycloak（OIDC）：`MODULES_AUTH_KEYCLOAK_ISSUER`（就是 {keycloak}/realms/{realm}）、`MODULES_AUTH_KEYCLOAK_CLIENT_ID`、`MODULES_AUTH_KEYCLOAK_CLIENT_SECRET`（public client 留空）、`MODULES_AUTH_KEYCLOAK_SCOPE`；
 * - GitHub（OAuth2，不是 OIDC：没有 discovery / JWKS / id_token，身份要再调一次 `/user`）：`MODULES_AUTH_GITHUB_CLIENT_ID`、`MODULES_AUTH_GITHUB_CLIENT_SECRET`、`MODULES_AUTH_GITHUB_SCOPE`。
 *   回调地址和 Keycloak 是**同一个** `/api/auth/callback`，靠 `AuthRequest.provider` 分发；多接一个提供方不用改已注册的 redirect_uri。
 *
 * 一个提供方都没配 = 登录未启用（本地开发：所有请求当成同一个本地开发用户）；**生产必须至少配一个，且要有 `MODULES_AUTH_SESSION_SECRET`** ——
 * 解析时就校验，生产缺了直接抛（进程不监听端口），开发环境只警告。配了一半（只有 issuer 没有 client id）当成配漏了，明确报出来。
 */
export interface AuthSettings {
  readonly keycloak: { readonly issuer: string; readonly clientId: string; readonly clientSecret: string; readonly scope: string }
  readonly github: { readonly clientId: string; readonly clientSecret: string; readonly scope: string }
  /** 会话最长存活时间（秒） */
  readonly ttl: number
  /** 会话密钥；开发环境没配时是空串（会话按本进程的临时密钥签，重启全部失效） */
  readonly secret: string
  readonly keycloakEnabled: boolean
  /** OAuth App 一定是 confidential client，没有 secret 就换不了 token */
  readonly githubEnabled: boolean
  readonly enabled: boolean
}

const schema = {
  sessionSecret: setting('string'),
  sessionTtl: setting('number', '会话最长存活时间（秒）'),
  keycloak: {
    issuer: setting('string'),
    clientId: setting('string'),
    clientSecret: setting('string'),
    scope: setting('string'),
  },
  github: {
    clientId: setting('string'),
    clientSecret: setting('string'),
    scope: setting('string'),
  },
}

/** 模块名：配置段 `modules.auth`、`/api/features` 的键 */
export const AUTH_MODULE = 'auth'

/** 这一项对应的环境变量名（报错 / 提示文案用，别手写） */
export function authEnv(path: ConfigPath<typeof schema>): string {
  return moduleEnvName(AUTH_MODULE, path)
}

export const authConfigSection = defineModuleConfig({
  schema,
  parse(read, runtime): AuthSettings {
    const keycloak = {
      issuer: (read('keycloak.issuer') ?? '').replace(/\/+$/, ''),
      clientId: read('keycloak.clientId') ?? '',
      clientSecret: read('keycloak.clientSecret') ?? '',
      scope: read('keycloak.scope') ?? 'openid profile email',
    }
    const github = {
      clientId: read('github.clientId') ?? '',
      clientSecret: read('github.clientSecret') ?? '',
      // 只要读身份：read:user 拿档案，user:email 拿主邮箱（GitHub 可能把邮箱设为私密）
      scope: read('github.scope') ?? 'read:user user:email',
    }
    const keycloakEnabled = Boolean(keycloak.issuer && keycloak.clientId)
    const githubEnabled = Boolean(github.clientId && github.clientSecret)
    const settings: AuthSettings = {
      keycloak,
      github,
      ttl: Number(read('sessionTtl') ?? 7 * 24 * 3600),
      secret: read('sessionSecret') ?? '',
      keycloakEnabled,
      githubEnabled,
      enabled: keycloakEnabled || githubEnabled,
    }
    assertAuthSettings(settings, runtime.isDev)
    return settings
  },
})

/** 配置不全：生产直接拒绝启动，开发环境警告 */
export function assertAuthSettings(settings: AuthSettings, isDev: boolean): void {
  const missing: string[] = []
  // Keycloak 配了一半（只有 issuer 或只有 client id）当成「想配但配漏了」，明确报出来；两个都空则是「这次不用 Keycloak」，不算缺
  if (settings.keycloak.issuer || settings.keycloak.clientId) {
    if (!settings.keycloak.issuer) missing.push(authEnv('keycloak.issuer'))
    if (!settings.keycloak.clientId) missing.push(authEnv('keycloak.clientId'))
  }
  if (settings.github.clientId || settings.github.clientSecret) {
    if (!settings.github.clientId) missing.push(authEnv('github.clientId'))
    if (!settings.github.clientSecret) missing.push(authEnv('github.clientSecret'))
  }
  if (!settings.enabled) missing.push(`${authEnv('keycloak.issuer')} + ${authEnv('keycloak.clientId')} 或 ${authEnv('github.clientId')} + ${authEnv('github.clientSecret')}`)
  if (!settings.secret) missing.push(authEnv('sessionSecret'))

  if (missing.length === 0) return

  const hint = `缺少配置：${missing.join(', ')}（参考 .env.example / server.config.example.yaml 的 modules.auth）`
  if (!isDev) throw new Error(`[auth] ${hint}`)
  console.warn(`[auth] ${hint}`)
  if (!settings.enabled) console.warn('[auth] 登录已关闭，所有接口与页面按匿名放行')
}
