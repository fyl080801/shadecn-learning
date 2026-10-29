import { afterEach, describe, expect, it, vi } from 'vitest'
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
