import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { LineCounter, parseDocument } from 'yaml'
import { ConfigService } from './config.service.js'

/**
 * 从 cwd 向上找 pnpm-workspace.yaml，找不到就用 cwd。
 * 不靠 import.meta.dirname：包装在 node_modules 下时文件位置和仓库根没有固定的层数关系；`pnpm --filter` 的 cwd 是 apps/platform，向上能找到。
 */
export function findRootDir(cwd: string): string {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    if (dir === path.dirname(dir)) return path.resolve(cwd)
  }
}

/** 文件不存在返回 null；其他读取失败（权限、是个目录）要拒绝启动，不能当成空配置悄悄走默认值 */
function readFileIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw new Error(`[config] 读取 ${file} 失败（${code ?? '未知错误'}）`, { cause: err })
  }
}

/**
 * 解析成顶层映射。空文件和只有注释的文件算空配置（示例文件复制过来全是注释时就是这样）。
 *
 * **错误信息只带路径和位置，不带内容**：文件里有密钥。yaml 默认的 message 会把出错的那几行贴出来（prettyErrors），
 * `toJS` 抛的 message 也可能带别名名字，所以这里只用错误码和行列。
 */
function parseConfig(file: string, source: string): Record<string, unknown> {
  const lineCounter = new LineCounter()
  const document = parseDocument(source, { prettyErrors: false, lineCounter })
  const [first] = document.errors
  if (first) {
    const { line, col } = lineCounter.linePos(first.pos[0])
    throw new Error(`[config] ${file} 不是合法的 YAML（第 ${line} 行第 ${col} 列，${first.code}）`)
  }

  let value: unknown
  try {
    value = document.toJS()
  } catch {
    throw new Error(`[config] ${file} 不是合法的 YAML（别名无法展开）`)
  }
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`[config] ${file} 的顶层必须是映射`)
  return value as Record<string, unknown>
}

/**
 * 读 `<dataDir>/config.yaml` 和 `<cwd>/.env`。dataDir = `DATA_DIR`（相对路径按仓库根），否则 `<rootDir>/data`。
 * config.yaml 不存在 = 空配置，全走各模块的默认值；语法错或顶层不是映射 = 抛错，拒绝启动。
 *
 * `.env` 只给 {@link ConfigService.env} 提供敏感值，进程环境变量优先，**不写回 `process.env`**：密钥不会漏给 Vite 之类的同进程依赖和子进程。
 * `NODE_ENV`、`DATA_DIR` 只认真正的进程环境变量：从仓库根启动时 cwd 下是 `@shadecn/server` 的 .env，它的 `DATA_DIR` 不能把这里带跑。
 */
export function loadConfig(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): ConfigService {
  const rootDir = findRootDir(cwd)
  const dataDir = path.resolve(rootDir, env.DATA_DIR?.trim() || 'data')
  const file = path.join(dataDir, 'config.yaml')

  const envSource = readFileIfExists(path.join(path.resolve(cwd), '.env'))
  const source = readFileIfExists(file)
  if (source === null) console.log(`[config] 没有 ${file}，全部走默认值`)

  return new ConfigService({
    rootDir,
    dataDir,
    isProduction: env.NODE_ENV === 'production',
    values: source === null ? {} : parseConfig(file, source),
    env: { ...(envSource === null ? {} : parseEnv(envSource)), ...env },
  })
}
