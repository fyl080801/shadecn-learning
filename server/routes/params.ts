/**
 * 路由层共用的参数校验。
 * 错误信息直接面向调用方，统一由路由包成 `{ error }` 400 返回。
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface Pagination {
  page: number
  pageSize: number
}

export const PAGE_SIZE_MAX = 100
const NAME_MAX = 80

/** page 默认 1，pageSize 默认 20、上限 100；越界一律 400 而不是悄悄夹紧 */
export function parsePagination(
  query: Record<string, string | undefined>,
  defaultPageSize = 20,
): ParseResult<Pagination> {
  const page = parsePositiveInt(query.page, 1)
  if (page === null) return { ok: false, error: 'page 必须是正整数' }

  const pageSize = parsePositiveInt(query.pageSize, defaultPageSize)
  if (pageSize === null) return { ok: false, error: 'pageSize 必须是正整数' }
  if (pageSize > PAGE_SIZE_MAX) {
    return { ok: false, error: `pageSize 不能超过 ${PAGE_SIZE_MAX}` }
  }

  return { ok: true, value: { page, pageSize } }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return null
  return value
}

/** 名称：非空字符串，trim 后 1..80 字符 */
export function parseName(value: unknown, field = 'name'): ParseResult<string> {
  if (typeof value !== 'string') return { ok: false, error: `${field} 必须是字符串` }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, error: `${field} 不能为空` }
  if (trimmed.length > NAME_MAX) {
    return { ok: false, error: `${field} 不能超过 ${NAME_MAX} 个字符` }
  }
  return { ok: true, value: trimmed }
}

/** 可选的描述字段：字符串或 null */
export function parseDescription(value: unknown): ParseResult<string | null> {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: 'description 必须是字符串或 null' }
  return { ok: true, value }
}

/** 请求体读取：非法 JSON 统一给同一句话 */
export async function readJson<T>(request: { json: () => Promise<unknown> }): Promise<T | null> {
  return (await request.json().catch(() => null)) as T | null
}

export const INVALID_JSON = '请求体不是合法 JSON'
