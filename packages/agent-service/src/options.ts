import { createRequire } from 'node:module'
import path from 'node:path'
import type { ConfigService } from '@learning/config'
import { serverHost, serverPort } from '@learning/foundation'
import { parseLlmProviders, type LlmProviderTable } from '@learning/llm/llm-config'
import type { SessionService } from '@learning/session'

export const AGENT_OPTIONS = Symbol('AGENT_OPTIONS')

/** 签 run 短令牌的密钥放 `.env`（`docs/31` §4.5） */
export const AGENT_TOKEN_SECRET_ENV = 'PLATFORM_AGENT_TOKEN_SECRET'
/**
 * 没配 {@link AGENT_TOKEN_SECRET_ENV} 时，从会话密钥派生用的用途串。**改它 = 在跑的令牌全部失效**。
 * 派生和会话 id 是同一个算法（`HMAC(密钥, 输入)`），所以用途串不能长得像会话 token（43 位 base64url）：
 * 否则拿它当 cookie 算出来的会话 id 就是这把密钥。带冒号，一定不在 base64url 的字母表里。
 */
export const AGENT_TOKEN_SECRET_PURPOSE = 'agent:run-token'

/** `oci` 的默认镜像名（`docs/31` §3.3 的 `apps/agent-runner`），不用旧服务的 `shadecn-agent-sandbox`：那是另一份 runner */
const DEFAULT_SANDBOX_IMAGE = 'learning-agent-runner:latest'

/** 沙箱驱动的取值；认不出的（含这个服务没有的 `k8s`）原样带着，由 `SANDBOX_DRIVER` 写成「未启用」的原因 */
export type AgentSandboxChoice = 'process' | 'oci' | { unknown: string }

export interface AgentOptions {
  provider: string
  model: string
  /** 原样的字符串，合法性由 `@learning/llm/model` 判（不合法就警告并当没配，思考不值得让 agent 整个关掉） */
  thinking: string | undefined
  /** 生成会话标题用的模型表键；undefined = 不生成 */
  titleModel: string | undefined
  maxOutputTokens: number | undefined
  sandbox: AgentSandboxChoice
  /** 给模型 `run_media_command` */
  sandboxExec: boolean
  allowProcessInProduction: boolean
  sandboxImage: string
  ociSocket: string
  ociNetwork: string
  sandboxRuntime: string
  sandboxResources: { cpu: number; memoryMiB: number; pids: number; diskMiB: number }
  /** 沙箱里看到的服务端地址，不含网关路径 */
  gatewayUrl: string
  /** `server.port: 0` 又没写 `agent.gatewayUrl`：启动时算不出 runner 该连回哪里，`SANDBOX_DRIVER` 据此写成「未启用」 */
  gatewayUnknown: boolean
  tokenSecret: string
  grantMarginMs: number
  leaseTtlMs: number
  runIdleTimeoutMs: number
  runTotalTimeoutMs: number
  production: boolean
  llmProviders: LlmProviderTable
  /** 读 `$ENV` 引用的、按提供方退回的 key */
  envVar: (name: string) => string | undefined
  /** `<dataDir>/agent-workspaces/<flowId>/<runId>` */
  workspaceDir: string
  /** `<dataDir>/agent-models.json`；不存在 = 模型表只有 `default` */
  modelsFile: string
  /** agent 定义和文字技能随 `@learning/agent-core` 发布，按包路径找，不可配 */
  definitionsDir: string
  textSkillsDir: string
}

const SECTION = 'agent'
const FIELDS = ['provider', 'model', 'thinking', 'titleModel', 'maxOutputTokens', 'gatewayUrl', 'grantMarginMs', 'leaseTtlMs', 'runIdleTimeoutMs', 'runTotalTimeoutMs', 'sandbox']
const SANDBOX_FIELDS = ['driver', 'exec', 'allowProcess', 'image', 'runtime', 'cpus', 'memoryMib', 'pids', 'diskMib', 'oci']
const OCI_FIELDS = ['socket', 'network']

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mappingAt(at: string, value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (!isMapping(value)) throw new Error(`[agent] ${at} 必须是映射`)
  // 只报字段名不回显值：写错地方的可能是密钥。认错的字段放过去等于悄悄用默认值，配了等于没配
  const unknown = Object.keys(value).filter((field) => !fields.includes(field))
  if (unknown.length > 0) throw new Error(`[agent] ${at}：不认识的字段 ${unknown.join('、')}（只认 ${fields.join(' / ')}）`)
  return value
}

function text(at: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`[agent] ${at} 必须是字符串`)
  return value.trim() || undefined
}

function isOn(value: unknown): boolean {
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase())
}

/** 数字配坏了（不是数、不在范围）退回默认值并警告：资源上限和时长不值得让服务起不来，同旧服务 */
function numberOr(at: string, value: unknown, fallback: number, ok: (parsed: number) => boolean): number {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (Number.isFinite(parsed) && ok(parsed)) return parsed
  console.warn(`[agent] ${at} 配得不对，按默认值 ${fallback}`)
  return fallback
}

const positive = (at: string, value: unknown, fallback: number) => numberOr(at, value, fallback, (parsed) => parsed > 0)
const positiveInt = (at: string, value: unknown, fallback: number) => Math.floor(positive(at, value, fallback))

function sandboxChoice(raw: string | undefined): AgentSandboxChoice {
  const value = raw ?? 'process'
  return value === 'process' || value === 'oci' ? value : { unknown: value }
}

/** `titleModel` 不写 = `default`；`off`（含 YAML 读成布尔的 `false`）= 不生成 */
function titleModelOf(raw: unknown): string | undefined {
  if (raw === false) return undefined
  const value = text(`${SECTION}.titleModel`, raw)
  if (!value) return 'default'
  return ['off', 'none', '0', 'false'].includes(value.toLowerCase()) ? undefined : value
}

/** 监听全部地址时，同机的沙箱从回环地址进来。没写 `server.host` 就只听本机 */
function loopbackOf(listen: string | undefined): string {
  return !listen || listen === '0.0.0.0' || listen === '::' ? '127.0.0.1' : listen
}

/**
 * config.yaml 的 `agent` 段（`docs/31` §4.5）和 `llm.providers`。校验和默认值都在这里。
 *
 * - **一个都不配也照样加载**：拿不到模型或 key 就是 agent 没开（`enabled: false`），不影响启动；
 * - **段的形状不对拒绝启动**（不认识的字段、类型不对），报错不回显值；
 * - 连接信息和 key 不在这一段：`provider` 只是引用 `llm.providers` 的 key（或 pi 的内置提供方）。
 */
export function resolveAgentOptions(config: ConfigService, session: Pick<SessionService, 'deriveSecret'>): AgentOptions {
  const section = mappingAt(SECTION, config.mapping(SECTION), FIELDS)
  const sandbox = mappingAt(`${SECTION}.sandbox`, section.sandbox, SANDBOX_FIELDS)
  const oci = mappingAt(`${SECTION}.sandbox.oci`, sandbox.oci, OCI_FIELDS)
  const driver = sandboxChoice(text(`${SECTION}.sandbox.driver`, sandbox.driver))

  const port = serverPort(config)
  const gatewayUrl = text(`${SECTION}.gatewayUrl`, section.gatewayUrl)
  // `oci` 的容器里回环是容器自己，走引擎给的宿主名（Podman 5、Docker Desktop 都有；Linux 上的 Docker 要显式配）
  const defaultGateway = driver === 'oci' ? `http://host.docker.internal:${port}` : `http://${loopbackOf(serverHost(config))}:${port}`

  const maxOutputTokens = section.maxOutputTokens === undefined || section.maxOutputTokens === null ? undefined : positiveInt(`${SECTION}.maxOutputTokens`, section.maxOutputTokens, 0)
  const corePackage = createRequire(import.meta.url).resolve('@learning/agent-core/package.json')

  return {
    provider: text(`${SECTION}.provider`, section.provider) ?? 'anthropic',
    model: text(`${SECTION}.model`, section.model) ?? 'claude-sonnet-4-6',
    thinking: text(`${SECTION}.thinking`, section.thinking),
    titleModel: titleModelOf(section.titleModel),
    maxOutputTokens: maxOutputTokens || undefined,
    sandbox: driver,
    sandboxExec: isOn(sandbox.exec),
    allowProcessInProduction: isOn(sandbox.allowProcess),
    sandboxImage: text(`${SECTION}.sandbox.image`, sandbox.image) ?? DEFAULT_SANDBOX_IMAGE,
    ociSocket: text(`${SECTION}.sandbox.oci.socket`, oci.socket) ?? '',
    ociNetwork: text(`${SECTION}.sandbox.oci.network`, oci.network) ?? 'bridge',
    sandboxRuntime: text(`${SECTION}.sandbox.runtime`, sandbox.runtime) ?? '',
    sandboxResources: {
      cpu: positive(`${SECTION}.sandbox.cpus`, sandbox.cpus, 1),
      memoryMiB: positiveInt(`${SECTION}.sandbox.memoryMib`, sandbox.memoryMib, 512),
      pids: positiveInt(`${SECTION}.sandbox.pids`, sandbox.pids, 128),
      diskMiB: positiveInt(`${SECTION}.sandbox.diskMib`, sandbox.diskMib, 512),
    },
    gatewayUrl: (gatewayUrl ?? defaultGateway).replace(/\/+$/, ''),
    gatewayUnknown: port === 0 && gatewayUrl === undefined,
    tokenSecret: config.env(AGENT_TOKEN_SECRET_ENV) ?? session.deriveSecret(AGENT_TOKEN_SECRET_PURPOSE),
    grantMarginMs: numberOr(`${SECTION}.grantMarginMs`, section.grantMarginMs, 60_000, (parsed) => parsed >= 0),
    leaseTtlMs: positiveInt(`${SECTION}.leaseTtlMs`, section.leaseTtlMs, 30_000),
    runIdleTimeoutMs: positiveInt(`${SECTION}.runIdleTimeoutMs`, section.runIdleTimeoutMs, 120_000),
    runTotalTimeoutMs: positiveInt(`${SECTION}.runTotalTimeoutMs`, section.runTotalTimeoutMs, 1_800_000),
    production: config.isProduction,
    llmProviders: parseLlmProviders(config.mapping('llm').providers),
    envVar: (name) => config.env(name),
    workspaceDir: path.join(config.dataDir, 'agent-workspaces'),
    modelsFile: path.join(config.dataDir, 'agent-models.json'),
    definitionsDir: path.join(path.dirname(corePackage), 'agents'),
    textSkillsDir: path.join(path.dirname(corePackage), 'skills'),
  }
}
