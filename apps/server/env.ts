/**
 * 读取应用根目录的 .env —— 用 node 自带的 loadEnvFile，不引 dotenv。
 * 只有副作用，必须在任何读 process.env 的模块之前被求值：
 * config.ts 的第一条 import 就是它，index.ts 也显式引一次兜底。
 * 已经存在的环境变量优先，.env 不会覆盖（loadEnvFile 的默认行为）。
 */
import path from 'node:path'
import { appRoot } from './runtime.ts'

const envFile = path.join(appRoot, '.env')

try {
  process.loadEnvFile(envFile)
} catch {
  // 没有 .env 就算了，容器里一般直接给环境变量
}

export {}
