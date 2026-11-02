import { describe, expect, it } from 'vitest'
import { resolveConfig, setting } from '../../src/config.ts'
import { moduleConfigPath, moduleConfigSchema, moduleEnvName, parseModuleConfigs } from '../../src/kernel/config.ts'
import { defineModule, defineModuleConfig } from '../../src/kernel/module.ts'
import type { RuntimeInfo } from '../../src/platform.ts'

const runtime = { dataDir: '/data' } as RuntimeInfo

const storage = defineModule({
  name: 'storage',
  roles: ['web'],
  config: {
    schema: { bucket: setting('string') },
    parse: (read, rt) => ({ bucket: read('bucket') ?? '', dir: rt.dataDir }),
  },
  setup() {},
})
const canvas = defineModule({ name: 'canvas', roles: ['web'], setup() {} })

const source = (values: Record<string, string>) => ({ get: (name: string) => values[name] })

describe('模块的配置段', () => {
  it('每个模块一节，自动带 enabled；路径和环境变量名都带 modules 前缀', () => {
    const schema = moduleConfigSchema([storage, canvas])
    expect(Object.keys(schema)).toEqual(['storage', 'canvas'])
    expect(schema.canvas).toMatchObject({ enabled: { type: 'boolean' } })
    expect(schema.storage).toMatchObject({ enabled: { type: 'boolean' }, bucket: { type: 'string' } })
    expect(moduleConfigPath('storage', 'bucket')).toBe('modules.storage.bucket')
    expect(moduleEnvName('storage', 'bucket')).toBe('MODULES_STORAGE_BUCKET')
    expect(moduleEnvName('mod-x', 'enabled')).toBe('MODULES_MOD_X_ENABLED')
  })

  it('模块自己声明 enabled → 抛（内核加）', () => {
    const bad = defineModule({
      name: 'bad',
      roles: ['web'],
      config: { schema: { enabled: setting('boolean') }, parse: () => null },
      setup() {},
    })
    expect(() => moduleConfigSchema([bad])).toThrow('不能自己声明 enabled')
  })

  it('解析：parse 按相对本段的路径取到合并好的值和运行环境；enabled=false 记进 switchedOff', () => {
    const configs = parseModuleConfigs([storage, canvas], source({ 'modules.storage.bucket': 'b', 'modules.canvas.enabled': 'false' }), runtime)
    expect(configs.values.get('storage')).toEqual({ bucket: 'b', dir: '/data' })
    expect(configs.values.has('canvas')).toBe(false)
    expect(configs.switchedOff.get('canvas')).toContain('modules.canvas.enabled / MODULES_CANVAS_ENABLED')
    expect(configs.switchedOff.has('storage')).toBe(false)
  })

  it('经真实的合层：模块段的叶子同样能从文件和推导出的环境变量配', () => {
    const schema = { modules: moduleConfigSchema([storage]) }
    const files = { files: [], data: { modules: { storage: { bucket: 'from-file' } } } }
    const fromFile = parseModuleConfigs([storage], resolveConfig(schema, files, {}), runtime)
    expect(fromFile.values.get('storage')).toMatchObject({ bucket: 'from-file' })
    const fromEnv = parseModuleConfigs([storage], resolveConfig(schema, files, { MODULES_STORAGE_BUCKET: 'from-env', MODULES_STORAGE_ENABLED: 'off' }), runtime)
    expect(fromEnv.values.get('storage')).toMatchObject({ bucket: 'from-env' })
    expect(fromEnv.switchedOff.has('storage')).toBe(true)
  })

  it('模块读一个没声明的路径 → 抛错（路径按本段算，不能串到别的段）', () => {
    const peeking = defineModule({
      name: 'peeking',
      roles: ['web'],
      config: { schema: { own: setting('string') }, parse: (read) => read('../storage.bucket') },
      setup() {},
    })
    const schema = { modules: moduleConfigSchema([peeking, storage]) }
    expect(() => parseModuleConfigs([peeking], resolveConfig(schema, { files: [], data: {} }, {}), runtime)).toThrow(/不在配置 schema 里/)
  })

  it('defineModuleConfig：read 的路径按 schema 收窄（相对本段），拼错过不了编译', () => {
    const section = defineModuleConfig({
      schema: { bucket: setting('string'), s3: { accessKeyId: setting('string') } },
      parse(read) {
        // @ts-expect-error 没有这一项
        const typo = () => read('buckt')
        return { bucket: read('bucket'), key: read('s3.accessKeyId'), typo }
      },
    })
    const module = defineModule({ name: 'typed', roles: ['web'], config: section, setup() {} })
    const configs = parseModuleConfigs([module], source({ 'modules.typed.bucket': 'b', 'modules.typed.s3.accessKeyId': 'k' }), runtime)
    expect(configs.values.get('typed')).toMatchObject({ bucket: 'b', key: 'k' })
  })

  it('enabled=true 不能把模块硬打开：只是不关', () => {
    const configs = parseModuleConfigs([storage], source({ 'modules.storage.enabled': 'true' }), runtime)
    expect(configs.switchedOff.size).toBe(0)
  })
})
