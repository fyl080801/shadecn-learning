import { describe, expect, it } from 'vitest'
import {
  assetDownloadName,
  assetDownloadUrl,
  assetVariantPath,
  attachmentDisposition,
} from '../src/canvas.ts'

/** 缩略图地址推导（docs/27 §3.1）：只认我们拼出来的素材形状，别的一律 null（用原图） */

const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
const url = `https://s3.example.test/bucket/canvas/assets/3f/a8/${id}.png`

describe('assetVariantPath', () => {
  it('地址和键都能推：同目录，扩展名换成 @<档>.webp', () => {
    expect(assetVariantPath(url, 'icon')).toBe(`https://s3.example.test/bucket/canvas/assets/3f/a8/${id}@icon.webp`)
    expect(assetVariantPath(`assets/3f/a8/${id}.JPG`.toLowerCase(), 'low')).toBe(`assets/3f/a8/${id}@low.webp`)
    expect(assetVariantPath(`canvas/assets/3f/a8/${id}`, 'low')).toBe(`canvas/assets/3f/a8/${id}@low.webp`)
  })

  it('外部链接、data: / blob:、老分层键、目录和 uuid 对不上、带 query、SVG、已经是档位 → null', () => {
    for (const value of [
      'https://example.com/cat.png',
      'data:image/png;base64,AAAA',
      'blob:http://localhost/abc',
      `https://s3/b/projects/p1/flows/f1/images/${id}.png`,
      `https://s3/b/canvas/assets/00/00/${id}.png`,
      `${url}?x=1`,
      url.replace('.png', '.svg'),
      url.replace('.png', '@icon.webp'),
      '',
    ]) {
      expect(assetVariantPath(value, 'icon')).toBeNull()
    }
  })
})

/** 节点工具条的「下载」：文件名 = 节点名 + 原扩展名，地址带 response-content-disposition */
describe('assetDownloadName', () => {
  it('节点名 + 资源的扩展名；名字已带同一扩展名不重复加', () => {
    expect(assetDownloadName('猫', url)).toBe('猫.png')
    expect(assetDownloadName('猫.PNG', url)).toBe('猫.PNG')
    expect(assetDownloadName('片段', 'https://example.com/a/b.mp4?x=1#t')).toBe('片段.mp4')
    expect(assetDownloadName('无扩展名', 'data:image/png;base64,AAAA')).toBe('无扩展名')
  })

  it('不安全的字符换成 _，名字清空了用兜底', () => {
    expect(assetDownloadName('a/b:c*?"<>|', url)).toBe('a_b_c______.png')
    expect(assetDownloadName('  ', url)).toBe('download.png')
    expect(assetDownloadName('...', url, '图片')).toBe('图片.png')
  })
})

describe('assetDownloadUrl', () => {
  it('我们的素材：拼上 response-content-disposition，含 ASCII 兜底和 UTF-8 原名', () => {
    const result = assetDownloadUrl(url, '我的 图(1).png')!
    const value = new URL(result).searchParams.get('response-content-disposition')
    expect(result.startsWith(`${url}?`)).toBe(true)
    expect(value).toBe(attachmentDisposition('我的 图(1).png'))
    expect(value).toBe(`attachment; filename="__ _(1).png"; filename*=UTF-8''%E6%88%91%E7%9A%84%20%E5%9B%BE%281%29.png`)
  })

  it('外部链接、data: / blob:、已带 query → null（调用方原样下载）', () => {
    for (const value of ['https://example.com/cat.png', 'data:image/png;base64,AAAA', 'blob:http://localhost/abc', `${url}?x=1`]) {
      expect(assetDownloadUrl(value, 'a.png')).toBeNull()
    }
  })
})
