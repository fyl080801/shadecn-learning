import { describe, expect, it, vi } from 'vitest'
import { storeAssetVariants } from '../src/variants.js'
import type { S3Client } from '../src/s3.js'

vi.mock('sharp', () => {
  throw new Error('这台机器上没有 libvips')
})

describe('sharp 加载不了', () => {
  it('只影响缩略图：不抛，回空数组，不往桶里写', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const putObject = vi.fn()
    const key = 'canvas/assets/3f/a8/3fa85f64-5717-4562-b3fc-2c963f66afa6.jpg'

    expect(await storeAssetVariants({ putObject } as unknown as S3Client, key, new Uint8Array([1]), 'image/jpeg')).toEqual([])
    expect(putObject).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
