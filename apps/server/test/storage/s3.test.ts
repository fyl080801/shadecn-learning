import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assetKeyOfUrl, buildAssetKey } from '../../storage/keys.ts'
import { createS3Client, encodeS3Path, signS3Request } from '../../storage/s3.ts'

describe('S3 SigV4 签名', () => {
  it('与 AWS 文档的 GetObject 样例逐字一致', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html 「Example: GET Object」
    const headers = signS3Request({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
    })
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('路径按段编码，保留 /，不二次编码', () => {
    expect(encodeS3Path('flows/a b/图(1).png')).toBe('flows/a%20b/%E5%9B%BE%281%29.png')
  })
})

describe('createS3Client', () => {
  afterEach(() => vi.unstubAllGlobals())

  const client = createS3Client({
    endpoint: 'https://s3.example.test',
    region: 'us-east-1',
    bucket: 'canvas',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
  })

  it('path-style PUT，带签名，返回原始地址', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    const url = await client.putObject('flows/f1/x.png', new Uint8Array([1, 2, 3]), 'image/png')

    expect(url).toBe('https://s3.example.test/canvas/flows/f1/x.png')
    const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(target)).toBe(url)
    expect(init.method).toBe('PUT')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('image/png')
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ak\/\d{8}\/us-east-1\/s3\/aws4_request, /)
    expect(headers.host).toBeUndefined()
  })

  it('S3 回非 2xx → 抛错并带上错误码', async () => {
    vi.stubGlobal('fetch', async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }))
    await expect(client.putObject('k', new Uint8Array(), 'image/png')).rejects.toThrow('403 AccessDenied')
  })
})

describe('createS3Client 分片上传', () => {
  afterEach(() => vi.unstubAllGlobals())

  const client = createS3Client({
    endpoint: 'https://s3.example.test',
    region: 'us-east-1',
    bucket: 'canvas',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
  })

  function capture(responses: Response[]) {
    const calls: { url: string; method: string; body: string }[] = []
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init.method),
        body: init.body ? new TextDecoder().decode(init.body as Uint8Array) : '',
      })
      return responses.shift()!
    })
    return calls
  }

  it('Create / UploadPart / Complete / Abort 发对方法和 query，解析 UploadId 与 ETag', async () => {
    const calls = capture([
      new Response('<InitiateMultipartUploadResult><UploadId>u/1=</UploadId></InitiateMultipartUploadResult>'),
      new Response(null, { headers: { etag: '"e1"' } }),
      new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>'),
      new Response(null, { status: 204 }),
    ])

    expect(await client.createMultipartUpload('a/b.mp4', 'video/mp4')).toBe('u/1=')
    expect(await client.uploadPart('a/b.mp4', 'u/1=', 1, new Uint8Array([1]))).toBe('"e1"')
    expect(await client.completeMultipartUpload('a/b.mp4', 'u/1=', [{ partNumber: 1, etag: '"e1"' }])).toBe(
      'https://s3.example.test/canvas/a/b.mp4',
    )
    await client.abortMultipartUpload('a/b.mp4', 'u/1=')

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://s3.example.test/canvas/a/b.mp4?uploads=',
      'PUT https://s3.example.test/canvas/a/b.mp4?partNumber=1&uploadId=u%2F1%3D',
      'POST https://s3.example.test/canvas/a/b.mp4?uploadId=u%2F1%3D',
      'DELETE https://s3.example.test/canvas/a/b.mp4?uploadId=u%2F1%3D',
    ])
    expect(calls[2]!.body).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part></CompleteMultipartUpload>',
    )
  })

  it('Complete 回 200 但正文是 <Error> → 抛错', async () => {
    capture([new Response('<Error><Code>InvalidPart</Code></Error>')])
    await expect(client.completeMultipartUpload('k', 'u', [{ partNumber: 1, etag: '"e"' }])).rejects.toThrow(
      'InvalidPart',
    )
  })

  it('HeadObject：404 回 null，否则回大小与类型', async () => {
    capture([
      new Response(null, { status: 404 }),
      new Response(null, { headers: { 'content-length': '42', 'content-type': 'video/mp4' } }),
    ])
    expect(await client.headObject('missing')).toBeNull()
    expect(await client.headObject('k')).toEqual({ size: 42, contentType: 'video/mp4' })
  })
})

describe('createS3Client GetObject（服务端自己读字节，带上限）', () => {
  afterEach(() => vi.unstubAllGlobals())

  const client = createS3Client({
    endpoint: 'https://s3.example.test',
    region: 'us-east-1',
    bucket: 'canvas',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
  })

  it('签名 GET 本桶里的键；回正文与类型', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push(`${init.method} ${String(url)} ${(init.headers as Record<string, string>).authorization ? 'signed' : 'unsigned'}`)
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png', 'content-length': '3' } })
    })
    const got = await client.getObject('a/b.png', { maxBytes: 10 })
    expect(got).toEqual({ status: 'ok', body: new Uint8Array([1, 2, 3]), contentType: 'image/png' })
    expect(calls).toEqual(['GET https://s3.example.test/canvas/a/b.png signed'])
  })

  it('404 → not_found；content-length 超上限 → too_large（不读正文）', async () => {
    const responses = [new Response(null, { status: 404 }), new Response('x'.repeat(20), { headers: { 'content-length': '20' } })]
    vi.stubGlobal('fetch', async () => responses.shift()!)
    expect(await client.getObject('missing', { maxBytes: 10 })).toEqual({ status: 'not_found' })
    expect(await client.getObject('big', { maxBytes: 10 })).toEqual({ status: 'too_large' })
  })

  it('没有 content-length 的流：边读边数，超过上限就掐断', async () => {
    let cancelled = false
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(8))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    expect(await client.getObject('endless', { maxBytes: 20 })).toEqual({ status: 'too_large' })
    expect(cancelled).toBe(true)
  })
})

describe('createS3Client 的内网请求地址（S3_INTERNAL_ENDPOINT）', () => {
  afterEach(() => vi.unstubAllGlobals())

  const options = {
    endpoint: 'https://s3.example.test',
    region: 'us-east-1',
    bucket: 'canvas',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
  }
  const internal = createS3Client({ ...options, requestEndpoint: 'http://minio.minio.svc.cluster.local:9000/' })
  const key = buildAssetKey('canvas', { name: 'a.png', contentType: 'image/png' })

  /** 记下每个请求的地址和签进去的头（SignedHeaders 里有 host，签名就绑在那个 host 上） */
  function capture(responses: () => Response) {
    const calls: { url: string; method: string; authorization: string }[] = []
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method), authorization: (init.headers as Record<string, string>).authorization ?? '' })
      return responses()
    })
    return calls
  }

  it('每个实际请求（put / head / get / 分片四步）都发到内网地址；返回的、存进节点的地址仍是公开地址', async () => {
    const queue = [
      new Response(null, { status: 200 }),
      new Response(null, { headers: { 'content-length': '3', 'content-type': 'image/png' } }),
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
      new Response('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>'),
      new Response(null, { headers: { etag: '"e1"' } }),
      new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>'),
      new Response(null, { status: 204 }),
    ]
    const calls = capture(() => queue.shift()!)

    const publicUrl = `https://s3.example.test/canvas/${key}`
    expect(await internal.putObject(key, new Uint8Array([1, 2, 3]), 'image/png')).toBe(publicUrl)
    expect(await internal.headObject(key)).toEqual({ size: 3, contentType: 'image/png' })
    expect(await internal.getObject(key, { maxBytes: 10 })).toMatchObject({ status: 'ok' })
    expect(await internal.createMultipartUpload(key, 'image/png')).toBe('u1')
    expect(await internal.uploadPart(key, 'u1', 1, new Uint8Array([1]))).toBe('"e1"')
    expect(await internal.completeMultipartUpload(key, 'u1', [{ partNumber: 1, etag: '"e1"' }])).toBe(publicUrl)
    await internal.abortMultipartUpload(key, 'u1')
    expect(internal.objectUrl(key)).toBe(publicUrl)

    expect(calls).toHaveLength(7)
    for (const call of calls) {
      expect(call.url.startsWith(`http://minio.minio.svc.cluster.local:9000/canvas/${key}`), call.url).toBe(true)
      expect(call.authorization).toMatch(/SignedHeaders=[^,]*\bhost\b/)
    }
  })

  it('签名里的 host 是内网 host：和同一请求按内网地址手算的签名一致，和按公开地址算的不一致', async () => {
    const calls = capture(() => new Response(null, { status: 200 }))
    // 钉住时间：签名里有 x-amz-date
    vi.useFakeTimers({ toFake: ['Date'] })
    const at = new Date('2026-10-29T12:00:00Z')
    vi.setSystemTime(at)
    try {
      await internal.putObject(key, new Uint8Array([7]), 'image/png')
    } finally {
      vi.useRealTimers()
    }
    const sign = (base: string) =>
      signS3Request({
        method: 'PUT',
        url: new URL(`${base}/canvas/${key}`),
        headers: { 'content-type': 'image/png' },
        payloadHash: createHash('sha256').update(new Uint8Array([7])).digest('hex'),
        region: 'us-east-1',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        date: at,
      }).authorization
    expect(calls[0]!.authorization).toBe(sign('http://minio.minio.svc.cluster.local:9000'))
    expect(calls[0]!.authorization).not.toBe(sign('https://s3.example.test'))
  })

  it('节点里存的公开地址照样反解成对象键（agent 看图按键走内网读，不请求节点里的地址）；内网地址反解不出来', () => {
    expect(assetKeyOfUrl(internal.objectUrl(key), internal.objectUrl(''), 'canvas')).toBe(key)
    expect(assetKeyOfUrl(`http://minio.minio.svc.cluster.local:9000/canvas/${key}`, internal.objectUrl(''), 'canvas')).toBeNull()
  })

  it('不配（空串）= 和公开地址一样：请求发到 S3_ENDPOINT', async () => {
    const calls = capture(() => new Response(null, { status: 200 }))
    const same = createS3Client({ ...options, requestEndpoint: '' })
    expect(await same.putObject(key, new Uint8Array(), 'image/png')).toBe(`https://s3.example.test/canvas/${key}`)
    expect(calls[0]!.url).toBe(`https://s3.example.test/canvas/${key}`)
  })
})
