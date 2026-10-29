import { describe, expect, it } from 'vitest'
import { buildAssetKey, isAssetKey } from '../../storage/keys.ts'

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
  })
})
