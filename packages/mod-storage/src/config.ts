import { setting, type ConfigPath } from '@shadecn/server-kit/config'
import { defineModuleConfig, moduleEnvName } from '@shadecn/server-kit/kernel'
import type { S3Options } from './s3.ts'

/**
 * 对象存储模块的配置段：`modules.storage`（docs/28 §3.3）。环境变量名由路径推导（`modules.storage.bucket` → `MODULES_STORAGE_BUCKET`），环境变量优先于文件。
 *
 * - `MODULES_STORAGE_ENDPOINT`：**公开**地址，默认 `https://s3.fyl080801.uk`。节点 `data.src` 存的、浏览器直接读的都是 `<它>/<bucket>/<key>`，
 *   所以桶要对匿名开放读（`s3:GetObject`），否则画布上的图都是裂的；
 * - `MODULES_STORAGE_INTERNAL_ENDPOINT`：服务端自己发请求（上传、读字节给 agent 看图）用的地址，空 = 和 `MODULES_STORAGE_ENDPOINT` 一样。
 *   集群里走内网 Service 用它；浏览器照旧读 `MODULES_STORAGE_ENDPOINT`（两边必须是同一个桶、同一份数据）；
 * - `MODULES_STORAGE_REGION`：签名用的 region，默认 `us-east-1`（MinIO 一类自建服务没改过就是它）；
 * - `MODULES_STORAGE_BUCKET` / `MODULES_STORAGE_ACCESS_KEY_ID` / `MODULES_STORAGE_SECRET_ACCESS_KEY`：三样缺一个就是**没开**（模块不加载：上传接口不存在，
 *   agent 没有看图工具，`/api/features.storage` 为 false）；
 * - `MODULES_STORAGE_MAX_UPLOAD_MB`：单个文件上限，默认 100；
 * - `MODULES_STORAGE_KEY_PREFIX`：对象键的根目录，默认 `canvas`；几个环境共用一个桶时用它隔开（如 `dev/canvas`）。
 *   之下按项目 / 画布 / 类别 / uuid 分层，见 `./keys.ts`。
 *
 * 密钥能写进文件，但生产上应当走环境变量 / Secret：配置文件常被整份放进 ConfigMap、贴进工单。
 */
export interface StorageConfig {
  /** 连接参数；没配齐 = null（模块关掉） */
  s3: S3Options | null
  maxUploadBytes: number
  keyPrefix: string
}

const schema = {
  endpoint: setting('string', '浏览器访问得到的公开地址'),
  internalEndpoint: setting('string', '服务端自己发请求用的地址'),
  region: setting('string'),
  bucket: setting('string'),
  accessKeyId: setting('string'),
  secretAccessKey: setting('string'),
  maxUploadMb: setting('number', '单个文件上限（MB）'),
  keyPrefix: setting('string', '对象键的根目录'),
}

/** 模块名：配置段 `modules.storage`、`/api/features` 的键 */
export const STORAGE_MODULE = 'storage'

/** 这一项对应的环境变量名（报错 / 提示文案用，别手写） */
export function storageEnv(path: ConfigPath<typeof schema>): string {
  return moduleEnvName(STORAGE_MODULE, path)
}

export const storageConfig = defineModuleConfig({
  schema,
  parse(read): StorageConfig {
    const bucket = read('bucket')?.trim() ?? ''
    const accessKeyId = read('accessKeyId')?.trim() ?? ''
    const secretAccessKey = read('secretAccessKey')?.trim() ?? ''
    const maxUploadMb = Number(read('maxUploadMb')?.trim() || 100)
    if (!Number.isFinite(maxUploadMb) || maxUploadMb <= 0) throw new Error(`${storageEnv('maxUploadMb')} 必须是正数：${read('maxUploadMb')}`)
    return {
      s3:
        bucket && accessKeyId && secretAccessKey
          ? {
              endpoint: (read('endpoint')?.trim() || 'https://s3.fyl080801.uk').replace(/\/+$/, ''),
              requestEndpoint: (read('internalEndpoint')?.trim() ?? '').replace(/\/+$/, ''),
              region: read('region')?.trim() || 'us-east-1',
              bucket,
              accessKeyId,
              secretAccessKey,
            }
          : null,
      maxUploadBytes: maxUploadMb * 1024 * 1024,
      keyPrefix: (read('keyPrefix')?.trim() ?? 'canvas').replace(/^\/+|\/+$/g, ''),
    }
  },
})
