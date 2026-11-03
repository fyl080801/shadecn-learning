import type { LlmProviderTable } from '@learning/llm/llm-config'
import type { AppCategory, AppOutput, AppProgress, AppUsage, ParamSchema, ParamSpec, TaskHandle } from './contract.js'

export type { TaskHandle } from './contract.js'

/**
 * 驱动协议（docs/29 §3.2）：一种对接服务（火山方舟、ComfyUI、ollama…）= 一个 {@link ProviderDriver}，
 * 放在 `drivers/<type>.ts`，在 `drivers/index.ts` 的注册表里加一行。**通用的事都不在驱动里**：
 *
 * - 应用表的解析（哪个应用用哪个提供方、`defaults`、`timeoutMs`）、参数校验与默认值、超时与中止、错误归一 —— 执行层（`catalog.ts`）；
 * - 字段读取与校验（类型、必填、未知字段、密钥只认 `$ENV`）—— {@link Fields}；
 * - 请求上游 —— `http.ts`；轮询的循环、间隔、时限 —— 执行层（驱动只「查一次」，见 {@link PreparedApp.poll}）。
 *
 * 驱动只回答三件事：提供方实例要哪些字段（`parseProvider`）、有哪些操作（`operations`）、
 * 每个操作在某个应用的 `options` 下收哪些参数、怎么把参数变成上游请求再把回包变成 {@link AppOutput}（`prepare` → `submit`）。
 * 操作的键就是应用的类别（`type`）。一个操作可以服务很多模型：驱动只给基础参数表，每个模型的差异写在 `apps` 条目的 `params` 里（docs/29 §3.7），由执行层套用。
 */

/** 驱动能拿到的运行环境：只有这几样，驱动不读 `process.env`，不注入别的东西 */
export interface DriverEnv {
  /** 读 `$ENV` 引用的环境变量（名字由写应用表的人定，不在配置 schema 里） */
  envVar(name: string): string | undefined
  /** 应用根目录：配置里的相对路径（ComfyUI 的工作流文件）按它算 */
  appRoot: string
  /** 语言服务提供方（config.yaml 的 `llm.providers`）：`llm` 驱动引用它，有模型的提供方自动成为 text 类应用（`llm-apps.ts`） */
  llmProviders: LlmProviderTable
}

/** 执行时交给驱动的上下文 */
export interface RunContext {
  /** 已合并调用方的中止和应用的时限；驱动的每个上游请求、每次等待都要带上它 */
  readonly signal: AbortSignal
  /** 发上游请求用的 fetch（测试注入脚本化上游） */
  readonly fetch: typeof fetch
}

/** 驱动一次执行的产出；`appId` / `durationMs` 由执行层补 */
export interface RunOutput {
  outputs: AppOutput[]
  usage?: AppUsage
  upstreamId?: string
}

/** `submit` 的结果：同步出结果的上游直接给产物，任务型的给续查句柄 */
export type Submission = { done: true; output: RunOutput } | { done: false; handle: TaskHandle }

/** `poll` 查一次的结果：完了给产物，没完给进度（失败抛 `AppError`） */
export type PollStep<T> = { done: true; value: T } | ({ done: false } & AppProgress)

/**
 * 一个应用在启动时准备好的样子：基础参数表、执行函数（已经绑定了提供方实例和应用的 `options`）。类别就是操作的键。
 * 模型和最终的参数表由执行层按条目算好（docs/29 §3.7），`submit` 拿到的是条目上的模型和校验过的参数。
 */
export interface PreparedApp {
  /** 基础参数表：条目的 `params` 在它之上改 */
  params: ParamSchema
  /**
   * 启动时问一次：条目上的模型现在用得了吗（LLM 驱动在这里解析模型）。用不了回原因，这个应用标成不可用（不是启动错误）。不给 = 用得了
   */
  checkModel?(model: string): string | null
  /**
   * 提交：`values` 已按这一项的参数表校验、补齐默认值；`model` 是条目上的模型（不要模型的操作是 undefined）。
   * 同步上游直接回 `{ done: true, output }`；任务型上游建好任务就回 `{ done: false, handle }`，之后由执行层调 {@link poll}
   */
  submit(values: Readonly<Record<string, unknown>>, ctx: RunContext, model: string | undefined): Promise<Submission>
  /** 按句柄查**一次**上游任务的状态（任务型的必须给）。不写循环、不 sleep —— 间隔和时限是执行层的 */
  poll?(handle: TaskHandle, ctx: RunContext): Promise<PollStep<RunOutput>>
  /** 尽力撤销上游任务（取消时调）；抛错只打日志 */
  cancel?(handle: TaskHandle, ctx: RunContext): Promise<void>
  /** 两次 `poll` 之间等多久；不给用执行层的默认 */
  pollIntervalMs?: number
}

/**
 * 参数表的改动：每一项要么是对该参数的部分覆盖（和基础说明合并，`enum` 等数组整个替换），
 * 要么是 `null` = 这个模型没有这个参数（调用方传了会报「不认识的参数」，列表里也不出现）。
 * 也可以加基础参数表里没有的参数（那时必须给 `type`）。**模型的参数差异只写在配置里**（`apps` 条目的 `params`），驱动不认识具体模型
 */
export type ParamPatch = Readonly<Record<string, Partial<ParamSpec> | null>>

export interface Operation<Provider> {
  description: string
  /** 条目要不要写 `model`。默认要；ComfyUI 不要（模型在工作流里，要选就映射成参数），条目改写 `id` */
  requiresModel?: boolean
  /** 读应用的 `options`（驱动特有的配置）。形状不对抛 Error；配置对但现在用不了记 {@link Fields.unavailable}、照常返回 */
  prepare(options: Fields, provider: Provider, env: DriverEnv): PreparedApp
}

export interface ProviderDriver<Provider = unknown> {
  /** 应用表里 `providers.<id>.type` 写的名字 */
  readonly type: string
  readonly description: string
  /** 读提供方实例的字段（`type` 之外的）。形状不对抛 Error；配置对但现在用不了记 {@link Fields.unavailable}、照常返回 */
  parseProvider(fields: Fields, env: DriverEnv): Provider
  /** 键是类别：条目的 `type` 选的就是它。能做哪几类就有哪几个键 */
  readonly operations: Readonly<Partial<Record<AppCategory, Operation<Provider>>>>
}

/** 只做类型约束：注册表里的驱动各自的提供方类型不同，执行层按 unknown 看待 */
export function defineDriver<Provider>(driver: ProviderDriver<Provider>): ProviderDriver<Provider> {
  return driver
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProviderDriver = ProviderDriver<any>

// ---------------------------------------------------------------- 字段读取

const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface FieldOptions<T> {
  required?: boolean
  default?: T
}

/**
 * 一段配置对象的读取器：每读一个字段就记一笔，最后 {@link Fields.done} 把没读过的字段当「不认识」报出来 ——
 * 拼错的键悄悄不生效是最难查的配置错误。报错都带上位置（`apps.providers.ark`）。
 */
export class Fields {
  private readonly seen = new Set<string>()
  private readonly children: Fields[] = []
  readonly raw: Readonly<Record<string, unknown>>
  readonly at: string
  private readonly env: DriverEnv
  /** 「配置对，但现在用不了」的原因，嵌套的各段共用一份 */
  readonly problems: string[]

  constructor(raw: unknown, at: string, env: DriverEnv, problems: string[] = []) {
    if (raw === undefined || raw === null) raw = {}
    if (!isRecord(raw)) throw new Error(`${at}：必须是对象`)
    this.raw = raw
    this.at = at
    this.env = env
    this.problems = problems
  }

  /**
   * 记一条「配置是对的，但现在用不了」：缺密钥、模型解析不了。**不是启动错误** —— 用到它的应用标成不可用（带原因），
   * 启动时打一行警告，执行时回 `unavailable`。形状不对（字段类型、未知字段、明文密钥）才是启动错误，直接抛。
   * 驱动记完照常返回（参数表、类别照样要给出来：界面上要能看到这个应用、看到它为什么用不了）。
   */
  unavailable(reason: string): void {
    this.problems.push(reason)
  }

  private take(key: string): unknown {
    this.seen.add(key)
    return this.raw[key]
  }

  private missing(key: string): never {
    throw new Error(`${this.at}：缺少 ${key}`)
  }

  string(key: string, options: FieldOptions<string> & ({ required: true } | { default: string })): string
  string(key: string, options?: FieldOptions<string>): string | undefined
  string(key: string, options: FieldOptions<string> = {}): string | undefined {
    const value = this.take(key)
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      if (options.default !== undefined) return options.default
      return options.required ? this.missing(key) : undefined
    }
    if (typeof value !== 'string') throw new Error(`${this.at}：${key} 必须是字符串`)
    return value.trim()
  }

  /** 取值必须在 `values` 里 */
  oneOf<T extends string>(key: string, values: readonly T[], options: FieldOptions<T> & ({ required: true } | { default: T })): T
  oneOf<T extends string>(key: string, values: readonly T[], options?: FieldOptions<T>): T | undefined
  oneOf<T extends string>(key: string, values: readonly T[], options: FieldOptions<T> = {}): T | undefined {
    const value = this.string(key, options as FieldOptions<string>)
    if (value === undefined) return undefined
    if (!(values as readonly string[]).includes(value)) throw new Error(`${this.at}：${key} 只能是 ${values.join(' / ')}`)
    return value as T
  }

  /** 正整数 */
  integer(key: string, options: FieldOptions<number> = {}): number | undefined {
    const value = this.take(key)
    if (value === undefined || value === null) return options.default ?? (options.required ? this.missing(key) : undefined)
    if (!(typeof value === 'number' && Number.isInteger(value) && value > 0)) throw new Error(`${this.at}：${key} 必须是正整数`)
    return value
  }

  boolean(key: string, options: FieldOptions<boolean> = {}): boolean | undefined {
    const value = this.take(key)
    if (value === undefined || value === null) return options.default ?? (options.required ? this.missing(key) : undefined)
    if (typeof value !== 'boolean') throw new Error(`${this.at}：${key} 必须是 true / false`)
    return value
  }

  /** 原样的值，不校验（调用方自己判形状） */
  value(key: string): unknown {
    return this.take(key)
  }

  /** 任意有限数字 */
  number(key: string): number | undefined {
    const value = this.take(key)
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${this.at}：${key} 必须是数字`)
    return value
  }

  /** 字符串数组 */
  list(key: string): string[] | undefined {
    const value = this.take(key)
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${this.at}：${key} 必须是字符串数组`)
    return value as string[]
  }

  /** 原样的对象（驱动自己再解释，如透传给上游的请求体字段） */
  object(key: string, options: { required?: boolean } = {}): Record<string, unknown> | undefined {
    const value = this.take(key)
    if (value === undefined || value === null) return options.required ? this.missing(key) : undefined
    if (!isRecord(value)) throw new Error(`${this.at}：${key} 必须是对象`)
    return value
  }

  /** 嵌套的一段：父级 `done()` 时一并检查 */
  nested(key: string): Fields {
    const child = new Fields(this.take(key), `${this.at}.${key}`, this.env, this.problems)
    this.children.push(child)
    return child
  }

  /** http(s) 地址，去掉结尾的 `/` */
  url(key: string, options: FieldOptions<string> & ({ required: true } | { default: string })): string
  url(key: string, options?: FieldOptions<string>): string | undefined
  url(key: string, options: FieldOptions<string> = {}): string | undefined {
    const value = this.string(key, options)
    if (value === undefined) return undefined
    if (!/^https?:\/\/[^\s]+$/i.test(value)) throw new Error(`${this.at}：${key} 必须是 http(s) 地址`)
    return value.replace(/\/+$/, '')
  }

  /**
   * 密钥：**只认 `"$环境变量名"`**（密钥不进文件），读出变量的值。变量没设 / 为空：`required` 时记一条
   * {@link Fields.unavailable}（应用不可用，不是启动错误），都返回 undefined。写了别的东西是启动错误，且报错里不带原值（它可能就是一把明文 key）。
   */
  secret(key: string, options: { required?: boolean } = {}): string | undefined {
    const value = this.take(key)
    if (value === undefined || value === null || value === '') {
      if (options.required) this.unavailable(`没有配置 ${key}`)
      return undefined
    }
    const ref = typeof value === 'string' ? ENV_REF.exec(value.trim()) : null
    if (!ref) throw new Error(`${this.at}：${key} 只能写成 "$环境变量名"（密钥不进文件）`)
    const resolved = this.env.envVar(ref[1]!)?.trim()
    if (!resolved) {
      if (options.required) this.unavailable(`${key} 引用的环境变量 ${ref[1]} 没有设置`)
      return undefined
    }
    return resolved
  }

  /** 读完了：还有没读过的字段 = 不认识，抛。执行层在 `parseProvider` / `prepare` 之后调，驱动不用调 */
  done(): void {
    for (const child of this.children) child.done()
    const unknown = Object.keys(this.raw).filter((key) => !this.seen.has(key))
    if (unknown.length > 0) throw new Error(`${this.at}：不认识的字段 ${unknown.join('、')}`)
  }
}
