import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetStorage } from '../src/asset-storage.js'
import type { FlowAssets } from '../src/flow-assets.js'
import { createS3Client } from '../src/s3.js'

const PUBLIC = 'https://s3.example.test'
const INTERNAL = 'http://minio.internal:9000'
const BUCKET = 'canvas-bucket'
const BASE = `${PUBLIC}/${BUCKET}/`
const ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
const KEY = `canvas/assets/3f/a8/${ID}.png`

/**
 * 真的 S3 客户端 + 假的 fetch：防 SSRF 的要害是「发没发请求、发给谁」，所以钉在最外面这一层。
 * 记录表换成碰一下就抛错的：按地址读不查归属。
 */
function setup() {
  const requests: { url: string; authorization: string | undefined }[] = []
  vi.stubGlobal('fetch', (input: string | URL, init?: { headers?: Record<string, string> }) => {
    requests.push({ url: String(input), authorization: init?.headers?.authorization })
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '3' } }))
  })
  const client = createS3Client({ endpoint: PUBLIC, requestEndpoint: INTERNAL, region: 'us-east-1', bucket: BUCKET, accessKeyId: 'ak', secretAccessKey: 'sk' })
  const assets = new Proxy({} as FlowAssets, {
    get() {
      throw new Error('按地址读不该碰 FlowAsset')
    },
  })
  const storage = new AssetStorage(client, { s3: null, maxUploadBytes: 1, keyPrefix: 'canvas' }, assets)
  return { storage, requests }
}

afterEach(() => vi.unstubAllGlobals())

describe('AssetStorage.readByUrl 防 SSRF（真的 S3 客户端，看 fetch 收到什么）', () => {
  it('本桶的素材：请求发给内网地址，不是传进来的地址，带签名，不查记录', async () => {
    const { storage, requests } = setup()
    expect(storage.objectUrl(KEY)).toBe(`${BASE}${KEY}`)
    expect(await storage.readByUrl(`${BASE}${KEY}`, { maxBytes: 100 })).toEqual({ status: 'ok', data: new Uint8Array([1, 2, 3]), contentType: 'image/png' })
    expect(requests).toEqual([{ url: `${INTERNAL}/${BUCKET}/${KEY}`, authorization: expect.stringMatching(/^AWS4-HMAC-SHA256 /) }])
  })

  it.each([
    ['别的主机', `https://evil.test/${BUCKET}/${KEY}`],
    ['主机名前缀相同', `https://s3.example.test.evil.test/${BUCKET}/${KEY}`],
    ['userinfo 把主机名挤成用户名', `https://s3.example.test@evil.test/${BUCKET}/${KEY}`],
    ['换了端口', `https://s3.example.test:8443/${BUCKET}/${KEY}`],
    ['换了协议', `http://s3.example.test/${BUCKET}/${KEY}`],
    ['协议大写（没有归一化）', `HTTPS://s3.example.test/${BUCKET}/${KEY}`],
    ['主机名大写（没有归一化）', `https://S3.EXAMPLE.TEST/${BUCKET}/${KEY}`],
    ['服务端内网地址（只有公开地址算本桶）', `${INTERNAL}/${BUCKET}/${KEY}`],
    ['元数据地址', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['本机', `http://127.0.0.1:6379/${KEY}`],
    ['同主机别的桶', `${PUBLIC}/other-bucket/${KEY}`],
    ['同主机桶名前缀相同', `${PUBLIC}/${BUCKET}-evil/${KEY}`],
    ['桶根', BASE],
    ['没有结尾斜杠的桶', `${PUBLIC}/${BUCKET}`],
    ['路径穿越到别的桶', `${BASE}../other/${KEY}`],
    ['路径穿越：先进素材目录再出来', `${BASE}canvas/assets/../../../other/${KEY}`],
    ['路径穿越：两级目录用 ..', `${BASE}canvas/assets/3f/../../assets/3f/a8/${ID}.png`],
    ['路径穿越：./', `${BASE}./${KEY}`],
    ['重复斜杠', `${BASE}/${KEY}`],
    ['编码的 ..', `${BASE}%2e%2e/other/${KEY}`],
    ['编码的 .. 大写', `${BASE}%2E%2E/other/${KEY}`],
    ['编码的斜杠', `${BASE}canvas%2Fassets%2F3f%2Fa8%2F${ID}.png`],
    ['编码的斜杠穿越', `${BASE}..%2Fother%2F${KEY}`],
    ['两次编码的 ..', `${BASE}%252e%252e/other/${KEY}`],
    ['反斜杠', `${BASE}canvas\\assets\\3f\\a8\\${ID}.png`],
    ['编码的反斜杠', `${BASE}canvas%5Cassets%5C3f%5Ca8%5C${ID}.png`],
    ['编码了不该编码的字符', `${BASE}canvas/assets/3f/a8/${ID.replace('3f', '%33f')}.png`],
    ['NUL', `${BASE}canvas/assets/3f/a8/${ID}%00.png`],
    ['换行', `${BASE}canvas/assets/3f/a8/${ID}.png%0d%0aHost:evil.test`],
    ['坏的百分号编码', `${BASE}canvas/assets/3f/a8/%E0%A4%A.png`],
    ['全角句点', `${BASE}．．/other/${KEY}`],
    ['带 query', `${BASE}${KEY}?x-id=GetObject`],
    ['带 fragment', `${BASE}${KEY}#frag`],
    ['别的前缀', `${BASE}other/assets/3f/a8/${ID}.png`],
    ['老的分层键', `${BASE}canvas/projects/p1/flows/f1/images/${ID}.png`],
    ['目录和 uuid 对不上', `${BASE}canvas/assets/00/00/${ID}.png`],
    ['缩略图档位', `${BASE}canvas/assets/3f/a8/${ID}@low.webp`],
    ['data:', 'data:image/png;base64,iVBORw0KGgo='],
    ['file:', `file:///etc/passwd`],
    ['相对路径', KEY],
    ['空串', ''],
  ])('%s → foreign，一个请求都不发', async (_name, url) => {
    const { storage, requests } = setup()
    expect(await storage.readByUrl(url, { maxBytes: 100 })).toEqual({ status: 'foreign' })
    expect(requests).toEqual([])
  })

  it('取消信号传到请求上', async () => {
    const { storage } = setup()
    const seen: (AbortSignal | undefined)[] = []
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
      seen.push(init?.signal)
      return inner(input as string, init as never)
    })
    const controller = new AbortController()
    await storage.readByUrl(`${BASE}${KEY}`, { maxBytes: 100, signal: controller.signal })
    expect(seen).toEqual([controller.signal])
  })
})
