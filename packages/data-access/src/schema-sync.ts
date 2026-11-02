import type { MikroORM } from '@mikro-orm/core'

/**
 * 表结构同步 —— 把库对齐到实体定义，**没有迁移文件**（理由见 docs/05-data-persistence.md）。
 *
 * 语义照着 `prisma db push` 来，只是**没有 `--accept-data-loss`**：
 * - 只放行「加东西」的变更：建表、加列、建索引、删索引、加约束；
 * - 会丢数据的变更**拒绝执行**，把具体语句报出来。这里是服务的启动路径，不接受 `force`：宁可起不来，也不静默丢数据。
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
 * 比对时**不看**库里那些实体里没有的表：它们不归这里管，留着不碍事。
 * 典型的是别的模块的表 —— 实体由各模块登记（`entity-registry.ts`），这个进程没引入的模块，它的表就在模型之外。
 * 只在结果里列出来，提醒一句。
 *
 * **光传 `dropTables: false` 不够**（实测，MikroORM 7.2.5，PostgreSQL）：比对时这些表算「被删除的表」，它只跳过 `drop table`，
 * 指向它们的外键（`orphanedForeignKeys`）照样 `drop constraint`。于是模型之外的 `flow → project` 这种外键被悄悄删掉，既不算有损，也没有报错。
 * 所以先认出这些表，再用 `skipTables` 把它们整个排除在比对之外（{@link planSchemaSync}）。
 */

/** 一句有损的 SQL 属于哪一类 */
export type DataLossKind = '删表' | '删列' | '改列类型' | '表重建' | '改名' | '清数据'

export interface DataLossStatement {
  kind: DataLossKind
  statement: string
}

/**
 * 有损语句的判据。按两种库的实际输出写的（样本见 test/schema-sync.test.ts），
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

/** `drop table [if exists] ["schema".]"x" [cascade]` 里的表名，不带 schema（连接串带 `?schema=` 时语句里有前缀） */
function droppedTable(statement: string): string | null {
  const match = /\bdrop\s+table\s+(?:if\s+exists\s+)?(?:[`"]?[^`"\s.;]+[`"]?\.)?[`"]?([^`"\s.;]+)/i.exec(statement)
  return match ? match[1] : null
}

export interface SchemaSyncPlan {
  /** 将要执行的完整 SQL（空串 = 已经一致） */
  sql: string
  /** 拆好的单句，给人看的 */
  statements: string[]
  /** 其中会丢数据的那些 */
  dataLoss: DataLossStatement[]
  /** 库里有、实体里没有的表。不动它们 */
  unmanagedTables: string[]
}

/** 只算不做：库和实体差在哪、哪些会丢数据 */
export async function planSchemaSync(orm: MikroORM): Promise<SchemaSyncPlan> {
  // 先算一遍「连模型之外的表也算上」会删哪些表，认出它们
  const full = await orm.schema.getUpdateSchemaSQL({ dropTables: true })
  const unmanagedTables = splitStatements(full)
    .map(droppedTable)
    .filter((name): name is string => Boolean(name))
    // 整表重建里那句 drop 删的是模型里的表（随后改名回来），不是「模型之外」
    .filter((name) => !full.includes(`${name}__temp_alter`))

  // 再把它们排除在比对之外，算真正要执行的语句（原因见文件头）。生成器的配置只有这一个入口，算完还原：下次规划要重新认这些表。
  // skipTables 只按表名匹配，目标侧也生效：别的 schema 里有张同名表时（语句是 `drop table "other"."user"`），排除这个名字就连自己的 user 也不建了
  const managed = new Set([...orm.getMetadata().getAll().values()].map((meta) => meta.tableName))
  const generator = orm.config.get('schemaGenerator')
  const configured = generator.skipTables
  generator.skipTables = [...(configured ?? []), ...unmanagedTables.filter((name) => !managed.has(name))]
  let sql: string
  try {
    sql = await orm.schema.getUpdateSchemaSQL({ dropTables: false })
  } finally {
    generator.skipTables = configured
  }

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
 * 算出差异、过守卫、执行。有损时抛 {@link SchemaDataLossError}，**一句都不执行**。
 */
export async function syncSchema(orm: MikroORM): Promise<SchemaSyncResult> {
  const plan = await planSchemaSync(orm)
  if (plan.statements.length === 0) return { ...plan, applied: false }

  if (plan.dataLoss.length > 0) throw new SchemaDataLossError(plan.dataLoss)

  await orm.schema.execute(plan.sql)
  return { ...plan, applied: true }
}
