import type { ConfigService } from '@learning/config'
import type { S3Options } from './s3.js'

export const STORAGE_OPTIONS = Symbol('STORAGE_OPTIONS')

/** config.yaml 的 `storage` 段解析之后的样子 */
export interface StorageOptions {
  /** 连接参数；没配齐 = null：上传接口回 503，服务照常启动 */
  s3: S3Options | null
  /** 整个文件的上限（字节） */
  maxUploadBytes: number
  /** 对象键的根目录，默认 `canvas`；空串 = 桶根 */
  keyPrefix: string
}

const ACCESS_KEY_ENV = 'PLATFORM_S3_ACCESS_KEY_ID'
const SECRET_KEY_ENV = 'PLATFORM_S3_SECRET_ACCESS_KEY'
const DEFAULT_ENDPOINT = 'https://s3.fyl080801.uk'

function stringField(section: Record<string, unknown>, key: string): string | undefined {
  const value = section[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`[storage] storage.${key} 必须是字符串`)
  return value.trim()
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '')

/**
 * 校验和默认值都在这里（`@learning/config` 只管文件）。写错的值拒绝启动；**三样缺一个只是功能关闭**：
 * 对象存储是可选的外部服务，不能因为它让登录和画布起不来。
 * 密钥只从 `.env` / 环境变量取，写进 config.yaml 就拒绝启动：配置文件常被整份放进 ConfigMap、贴进工单。
 */
export function resolveStorageOptions(config: ConfigService): StorageOptions {
  const section = config.mapping('storage')
  for (const field of ['accessKeyId', 'secretAccessKey']) {
    if (section[field] !== undefined && section[field] !== null) {
      throw new Error(`[storage] 密钥不能写在 config.yaml 的 storage.${field}，放到运行目录 .env 的 ${ACCESS_KEY_ENV} / ${SECRET_KEY_ENV}`)
    }
  }

  const maxUploadMb = section.maxUploadMb ?? 100
  if (typeof maxUploadMb !== 'number' || !Number.isFinite(maxUploadMb) || maxUploadMb <= 0) {
    throw new Error('[storage] storage.maxUploadMb 必须是正数')
  }

  const bucket = stringField(section, 'bucket') ?? ''
  const accessKeyId = config.env(ACCESS_KEY_ENV) ?? ''
  const secretAccessKey = config.env(SECRET_KEY_ENV) ?? ''
  const endpoint = stringField(section, 'endpoint')
  const internalEndpoint = stringField(section, 'internalEndpoint') ?? ''
  const complete = bucket !== '' && accessKeyId !== '' && secretAccessKey !== ''
  if (!complete) console.log(`[storage] 没配 storage.bucket / ${ACCESS_KEY_ENV} / ${SECRET_KEY_ENV}：上传接口回 503，别的功能照常`)

  return {
    s3: complete
      ? {
          endpoint: withoutTrailingSlash(endpoint || DEFAULT_ENDPOINT),
          requestEndpoint: withoutTrailingSlash(internalEndpoint),
          region: stringField(section, 'region') || 'us-east-1',
          bucket,
          accessKeyId,
          secretAccessKey,
        }
      : null,
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    keyPrefix: (stringField(section, 'keyPrefix') ?? 'canvas').replace(/^\/+|\/+$/g, ''),
  }
}
