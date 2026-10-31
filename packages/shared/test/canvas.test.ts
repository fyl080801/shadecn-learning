import { describe, expect, it } from 'vitest'
import { assetVariantPath } from '../src/canvas.ts'

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
