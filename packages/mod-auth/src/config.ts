import { setting } from '@shadecn/server-kit/config'
import type { ModuleConfig } from '@shadecn/server-kit/kernel'

/**
 * 登录模块的配置段：`modules.auth`（docs/28 §3.3）。每项对应一个环境变量（原名不变），环境变量优先于文件。
 *
 * - `SESSION_SECRET`：会话 token 做 HMAC 的密钥（库里存的是 HMAC 结果，光拖库伪造不出 cookie）；也是派生用途专属密钥的根（agent 的 run 令牌）；
 * - `SESSION_TTL`：会话最长存活时间（秒），默认 7 天；
 * - Keycloak（OIDC）：`KEYCLOAK_ISSUER`（就是 {keycloak}/realms/{realm}）、`KEYCLOAK_CLIENT_ID`、`KEYCLOAK_CLIENT_SECRET`（public client 留空）、`KEYCLOAK_SCOPE`；
 * - GitHub（OAuth2，不是 OIDC：没有 discovery / JWKS / id_token，身份要再调一次 `/user`）：`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_SCOPE`。
 *   回调地址和 Keycloak 是**同一个** `/api/auth/callback`，靠 `AuthRequest.provider` 分发；多接一个提供方不用改已注册的 redirect_uri。
 *
 * 一个提供方都没配 = 登录未启用（本地开发：所有请求当成同一个本地开发用户）；**生产必须至少配一个，且要有 `SESSION_SECRET`** ——
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

export const authConfigSection: ModuleConfig<AuthSettings> = {
  schema: {
    sessionSecret: setting('SESSION_SECRET', 'string'),
    sessionTtl: setting('SESSION_TTL', 'number', '会话最长存活时间（秒）'),
    keycloak: {
      issuer: setting('KEYCLOAK_ISSUER', 'string'),
      clientId: setting('KEYCLOAK_CLIENT_ID', 'string'),
      clientSecret: setting('KEYCLOAK_CLIENT_SECRET', 'string'),
      scope: setting('KEYCLOAK_SCOPE', 'string'),
    },
    github: {
      clientId: setting('GITHUB_CLIENT_ID', 'string'),
      clientSecret: setting('GITHUB_CLIENT_SECRET', 'string'),
      scope: setting('GITHUB_SCOPE', 'string'),
    },
  },
  parse(read, runtime) {
    const keycloak = {
      issuer: (read('KEYCLOAK_ISSUER') ?? '').replace(/\/+$/, ''),
      clientId: read('KEYCLOAK_CLIENT_ID') ?? '',
      clientSecret: read('KEYCLOAK_CLIENT_SECRET') ?? '',
      scope: read('KEYCLOAK_SCOPE') ?? 'openid profile email',
    }
    const github = {
      clientId: read('GITHUB_CLIENT_ID') ?? '',
      clientSecret: read('GITHUB_CLIENT_SECRET') ?? '',
      // 只要读身份：read:user 拿档案，user:email 拿主邮箱（GitHub 可能把邮箱设为私密）
      scope: read('GITHUB_SCOPE') ?? 'read:user user:email',
    }
    const keycloakEnabled = Boolean(keycloak.issuer && keycloak.clientId)
    const githubEnabled = Boolean(github.clientId && github.clientSecret)
    const settings: AuthSettings = {
      keycloak,
      github,
      ttl: Number(read('SESSION_TTL') ?? 7 * 24 * 3600),
      secret: read('SESSION_SECRET') ?? '',
      keycloakEnabled,
      githubEnabled,
      enabled: keycloakEnabled || githubEnabled,
    }
    assertAuthSettings(settings, runtime.isDev)
    return settings
  },
}

/** 配置不全：生产直接拒绝启动，开发环境警告 */
export function assertAuthSettings(settings: AuthSettings, isDev: boolean): void {
  const missing: string[] = []
  // Keycloak 配了一半（只有 issuer 或只有 client id）当成「想配但配漏了」，明确报出来；两个都空则是「这次不用 Keycloak」，不算缺
  if (settings.keycloak.issuer || settings.keycloak.clientId) {
    if (!settings.keycloak.issuer) missing.push('KEYCLOAK_ISSUER')
    if (!settings.keycloak.clientId) missing.push('KEYCLOAK_CLIENT_ID')
  }
  if (settings.github.clientId || settings.github.clientSecret) {
    if (!settings.github.clientId) missing.push('GITHUB_CLIENT_ID')
    if (!settings.github.clientSecret) missing.push('GITHUB_CLIENT_SECRET')
  }
  if (!settings.enabled) missing.push('KEYCLOAK_ISSUER + KEYCLOAK_CLIENT_ID 或 GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET')
  if (!settings.secret) missing.push('SESSION_SECRET')

  if (missing.length === 0) return

  const hint = `缺少配置：${missing.join(', ')}（参考 .env.example / server.config.example.yaml 的 modules.auth）`
  if (!isDev) throw new Error(`[auth] ${hint}`)
  console.warn(`[auth] ${hint}`)
  if (!settings.enabled) console.warn('[auth] 登录已关闭，所有接口与页面按匿名放行')
}
