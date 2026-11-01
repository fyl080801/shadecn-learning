import { setting } from '@shadecn/server-kit/config'
import type { ModuleConfig } from '@shadecn/server-kit/kernel'
import type { S3Options } from './s3.ts'

/**
 * 对象存储模块的配置段：`modules.storage`（docs/28 §3.3）。每项对应一个环境变量（原名不变），环境变量优先于文件。
 *
 * - `S3_ENDPOINT`：**公开**地址，默认 `https://s3.fyl080801.uk`。节点 `data.src` 存的、浏览器直接读的都是 `<它>/<bucket>/<key>`，
 *   所以桶要对匿名开放读（`s3:GetObject`），否则画布上的图都是裂的；
 * - `S3_INTERNAL_ENDPOINT`：服务端自己发请求（上传、读字节给 agent 看图）用的地址，空 = 和 `S3_ENDPOINT` 一样。
 *   集群里走内网 Service 用它；浏览器照旧读 `S3_ENDPOINT`（两边必须是同一个桶、同一份数据）；
 * - `S3_REGION`：签名用的 region，默认 `us-east-1`（MinIO 一类自建服务没改过就是它）；
 * - `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`：三样缺一个就是**没开**（模块不加载：上传接口不存在，
 *   agent 没有看图工具，`/api/features.storage` 为 false）；
 * - `S3_MAX_UPLOAD_MB`：单个文件上限，默认 100；
 * - `S3_KEY_PREFIX`：对象键的根目录，默认 `canvas`；几个环境共用一个桶时用它隔开（如 `dev/canvas`）。
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

export const storageConfig: ModuleConfig<StorageConfig> = {
  schema: {
    endpoint: setting('S3_ENDPOINT', 'string', '浏览器访问得到的公开地址'),
    internalEndpoint: setting('S3_INTERNAL_ENDPOINT', 'string', '服务端自己发请求用的地址'),
    region: setting('S3_REGION', 'string'),
    bucket: setting('S3_BUCKET', 'string'),
    accessKeyId: setting('S3_ACCESS_KEY_ID', 'string'),
    secretAccessKey: setting('S3_SECRET_ACCESS_KEY', 'string'),
    maxUploadMb: setting('S3_MAX_UPLOAD_MB', 'number', '单个文件上限（MB）'),
    keyPrefix: setting('S3_KEY_PREFIX', 'string', '对象键的根目录'),
  },
  parse(read) {
    const bucket = read('S3_BUCKET')?.trim() ?? ''
    const accessKeyId = read('S3_ACCESS_KEY_ID')?.trim() ?? ''
    const secretAccessKey = read('S3_SECRET_ACCESS_KEY')?.trim() ?? ''
    const maxUploadMb = Number(read('S3_MAX_UPLOAD_MB')?.trim() || 100)
    if (!Number.isFinite(maxUploadMb) || maxUploadMb <= 0) throw new Error(`S3_MAX_UPLOAD_MB 必须是正数：${read('S3_MAX_UPLOAD_MB')}`)
    return {
      s3:
        bucket && accessKeyId && secretAccessKey
          ? {
              endpoint: (read('S3_ENDPOINT')?.trim() || 'https://s3.fyl080801.uk').replace(/\/+$/, ''),
              requestEndpoint: (read('S3_INTERNAL_ENDPOINT')?.trim() ?? '').replace(/\/+$/, ''),
              region: read('S3_REGION')?.trim() || 'us-east-1',
              bucket,
              accessKeyId,
              secretAccessKey,
            }
          : null,
      maxUploadBytes: maxUploadMb * 1024 * 1024,
      keyPrefix: (read('S3_KEY_PREFIX')?.trim() ?? 'canvas').replace(/^\/+|\/+$/g, ''),
    }
  },
}
