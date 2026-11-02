import path from 'node:path'

export interface ConfigServiceInit {
  rootDir: string
  dataDir: string
  isProduction: boolean
  /** config.yaml 顶层的各段，原样保留 */
  values: Record<string, unknown>
  /** 敏感值的来源：运行目录的 .env 合上进程环境变量，进程环境变量优先。默认空 */
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * 进程的配置来源，经依赖注入拿到。**类本身就是注入 token**，所以进程里只能有一份：
 * 业务包把 `@learning/config` 声明成 peerDependency，`@learning/data-access` 的 esbuild 产物也不能内联它。
 *
 * 这里只管文件和目录，不校验各段内容：每段的校验和默认值归读它的模块。
 */
export class ConfigService {
  /** 仓库根（找不到 pnpm-workspace.yaml 时是 cwd），相对路径的基准 */
  readonly rootDir: string
  /** config.yaml 和默认 SQLite 库所在的目录 */
  readonly dataDir: string
  readonly isProduction: boolean
  private readonly values: Record<string, unknown>
  private readonly envValues: Readonly<Record<string, string | undefined>>

  constructor(init: ConfigServiceInit) {
    this.rootDir = init.rootDir
    this.dataDir = init.dataDir
    this.isProduction = init.isProduction
    this.values = init.values
    this.envValues = init.env ?? {}
  }

  /** 按段取原始值，没有这一段是 undefined */
  section(name: string): unknown {
    return this.values[name]
  }

  /** 按段取映射：没写或写了空段（`session:`）是 `{}`，写成别的类型抛错。段内的字段由调用方校验 */
  mapping(name: string): Record<string, unknown> {
    const value = this.section(name)
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`[config] ${name} 段必须是映射`)
    return value as Record<string, unknown>
  }

  /** 取敏感值（密钥、带密码的连接串）。没设或只有空白都是 undefined，前后空白不算值的一部分 */
  env(name: string): string | undefined {
    return this.envValues[name]?.trim() || undefined
  }

  /** 相对路径按 {@link rootDir} 解析（不随 cwd 变），绝对路径原样返回 */
  resolvePath(target: string): string {
    return path.resolve(this.rootDir, target)
  }
}
