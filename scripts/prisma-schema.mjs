/**
 * 把 prisma/models.prisma 展开成每个 provider 一份完整 schema。
 *
 *   node scripts/prisma-schema.mjs           生成 prisma/schema.{sqlite,postgresql}.prisma
 *   node scripts/prisma-schema.mjs --check   只校验：磁盘上的两份和模型对不上就退出码 1
 *
 * prisma 的 datasource provider 只能写字面量（不能 env()），一份 schema 也只能有一个
 * datasource —— 想同时支持两种库，就只能有两份 schema 文件。模型部分手写一次、机器展开，
 * 这样两边永远不会跑偏；--check 挂在 pnpm test / build 前面当守卫。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DB_PROVIDERS, rootDir, schemaPathOf } from '../prisma/db-provider.mjs'

const MODELS_FILE = path.join(rootDir, 'prisma/models.prisma')

/** 每个 provider 的 datasource 块。url 不写死在这里 —— 由 prisma.config.ts 注入 */
function render(provider, models) {
  return [
    `// 本文件由 scripts/prisma-schema.mjs 生成，不要手改。`,
    `// 模型定义在 prisma/models.prisma，改完跑 \`pnpm db:schema\` 重新生成。`,
    ``,
    `datasource db {`,
    `  provider = "${provider}"`,
    `}`,
    ``,
    models.trimStart(),
  ].join('\n')
}

const models = readFileSync(MODELS_FILE, 'utf8')
const check = process.argv.includes('--check')
const stale = []

for (const provider of DB_PROVIDERS) {
  const file = path.join(rootDir, schemaPathOf(provider))
  const next = render(provider, models)
  const current = safeRead(file)

  if (current === next) continue
  if (check) {
    stale.push(path.relative(rootDir, file))
    continue
  }
  writeFileSync(file, next)
  console.log(`[prisma-schema] 已生成 ${path.relative(rootDir, file)}`)
}

if (stale.length > 0) {
  console.error(
    `[prisma-schema] 这些 schema 和 prisma/models.prisma 不一致：${stale.join('、')}\n` +
      `              跑一下 \`pnpm db:schema\` 再提交。`,
  )
  process.exit(1)
}

function safeRead(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
