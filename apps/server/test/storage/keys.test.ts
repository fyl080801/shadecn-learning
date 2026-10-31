import { describe, expect, it } from 'vitest'
import { assetKeyOfUrl, buildAssetKey, isAssetKey } from '../../storage/keys.ts'

const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

describe('资源对象键的目录分层', () => {
  it('前缀 / 统一素材目录 / uuid 两级目录 / uuid.ext（不分项目、画布、类别）', () => {
    expect(buildAssetKey('canvas', { name: 'Cat.PNG', contentType: 'image/png' }, id)).toBe(
      `canvas/assets/3f/a8/${id}.png`,
    )
    expect(buildAssetKey('canvas', { name: 'clip', contentType: 'video/mp4' }, id)).toBe(`canvas/assets/3f/a8/${id}`)
  })

  it('前缀为空时从桶根开始', () => {
    expect(buildAssetKey('', { name: 'a.png', contentType: 'image/png' }, id)).toBe(`assets/3f/a8/${id}.png`)
  })

  it('只认素材目录里、我们拼出来的形状', () => {
    const key = buildAssetKey('canvas', { name: 'a.png', contentType: 'image/png' })
    expect(isAssetKey('canvas', key)).toBe(true)
    expect(isAssetKey('other', key)).toBe(false)
    // 目录和 uuid 对不上、穿越、乱塞路径、旧的分层键都不认
    expect(isAssetKey('canvas', `canvas/assets/00/00/${id}.png`)).toBe(false)
    expect(isAssetKey('canvas', `canvas/assets/3f/a8/../${id}.png`)).toBe(false)
    expect(isAssetKey('canvas', `canvas/assets/images/3f/a8/${id}.png`)).toBe(false)
    expect(isAssetKey('canvas', `canvas/projects/p1/flows/f1/images/3f/a8/${id}.png`)).toBe(false)
    // 缩略图键不是客户端能带回来的键（docs/27 §3.1）
    expect(isAssetKey('canvas', `canvas/assets/3f/a8/${id}@icon.webp`)).toBe(false)
  })
})

describe('素材地址 → 对象键（agent 看图只读本桶的素材，不请求节点里写的地址）', () => {
  const base = 'https://s3.example.test/canvas-bucket/'
  const key = `canvas/assets/3f/a8/${id}.png`

  it('本桶、素材目录、我们拼出来的形状 → 键', () => {
    expect(assetKeyOfUrl(`${base}${key}`, base, 'canvas')).toBe(key)
  })

  it('外部地址、别的桶 / 主机、别的前缀、老的分层键、穿越、编码花样、带 query → null', () => {
    const rejected = [
      `http://169.254.169.254/latest/meta-data/${id}.png`,
      `https://s3.example.test.evil.test/canvas-bucket/${key}`,
      `https://s3.example.test/other-bucket/${key}`,
      `http://s3.example.test/canvas-bucket/${key}`,
      `${base}other/assets/3f/a8/${id}.png`,
      `${base}canvas/projects/p1/flows/f1/images/${id}.png`,
      `${base}canvas/assets/3f/a8/../${id}.png`,
      `${base}canvas/assets/3f%2Fa8/${id}.png`,
      `${base}canvas/assets/3f/a8/${id}.png?x-id=GetObject`,
      `${base}canvas/assets/3f/a8/${id}.png#frag`,
      `${base}canvas/assets/3f/a8/%E0%A4%A.png`,
      `data:image/png;base64,iVBORw0KGgo=`,
      '',
    ]
    for (const url of rejected) expect([url, assetKeyOfUrl(url, base, 'canvas')]).toEqual([url, null])
  })
})
