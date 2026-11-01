import type { MikroORM } from '@mikro-orm/core'

/**
 * 表结构同步 —— 把库对齐到实体定义，**没有迁移文件**（理由见 docs/05-data-persistence.md）。
 *
 * 这是 Prisma 时代 `prisma db push` 的替代品，语义也照着它来：
 * - 默认只放行「加东西」的变更：建表、加列、建索引、删索引、加约束；
 * - 会丢数据的变更**拒绝执行**，把具体语句报出来，要人看一眼再显式加 `--force`
 *   （相当于原来的 `--accept-data-loss`）。
 *
 * ## 为什么要自己写这道守卫
 *
 * MikroORM 的 `schema.update({ safe: true })` 挡不住有损变更，两种库各有各的漏法（实测）：
 * - SQLite 改列（改类型、改可空、改默认值）一律走「建 `<表>__temp_alter` → 拷数据 → 删原表 → 改名」
 *   的整表重建，`safe` 管不到这条路；
 * - PostgreSQL 下 `safe` 只跳过 `drop column`，改列类型（`alter column ... type`）照做不误。
 *
 * 所以这里不用 `update()`，而是先 `getUpdateSchemaSQL()` 拿到**将要执行的那段 SQL**，
 * 逐句判过之后再原样交给 `schema.execute()` —— 判的和执行的是同一段文本，中间没有第二次比对。
 *
 * ## 模型之外的表
 *
 * 默认模式下比对时**不看**库里那些实体里没有的表（`dropTables: false`）：它们不归这里管，
 * 留着不碍事（典型的就是换 ORM 之前 Prisma 建的那批 `"User"` `"Session"`）。只在结果里列出来，
 * 提醒一句。`--force` 才把它们算进去 —— 那时它们会和其它有损变更一起被删掉。
 */

/** 一句有损的 SQL 属于哪一类 */
export type DataLossKind = '删表' | '删列' | '改列类型' | '表重建' | '改名' | '清数据'

export interface DataLossStatement {
  kind: DataLossKind
  statement: string
}

/**
 * 有损语句的判据。按两种库的实际输出写的（样本见 apps/server/test/db/schema-sync.test.ts），
 * 判的是**整句**而不是开头几个词：SQLite 的整表重建里，危险的那句 `drop table` 夹在中间。
 *
 * 反过来，这几类**放行**：`create table` / `alter table ... add` / `create [unique] index` /
 * `drop index` / `alter table ... add constraint` / `alter column ... set|drop not null|default` ——
 * 它们要么只加不减，要么失败了也是当场报错、不会悄悄丢数据。
 */
const RULES: ReadonlyArray<readonly [DataLossKind, RegExp]> = [
  // SQLite 改列的整表重建：数据靠一句 insert ... select 搬过去，列一变就可能搬丢
  ['表重建', /__temp_alter\b/i],
  ['删表', /\bdrop\s+table\b/i],
  ['删列', /\bdrop\s+column\b/i],
  // PostgreSQL：alter column "x" type text using (...)；也认标准写法 set data type
  ['改列类型', /\balter column [^ ]+ (?:set data )?type\b/i],
  // 列 / 表改名：MikroORM 按启发式判「删一列 + 加一列」是不是改名，判错了数据就挪到了别的列上
  ['改名', /\brename\s+(?:column\b|to\b)/i],
  ['清数据', /^\s*(?:truncate|delete\s+from)\b/i],
]

/** 把 MikroORM 吐出来的一段 DDL 拆成单句（它的格式是一句一行、以 `;` 结尾） */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
}

/** 挑出会丢数据的语句；一句只归一类（按 {@link RULES} 的顺序取第一个命中的） */
export function findDataLoss(sql: string): DataLossStatement[] {
  const found: DataLossStatement[] = []
  for (const statement of splitStatements(sql)) {
    // 先把空白压成单个空格：判据就能写成不带嵌套量词的正则（多行语句、多个空格都一样认）
    const flat = statement.replace(/\s+/g, ' ')
    const hit = RULES.find(([, pattern]) => pattern.test(flat))
    if (hit) found.push({ kind: hit[0], statement })
  }
  return found
}

/** `drop table [if exists] "x" [cascade]` 里的表名 */
function droppedTable(statement: string): string | null {
  const match = /\bdrop\s+table\s+(?:if\s+exists\s+)?([`"]?)([^`"\s;]+)\1/i.exec(statement)
  return match ? match[2] : null
}

export interface SchemaSyncPlan {
  /** 将要执行的完整 SQL（空串 = 已经一致） */
  sql: string
  /** 拆好的单句，给人看的 */
  statements: string[]
  /** 其中会丢数据的那些 */
  dataLoss: DataLossStatement[]
  /** 库里有、实体里没有的表。默认模式下不动它们，`force` 时它们出现在 `dataLoss` 的「删表」里 */
  unmanagedTables: string[]
}

export interface SchemaSyncOptions {
  /** 放行有损变更（并把模型之外的表一起删掉）。相当于 Prisma 的 `--accept-data-loss` */
  force?: boolean
}

/** 只算不做：库和实体差在哪、哪些会丢数据 */
export async function planSchemaSync(
  orm: MikroORM,
  options: SchemaSyncOptions = {},
): Promise<SchemaSyncPlan> {
  const force = options.force ?? false
  const sql = await orm.schema.getUpdateSchemaSQL({ dropTables: force })

  // 默认模式下另算一遍「连模型之外的表也算上」会删哪些表，只为了报出来
  const full = force ? sql : await orm.schema.getUpdateSchemaSQL({ dropTables: true })
  const unmanagedTables = splitStatements(full)
    .map(droppedTable)
    .filter((name): name is string => Boolean(name))
    // 整表重建里那句 drop 删的是模型里的表（随后改名回来），不是「模型之外」
    .filter((name) => !full.includes(`${name}__temp_alter`))

  return {
    sql,
    statements: splitStatements(sql),
    dataLoss: findDataLoss(sql),
    unmanagedTables,
  }
}

/** 有损变更被拒绝 —— 带着具体语句，调用方原样报给人看 */
export class SchemaDataLossError extends Error {
  readonly statements: DataLossStatement[]

  constructor(statements: DataLossStatement[]) {
    super(
      `表结构变更会丢数据，已拒绝执行（${statements.length} 句）：\n` +
        statements.map(({ kind, statement }) => `  [${kind}] ${statement}`).join('\n'),
    )
    this.name = 'SchemaDataLossError'
    this.statements = statements
  }
}

export interface SchemaSyncResult extends SchemaSyncPlan {
  /** 是否真的执行了（已经一致时为 false） */
  applied: boolean
}

/**
 * 算出差异、过守卫、执行。有损且没给 `force` 时抛 {@link SchemaDataLossError}，**一句都不执行**。
 */
export async function syncSchema(
  orm: MikroORM,
  options: SchemaSyncOptions = {},
): Promise<SchemaSyncResult> {
  const plan = await planSchemaSync(orm, options)
  if (plan.statements.length === 0) return { ...plan, applied: false }

  if (plan.dataLoss.length > 0 && !options.force) throw new SchemaDataLossError(plan.dataLoss)

  await orm.schema.execute(plan.sql)
  return { ...plan, applied: true }
}

/**
 * 清空重建：先删掉实体对应的全部表，再完整同步一遍（含删除模型之外的表）。
 * **只给专用测试库用**（`apps/server/test/global-setup.ts`），任何有数据的库都别碰。
 */
export async function resetSchema(orm: MikroORM): Promise<SchemaSyncResult> {
  await orm.schema.drop()
  return syncSchema(orm, { force: true })
}
