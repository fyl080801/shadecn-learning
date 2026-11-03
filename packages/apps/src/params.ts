import { checkParamValue } from '@learning/contracts/apps'
import { AppError, PARAM_TYPES, type ParamSchema, type ParamSpec } from './contract.js'
import type { Fields, ParamPatch } from './driver.js'

/**
 * 参数校验：所有驱动共用一份（docs/29 §3.4）。驱动只声明参数表，拿到的 `values` 已经校验过、补齐了默认值 ——
 * 驱动里不再判「prompt 是不是字符串」。不认识的参数也报错（拼错的参数悄悄被忽略，生成出来的东西不对还查不出为什么）。
 */

/** 单个值的校验和前端是同一份（`@shadecn/shared/apps`）：前端的尺寸选择器据此判「这个值对这个应用合不合」 */
const checkOne = checkParamValue

/** 空值：没给、null、空串、空数组都当没给（表单提交上来的空输入框不该算「给了一个空 prompt」） */
const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

/**
 * 校验调用方的参数，补齐默认值（应用表的 `defaults` 优先于驱动给的 `default`）。
 * 有问题一次全报出来：`AppError('invalid_params')`，`detail` 是问题列表。
 */
export function resolveParams(
  schema: ParamSchema,
  defaults: Readonly<Record<string, unknown>>,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const issues: string[] = []
  for (const name of Object.keys(input)) {
    if (!(name in schema)) issues.push(`不认识的参数 ${name}（只认 ${Object.keys(schema).join(' / ') || '无'}）`)
  }
  const values: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(schema)) {
    let value = input[name]
    if (isEmpty(value)) value = defaults[name] ?? spec.default
    if (isEmpty(value)) {
      if (spec.required) issues.push(`缺少参数 ${name}`)
      continue
    }
    const problem = checkOne(name, spec, value)
    if (problem) issues.push(problem)
    else values[name] = value
  }
  if (issues.length > 0) throw new AppError('invalid_params', issues.join('；'), issues)
  return values
}

/** 启动时校验驱动给的参数表本身（类型拼错是驱动的 bug）和应用表的 `defaults`（不认识的参数、类型不对 = 应用表写错了） */
export function assertParamSchema(schema: ParamSchema, at: string): void {
  for (const [name, spec] of Object.entries(schema)) {
    if (!(PARAM_TYPES as readonly string[]).includes(spec.type)) throw new Error(`${at}：参数 ${name} 的类型 ${spec.type} 不存在`)
    if (spec.presets) {
      if (spec.type !== 'size') throw new Error(`${at}：参数 ${name} 不是 size，不能写 presets`)
      const tiers = spec.tiers ?? []
      for (const [ratio, sizes] of Object.entries(spec.presets)) {
        if (sizes.length !== tiers.length) throw new Error(`${at}：参数 ${name} 的 presets.${ratio} 要和 tiers 一样长（${tiers.length} 个）`)
        for (const size of sizes) {
          const problem = checkOne(name, { ...spec, tiers: [] }, size)
          if (problem) throw new Error(`${at}：参数 ${name} 的 presets.${ratio} 里 ${size} 不合法：${problem}`)
        }
      }
    }
    if (spec.default !== undefined) {
      const problem = checkOne(name, spec, spec.default)
      if (problem) throw new Error(`${at}：参数 ${name} 的默认值不对：${problem}`)
    }
  }
}

export function assertDefaults(schema: ParamSchema, defaults: Readonly<Record<string, unknown>>, at: string): void {
  for (const [name, value] of Object.entries(defaults)) {
    const spec = schema[name]
    if (!spec) throw new Error(`${at}：defaults 里的 ${name} 不是这个应用的参数（只认 ${Object.keys(schema).join(' / ')}）`)
    const problem = checkOne(name, spec, value)
    if (problem) throw new Error(`${at}：defaults 里的 ${problem}`)
  }
}

/** 给调用方看的参数表：应用表的 `defaults` 合进各项的 `default` */
export function publicParams(schema: ParamSchema, defaults: Readonly<Record<string, unknown>>): ParamSchema {
  const out: Record<string, ParamSpec> = {}
  for (const [name, spec] of Object.entries(schema)) {
    out[name] = name in defaults ? { ...spec, default: defaults[name] } : spec
  }
  return out
}

/** 从配置里读一条参数说明的部分字段（条目 `params` 的覆盖用）：没写的字段不出现 */
export function readPartialSpec(fields: Fields): Partial<ParamSpec> {
  const spec: Partial<ParamSpec> = {}
  const type = fields.oneOf('type', PARAM_TYPES)
  if (type) spec.type = type
  const description = fields.string('description')
  if (description) spec.description = description
  const required = fields.boolean('required')
  if (required !== undefined) spec.required = required
  const defaultValue = fields.value('default')
  if (defaultValue !== undefined) spec.default = defaultValue
  const enumValues = fields.value('enum')
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.some((v) => typeof v !== 'string' && typeof v !== 'number')) {
      throw new Error(`${fields.at}：enum 必须是字符串 / 数字的数组`)
    }
    spec.enum = enumValues as (string | number)[]
  }
  for (const key of ['min', 'max', 'maxLength', 'minPixels', 'maxPixels', 'maxAspect'] as const) {
    const value = fields.number(key)
    if (value !== undefined) spec[key] = value
  }
  const tiers = fields.list('tiers')
  if (tiers) spec.tiers = tiers
  const presets = fields.object('presets')
  if (presets) {
    for (const [ratio, sizes] of Object.entries(presets)) {
      if (!Array.isArray(sizes) || sizes.some((size) => typeof size !== 'string')) throw new Error(`${fields.at}：presets.${ratio} 必须是字符串数组`)
    }
    spec.presets = presets as Record<string, string[]>
  }
  return spec
}

/**
 * 从配置里读一条完整的参数说明（type 默认 string）—— 给「参数表由应用表决定」的驱动用（ComfyUI 的 `inputs`）。
 * `default` 的类型由 {@link assertParamSchema} 统一校验
 */
export function readParamSpec(fields: Fields): ParamSpec {
  return { type: 'string', ...readPartialSpec(fields) }
}

/** 读一段参数表改动（`{ 参数名: 部分说明 | null }`），见 `driver.ts` 的 `ParamPatch` */
export function readParamPatch(fields: Fields): ParamPatch {
  const patch: Record<string, Partial<ParamSpec> | null> = {}
  for (const name of Object.keys(fields.raw)) {
    if (fields.raw[name] === null) {
      fields.value(name)
      patch[name] = null
    } else {
      patch[name] = readPartialSpec(fields.nested(name))
    }
  }
  return patch
}

/**
 * 在参数表上套一段改动：`null` 删掉这个参数；部分说明和原说明合并（写了的字段替换，`enum` 整个替换）；
 * 原来没有的参数必须给 `type`。只返回新表，不改原表
 */
export function applyParamPatch(schema: ParamSchema, patch: ParamPatch | undefined, at: string): ParamSchema {
  if (!patch) return schema
  const out: Record<string, ParamSpec> = { ...schema }
  for (const [name, change] of Object.entries(patch)) {
    if (change === null) {
      delete out[name]
      continue
    }
    const base = out[name]
    if (!base && !change.type) throw new Error(`${at}：参数 ${name} 原来没有，新加时要写 type`)
    out[name] = { ...base, ...change } as ParamSpec
  }
  return out
}
