import { describe, expect, it } from 'vitest'
import { setting } from '../../src/config.ts'
import { enabledEnvOf, moduleConfigSchema, parseModuleConfigs } from '../../src/kernel/config.ts'
import { defineModule } from '../../src/kernel/module.ts'
import type { RuntimeInfo } from '../../src/platform.ts'

const runtime = { dataDir: '/data' } as RuntimeInfo

const storage = defineModule({
  name: 'storage',
  roles: ['web'],
  config: {
    schema: { bucket: setting('S3_BUCKET', 'string') },
    parse: (read, rt) => ({ bucket: read('S3_BUCKET') ?? '', dir: rt.dataDir }),
  },
  setup() {},
})
const canvas = defineModule({ name: 'canvas', roles: ['web'], setup() {} })

const source = (values: Record<string, string>) => ({ get: (name: string) => values[name] })

describe('模块的配置段', () => {
  it('每个模块一节，自动带 enabled（<NAME>_ENABLED）', () => {
    const schema = moduleConfigSchema([storage, canvas])
    expect(Object.keys(schema)).toEqual(['storage', 'canvas'])
    expect(schema.canvas).toMatchObject({ enabled: { env: 'CANVAS_ENABLED', type: 'boolean' } })
    expect(schema.storage).toMatchObject({ enabled: { env: 'STORAGE_ENABLED' }, bucket: { env: 'S3_BUCKET' } })
    expect(enabledEnvOf('mod-x')).toBe('MOD_X_ENABLED')
  })

  it('模块自己声明 enabled → 抛（内核加）', () => {
    const bad = defineModule({
      name: 'bad',
      roles: ['web'],
      config: { schema: { enabled: setting('BAD_ON', 'boolean') }, parse: () => null },
      setup() {},
    })
    expect(() => moduleConfigSchema([bad])).toThrow('不能自己声明 enabled')
  })

  it('解析：parse 拿到合并好的值和运行环境；enabled=false 记进 switchedOff', () => {
    const configs = parseModuleConfigs([storage, canvas], source({ S3_BUCKET: 'b', CANVAS_ENABLED: 'false' }), runtime)
    expect(configs.values.get('storage')).toEqual({ bucket: 'b', dir: '/data' })
    expect(configs.values.has('canvas')).toBe(false)
    expect(configs.switchedOff.get('canvas')).toContain('CANVAS_ENABLED')
    expect(configs.switchedOff.has('storage')).toBe(false)
  })

  it('enabled=true 不能把模块硬打开：只是不关', () => {
    const configs = parseModuleConfigs([storage], source({ STORAGE_ENABLED: 'true' }), runtime)
    expect(configs.switchedOff.size).toBe(0)
  })
})
