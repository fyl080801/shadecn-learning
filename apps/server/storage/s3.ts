import { createHash, createHmac } from 'node:crypto'

/**
 * 最小的 S3 客户端：`PutObject`、`HeadObject` 和分片上传那四个动作，签名是手写的 AWS SigV4。
 *
 * 不引 `@aws-sdk/client-s3`：我们只往一个桶里写，SDK 那一大包（和它进运行时依赖的一串子包）
 * 换来的只是这一个文件。
 *
 * 一律 path-style（`<endpoint>/<bucket>/<key>`）：自建的 MinIO 一类服务大多不配泛域名，
 * virtual-host 风格（`<bucket>.<host>`）在它们那儿解析不到。
 */

export interface S3Options {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface S3Client {
  /** 写一个对象，返回它的原始地址（= `objectUrl(key)`）。非 2xx 抛错，带上 S3 回的错误码 */
  putObject(key: string, body: Uint8Array, contentType: string): Promise<string>
  /** 对象的实际大小与类型；不存在回 null */
  headObject(key: string): Promise<{ size: number; contentType: string } | null>
  /** 开一次分片上传，回 `uploadId`。对象的 content-type 在这一步定 */
  createMultipartUpload(key: string, contentType: string): Promise<string>
  /** 传一片（`partNumber` 从 1 起），回这片的 ETag（原样，带引号） */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string>
  /** 按片号升序拼成对象，回原始地址 */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<string>
  /** 放弃：S3 删掉已传的片。对一个已经不存在的上传也算成功 */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>
  /** 对象的原始地址：读资源直接用它，不经后端 */
  objectUrl(key: string): string
}

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** SigV4 的 URI 编码：RFC 3986 非保留字符原样，其余（含 `/`）一律百分号编码 */
function encodeS3Component(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** S3 的路径编码：逐段 `encodeS3Component`，`/` 作为分段符保留，**不二次编码**。query 里的 `/` 则要编码 */
export function encodeS3Path(path: string): string {
  return path.split('/').map(encodeS3Component).join('/')
}

/** `20130524T000000Z` */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export interface SignInput {
  method: string
  url: URL
  /** 要签进去的头（小写名）；`host` / `x-amz-date` / `x-amz-content-sha256` 由这里补 */
  headers: Record<string, string>
  payloadHash: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  date: Date
}

/**
 * SigV4 签名（service = s3），返回完整的请求头（含 `authorization`）。
 * 单独导出是为了拿 AWS 文档里的样例逐字对答案。
 */
export function signS3Request(input: SignInput): Record<string, string> {
  const timestamp = amzDate(input.date)
  const day = timestamp.slice(0, 8)
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: input.url.host,
    'x-amz-date': timestamp,
    'x-amz-content-sha256': input.payloadHash,
  }
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')

  const query = canonicalQuery(Object.fromEntries(input.url.searchParams.entries()))

  const canonicalRequest = [
    input.method,
    // URL 已经按 encodeS3Path 编过一遍，pathname 原样就是规范路径
    input.url.pathname || '/',
    query,
    names.map((name) => `${name}:${headers[name]}\n`).join(''),
    signedHeaders,
    input.payloadHash,
  ].join('\n')

  const scope = `${day}/${input.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${input.secretAccessKey}`, day)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** 从 S3 的 XML 错误体里抠 `<Code>`，抠不到就算了 */
function errorCode(text: string): string {
  return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? ''
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** query 按签名用的规范形式拼：线上发出去的和签进去的必须逐字一致（`?uploads` 也写成 `uploads=`） */
function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [encodeS3Component(k), encodeS3Component(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

export function createS3Client(options: S3Options): S3Client {
  const objectUrl = (key: string) => `${options.endpoint}/${encodeS3Path(options.bucket)}/${encodeS3Path(key)}`

  /** 签名并发出一个请求；非 2xx 抛错（`allow` 里的状态码除外），错误信息带上 S3 的错误码 */
  async function send(
    action: string,
    init: {
      method: string
      key: string
      query?: Record<string, string>
      body?: Uint8Array
      contentType?: string
      allow?: readonly number[]
    },
  ): Promise<Response> {
    const url = new URL(objectUrl(init.key))
    url.search = canonicalQuery(init.query ?? {})
    const body = init.body ?? new Uint8Array()
    const headers = signS3Request({
      method: init.method,
      url,
      headers: init.contentType ? { 'content-type': init.contentType } : {},
      payloadHash: sha256Hex(body),
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      date: new Date(),
    })
    // host 由 fetch 自己带，手动设反而会被拒（forbidden header）
    delete headers.host

    const res = await fetch(url, {
      method: init.method,
      headers,
      body: init.method === 'GET' || init.method === 'HEAD' ? undefined : body,
    })
    if (!res.ok && !init.allow?.includes(res.status)) {
      const code = errorCode(await res.text().catch(() => ''))
      throw new Error(`S3 ${action} 失败：${res.status}${code ? ` ${code}` : ''}`)
    }
    return res
  }

  return {
    objectUrl,

    async putObject(key, body, contentType) {
      await send('PutObject', { method: 'PUT', key, body, contentType })
      return objectUrl(key)
    },

    async headObject(key) {
      const res = await send('HeadObject', { method: 'HEAD', key, allow: [404] })
      if (res.status === 404) return null
      return {
        size: Number(res.headers.get('content-length') ?? 0),
        contentType: res.headers.get('content-type') ?? '',
      }
    },

    async createMultipartUpload(key, contentType) {
      const res = await send('CreateMultipartUpload', {
        method: 'POST',
        key,
        query: { uploads: '' },
        contentType,
      })
      const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await res.text())?.[1]
      if (!uploadId) throw new Error('S3 CreateMultipartUpload 失败：回包里没有 UploadId')
      return uploadId
    },

    async uploadPart(key, uploadId, partNumber, body) {
      const res = await send('UploadPart', {
        method: 'PUT',
        key,
        query: { partNumber: String(partNumber), uploadId },
        body,
      })
      const etag = res.headers.get('etag')
      if (!etag) throw new Error('S3 UploadPart 失败：回包里没有 ETag')
      return etag
    },

    async completeMultipartUpload(key, uploadId, parts) {
      const xml =
        '<CompleteMultipartUpload>' +
        parts
          .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
          .join('') +
        '</CompleteMultipartUpload>'
      const res = await send('CompleteMultipartUpload', {
        method: 'POST',
        key,
        query: { uploadId },
        body: new TextEncoder().encode(xml),
        contentType: 'application/xml',
      })
      // 坑：Complete 可能回 200 但正文是 <Error>（拼接过程中出错时 S3 先发了状态行）
      const text = await res.text()
      if (text.includes('<Error>')) {
        throw new Error(`S3 CompleteMultipartUpload 失败：${errorCode(text) || '未知错误'}`)
      }
      return objectUrl(key)
    },

    async abortMultipartUpload(key, uploadId) {
      await send('AbortMultipartUpload', { method: 'DELETE', key, query: { uploadId }, allow: [404] })
    },
  }
}
