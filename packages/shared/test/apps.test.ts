import { describe, expect, it } from 'vitest'
import {
  checkParamValue,
  formatAppTasksMessage,
  nodeAppParams,
  parseAppTasksMessage,
  sizeCellOf,
  sizeValueOf,
  type AppInfo,
  type ParamSpec,
} from '../src/apps.ts'

const seedream: AppInfo = {
  id: 'ark:pro',
  title: 'Seedream 5.0',
  category: 'image',
  driver: 'ark',
  model: 'pro',
  params: {
    prompt: { type: 'string', required: true },
    image: { type: 'images', maxLength: 10 },
  },
}

describe('nodeAppParams', () => {
  it('提示词进 prompt、参考图进第一个 images 参数，按这个应用的上限截断并报出丢了几张', () => {
    const images = Array.from({ length: 12 }, (_, i) => `https://s3/${i}.png`)
    const pro = nodeAppParams(seedream, { prompt: '  一只猫 ', images })
    expect(pro.params).toEqual({ prompt: '一只猫', image: images.slice(0, 10) })
    expect(pro.droppedImages).toBe(2)
    const wider: AppInfo = { ...seedream, params: { ...seedream.params, image: { type: 'images', maxLength: 14 } } }
    const wide = nodeAppParams(wider, { prompt: 'x', images })
    expect(wide.params.image).toHaveLength(12)
    expect(wide.droppedImages).toBe(0)
  })

  it('没有 images 参数时进第一个 image 参数（只放第一张）；没有图片参数的应用一张都不放', () => {
    const single: AppInfo = { ...seedream, params: { prompt: { type: 'string' }, image: { type: 'image' } } }
    expect(nodeAppParams(single, { prompt: 'x', images: ['a', 'b'] })).toEqual({ params: { prompt: 'x', image: 'a' }, droppedImages: 1 })
    const text: AppInfo = { ...single, params: { prompt: { type: 'string' } } }
    expect(nodeAppParams(text, { prompt: 'x', images: ['a'] })).toEqual({ params: { prompt: 'x' }, droppedImages: 1 })
  })

  it('模型不是参数，不进请求；空提示词不放（交给服务端报缺少参数）', () => {
    expect(nodeAppParams(seedream, { prompt: '  ', images: [] }).params).toEqual({})
    expect(nodeAppParams(seedream, { prompt: 'x', images: [] }).params).not.toHaveProperty('model')
  })
})

const SIZE: ParamSpec = {
  type: 'size',
  tiers: ['1K', '2K'],
  minPixels: 921600,
  maxPixels: 4624220,
  maxAspect: 16,
  presets: { '1:1': ['1024x1024', '2048x2048'], '16:9': ['1424x800', '2816x1584'] },
}

describe('尺寸', () => {
  it('档位 ↔ 「分辨率 × 比例」：档位本身 = 比例由模型定；常用表里的宽高落回它那一格；别的是自定义', () => {
    expect(sizeCellOf(SIZE, '2K')).toEqual({ tier: '2K', ratio: null })
    expect(sizeCellOf(SIZE, '2816x1584')).toEqual({ tier: '2K', ratio: '16:9' })
    expect(sizeCellOf(SIZE, '2000x1000')).toBeNull()
    expect(sizeValueOf(SIZE, '1K', '16:9')).toBe('1424x800')
    expect(sizeValueOf(SIZE, '1K', null)).toBe('1K')
    expect(sizeValueOf(SIZE, '4K', null)).toBeNull()
    expect(sizeValueOf(SIZE, '1K', '4:3')).toBeNull()
  })

  it('校验：档位、范围内的宽x高；太小 / 太大 / 太扁 / 形状不对给出原因', () => {
    expect(checkParamValue('size', SIZE, '1K')).toBeNull()
    expect(checkParamValue('size', SIZE, '2000x1000')).toBeNull()
    expect(checkParamValue('size', SIZE, '512x512')).toMatch(/太小/)
    expect(checkParamValue('size', SIZE, '4096x4096')).toMatch(/太大/)
    expect(checkParamValue('size', SIZE, '8000x400')).toMatch(/太扁/)
    expect(checkParamValue('size', SIZE, '4K')).toMatch(/只能是 1K \/ 2K，或 宽x高/)
  })

  it('节点上单独设的参数：这个应用有、值也合才带上；提示词 / 图片参数不让覆盖', () => {
    const app: AppInfo = { ...seedream, params: { prompt: { type: 'string' }, size: SIZE } }
    expect(nodeAppParams(app, { prompt: 'x', images: [] }, { size: '2816x1584', prompt: 'evil', style: 'a' }).params).toEqual({
      prompt: 'x',
      size: '2816x1584',
    })
    // 换了应用、旧值不合 → 不带，退回应用的默认
    expect(nodeAppParams(app, { prompt: 'x', images: [] }, { size: '4096x4096' }).params).not.toHaveProperty('size')
  })
})

describe('apps:tasks 推送', () => {
  const task = {
    id: 't1',
    flowId: 'f1',
    nodeId: 'n1',
    appId: 'seedance',
    appTitle: '视频',
    status: 'running' as const,
    progress: { status: 'running', ratio: 0.5 },
    owner: { id: 'u1', name: '我', avatarUrl: null },
    createdAt: 1,
    startedAt: 2,
  }

  it('序列化后原样解析回来', () => {
    expect(parseAppTasksMessage(formatAppTasksMessage('f1', [task], 9))).toEqual({ flowId: 'f1', tasks: [task], now: 9 })
  })

  it('防御着读：不是 JSON / 不是这类消息 → null；个别项形状不对只丢那一项，多余字段不往下传', () => {
    expect(parseAppTasksMessage('{')).toBeNull()
    expect(parseAppTasksMessage(JSON.stringify({ type: 'agent:runs', flowId: 'f1', tasks: [] }))).toBeNull()
    const parsed = parseAppTasksMessage(
      JSON.stringify({
        type: 'apps:tasks',
        flowId: 'f1',
        tasks: [{ ...task, secret: 'x', progress: { status: 'running', ratio: 7 } }, { ...task, status: 'weird' }, null],
      }),
    )
    expect(parsed?.tasks).toHaveLength(1)
    expect(parsed?.tasks[0]).not.toHaveProperty('secret')
    expect(parsed?.tasks[0]?.progress).toEqual({ status: 'running' })
  })
})
