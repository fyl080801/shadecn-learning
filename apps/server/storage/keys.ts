import { randomUUID } from 'node:crypto'
import { encodeS3Path } from './s3.ts'

/**
 * 画布资源在桶里的目录分层 —— **键只在这里拼、只在这里认**：
 *
 * ```
 * <prefix>/assets/<uuid[0:2]>/<uuid[2:4]>/<uuid><ext>
 * ```
 *
 * - `prefix`（`S3_KEY_PREFIX`，默认 `canvas`）：桶里的根目录，几个环境共用一个桶时靠它隔开；
 * - 所有素材进**同一个 `assets/` 目录**，不按项目、画布、类别分；
 *   早先的键带 `projects/<projectId>/flows/<flowId>/<images|videos>/` 几层，那些对象和画布里存的地址
 *   原样保留、不迁移，只有新上传的走这里；
 * - **按 uuid 拆两级目录**（取 uuid 开头两段十六进制）：v4 的开头是随机的，文件均匀落进
 *   256 × 256 个目录，素材再多也不会把成千上万个文件堆进同一层；
 * - 文件名是 uuid：同名文件不会互相覆盖，地址也猜不出来。
 */

/** 图片 / 视频之外的类型在路由层就被 415 拦掉了，这里只认这两种 */
export function assetCategory(contentType: string): 'images' | 'videos' | null {
  if (contentType.startsWith('image/')) return 'images'
  if (contentType.startsWith('video/')) return 'videos'
  return null
}

/** 扩展名只取文件名里那段安全的；没有就不带 —— 对象的类型以 content-type 为准，扩展名只是给人看的 */
export function extensionOf(name: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]
  return ext ? `.${ext.toLowerCase()}` : ''
}

/** 素材目录（以 `/` 结尾） */
export function assetDir(prefix: string): string {
  return `${prefix ? `${prefix}/` : ''}assets/`
}

export function buildAssetKey(
  prefix: string,
  file: { name: string; contentType: string },
  id: string = randomUUID(),
): string {
  if (!assetCategory(file.contentType)) throw new Error(`不支持的资源类型：${file.contentType}`)
  return `${assetDir(prefix)}${id.slice(0, 2)}/${id.slice(2, 4)}/${id}${extensionOf(file.name)}`
}

/** 两级目录 / 文件名；两级目录必须正是文件名 uuid 的开头 */
const OWN_KEY_TAIL =
  /^([0-9a-f]{2})\/([0-9a-f]{2})\/\1\2[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9]{1,8})?$/

/**
 * 客户端带回来的键（分片上传的每一步）是不是素材目录里、我们拼出来的形状。
 * 分片上传不在服务端记会话，键由客户端带着走 —— 不校验的话，成员就能借自己画布的权限往桶里任意位置写。
 * 素材目录不再按项目分，所以这里只管形状；某次上传的键配不配它的 uploadId 由 S3 校验。
 */
export function isAssetKey(prefix: string, key: string): boolean {
  const dir = assetDir(prefix)
  return key.startsWith(dir) && OWN_KEY_TAIL.test(key.slice(dir.length))
}

/**
 * 节点里存的素材地址 → 对象键；不是本服务桶里、素材目录下、我们拼出来的形状 → null。
 *
 * `base` 是对象存储的地址前缀（`storage.objectUrl('')` = `<endpoint>/<bucket>/`）。只做字符串比对和解码，
 * **不发请求**：服务端拿到键之后按键去签名读，从不去请求节点里写的那个地址 —— 外部链接、`data:`、内网地址
 * 一律在这里就是 null（防 SSRF）。解码后再按 `encodeS3Path` 编回去必须逐字等于原文，`%2F`、`?`、`#` 之类的花样都过不去；
 * 键的形状另由 {@link isAssetKey} 把关（没有 `..`，只在素材目录里）。早先带 `projects/…` 几层的老键不认。
 */
export function assetKeyOfUrl(url: string, base: string, prefix: string): string | null {
  if (!base.endsWith('/') || !url.startsWith(base)) return null
  const encoded = url.slice(base.length)
  let key: string
  try {
    key = encoded.split('/').map((segment) => decodeURIComponent(segment)).join('/')
  } catch {
    return null
  }
  if (encodeS3Path(key) !== encoded) return null
  return isAssetKey(prefix, key) ? key : null
}
