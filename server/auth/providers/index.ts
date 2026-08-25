import { githubProvider } from './github.ts'
import { keycloakProvider } from './keycloak.ts'
import type { AuthProvider, ProviderId } from './types.ts'

export type {
  AuthProvider,
  AuthorizeInput,
  ExchangeInput,
  ExchangeResult,
  ProviderId,
  ProviderProfile,
  ProviderTokens,
} from './types.ts'

/**
 * 身份提供方注册表。
 *
 * 数组的顺序就是登录页上按钮的顺序，Keycloak 在前是因为它是这套系统的主身份源
 * （角色只有它给得出来）。加一个提供方就是往这个数组里加一项。
 */
const REGISTRY: readonly AuthProvider[] = [keycloakProvider, githubProvider]

export function getProvider(id: string | null | undefined): AuthProvider | null {
  return REGISTRY.find((provider) => provider.id === id) ?? null
}

/** 配齐了的那些。登录页只列这些，`/api/auth/login?provider=` 也只接受这些 */
export function enabledProviders(): AuthProvider[] {
  return REGISTRY.filter((provider) => provider.enabled)
}

/**
 * 不带 `?provider=` 时用哪个 —— 第一个配齐的。
 * 有 Keycloak 就是 Keycloak（老链接、老书签的行为不变），只配了 GitHub 就是 GitHub。
 */
export function defaultProviderId(): ProviderId | null {
  return enabledProviders()[0]?.id ?? null
}

/** 给前端 / 登录页看的那一份（不含任何配置细节） */
export interface ProviderView {
  id: ProviderId
  label: string
  buttonLabel: string
}

export function providerViews(): ProviderView[] {
  return enabledProviders().map(({ id, label, buttonLabel }) => ({ id, label, buttonLabel }))
}
