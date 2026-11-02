import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Inject, Injectable, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigModule, ConfigService } from '../src/index.js'
import { findRootDir, loadConfig } from '../src/load.js'
import { testConfigModule } from '../src/testing.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-config-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function workspace() {
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), '')
  fs.mkdirSync(path.join(dir, 'data'))
  fs.mkdirSync(path.join(dir, 'apps/platform'), { recursive: true })
  return { cwd: path.join(dir, 'apps/platform'), configFile: path.join(dir, 'data/config.yaml') }
}

describe('rootDir', () => {
  it('从 cwd 向上找到 pnpm-workspace.yaml', () => {
    const { cwd } = workspace()
    expect(findRootDir(cwd)).toBe(dir)
    expect(findRootDir(dir)).toBe(dir)
  })

  it('一路都没有 → cwd', () => {
    const cwd = path.join(dir, 'a/b')
    fs.mkdirSync(cwd, { recursive: true })
    expect(findRootDir(cwd)).toBe(cwd)
  })
})

describe('读运行目录的 .env', () => {
  it('取 cwd 下的 .env，不是仓库根的；前后空白不算值，空值等于没设', () => {
    const { cwd } = workspace()
    fs.writeFileSync(path.join(dir, '.env'), 'FROM_ROOT=root\n')
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET_A=from-file\nBLANK="   "\n')
    const config = loadConfig(cwd, {})
    expect(config.env('SECRET_A')).toBe('from-file')
    expect(config.env('FROM_ROOT')).toBeUndefined()
    expect(config.env('BLANK')).toBeUndefined()
  })

  it('进程环境变量优先于 .env', () => {
    const { cwd } = workspace()
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET_A=from-file\n')
    expect(loadConfig(cwd, { SECRET_A: 'from-process' }).env('SECRET_A')).toBe('from-process')
  })

  it('没有 .env 不算错；.env 读不了（是个目录）→ 拒绝启动', () => {
    const { cwd } = workspace()
    expect(loadConfig(cwd, {}).env('SECRET_A')).toBeUndefined()
    fs.mkdirSync(path.join(cwd, '.env'))
    expect(() => loadConfig(cwd, {})).toThrow(path.join(cwd, '.env'))
  })

  it('不写回 process.env：密钥不漏给同进程的依赖和子进程', () => {
    const { cwd } = workspace()
    fs.writeFileSync(path.join(cwd, '.env'), 'LEARNING_CONFIG_TEST_SECRET=from-file\n')
    expect(loadConfig(cwd, {}).env('LEARNING_CONFIG_TEST_SECRET')).toBe('from-file')
    expect(process.env.LEARNING_CONFIG_TEST_SECRET).toBeUndefined()
  })

  it('.env 里的 NODE_ENV / DATA_DIR 不生效：从仓库根启动时那是 @shadecn/server 的 .env', () => {
    const { cwd } = workspace()
    fs.writeFileSync(path.join(cwd, '.env'), 'NODE_ENV=production\nDATA_DIR=/somewhere/else\n')
    const config = loadConfig(cwd, {})
    expect(config.isProduction).toBe(false)
    expect(config.dataDir).toBe(path.join(dir, 'data'))
  })
})

describe('读 config.yaml', () => {
  it('默认读 <rootDir>/data/config.yaml：cwd 在子包里也一样', () => {
    const { cwd, configFile } = workspace()
    fs.writeFileSync(configFile, 'server:\n  port: 4000\n')
    const config = loadConfig(cwd, {})
    expect(config.rootDir).toBe(dir)
    expect(config.dataDir).toBe(path.join(dir, 'data'))
    expect(config.section('server')).toEqual({ port: 4000 })
  })

  it('DATA_DIR 覆盖目录：绝对路径直接用，相对路径按 rootDir，不按 cwd；空白等于没设', () => {
    const { cwd } = workspace()
    const other = path.join(dir, 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'config.yaml'), 'marker: yes-here\n')

    const absolute = loadConfig(cwd, { DATA_DIR: other })
    expect(absolute.dataDir).toBe(other)
    expect(absolute.section('marker')).toBe('yes-here')

    const relative = loadConfig(cwd, { DATA_DIR: 'other' })
    expect(relative.dataDir).toBe(other)
    expect(relative.section('marker')).toBe('yes-here')

    expect(loadConfig(cwd, { DATA_DIR: '  ' }).dataDir).toBe(path.join(dir, 'data'))
  })

  it('文件不存在 → 空配置，打一条日志', () => {
    const { cwd, configFile } = workspace()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const config = loadConfig(cwd, {})
    expect(config.section('server')).toBeUndefined()
    expect(config.mapping('server')).toEqual({})
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining(configFile))
  })

  it('空文件、只有注释的文件 → 空配置，不算错', () => {
    const { cwd, configFile } = workspace()
    for (const source of ['', '# 全是注释\n# session:\n']) {
      fs.writeFileSync(configFile, source)
      expect(loadConfig(cwd, {}).section('session')).toBeUndefined()
    }
  })

  it.each([
    ['括号没闭合', 'session:\n  secret: hunter2-secret\n  list: [1\nother: hunter2-secret\n'],
    ['重复的键', 'secret: hunter2-secret\nsecret: hunter2-secret\n'],
    ['多个文档', 'secret: hunter2-secret\n---\nsecret: hunter2-secret\n'],
    ['别名指向不存在的锚点', 'secret: *hunter2-secret\n'],
  ])('语法错（%s）→ 抛错，带路径，不带文件内容', (_name, source) => {
    const { cwd, configFile } = workspace()
    fs.writeFileSync(configFile, source)
    expect(() => loadConfig(cwd, {})).toThrow(configFile)
    expect(() => loadConfig(cwd, {})).not.toThrow('hunter2')
  })

  it.each([
    ['数组', '- a\n- b\n'],
    ['标量', 'hunter2-secret\n'],
  ])('顶层是%s → 抛错，带路径，不带内容', (_name, source) => {
    const { cwd, configFile } = workspace()
    fs.writeFileSync(configFile, source)
    expect(() => loadConfig(cwd, {})).toThrow(`${configFile} 的顶层必须是映射`)
    expect(() => loadConfig(cwd, {})).not.toThrow('hunter2')
  })

  it('读取失败但不是「不存在」（这里是个目录）→ 抛错，不能当成空配置', () => {
    const { cwd, configFile } = workspace()
    fs.mkdirSync(configFile)
    expect(() => loadConfig(cwd, {})).toThrow(configFile)
  })

  it('isProduction 只看 NODE_ENV', () => {
    const { cwd } = workspace()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(loadConfig(cwd, { NODE_ENV: 'production' }).isProduction).toBe(true)
    expect(loadConfig(cwd, { NODE_ENV: 'development' }).isProduction).toBe(false)
    expect(loadConfig(cwd, {}).isProduction).toBe(false)
  })
})

describe('ConfigService', () => {
  const config = new ConfigService({
    rootDir: '/repo',
    dataDir: '/repo/data',
    isProduction: false,
    values: { good: { a: 1 }, empty: null, scalar: 'x', list: [1] },
  })

  it('section 返回原始值，不校验', () => {
    expect(config.section('scalar')).toBe('x')
    expect(config.section('list')).toEqual([1])
    expect(config.section('none')).toBeUndefined()
  })

  it('mapping：缺段和空段是 {}，其他类型抛错并点名这一段', () => {
    expect(config.mapping('good')).toEqual({ a: 1 })
    expect(config.mapping('empty')).toEqual({})
    expect(config.mapping('none')).toEqual({})
    expect(() => config.mapping('scalar')).toThrow('scalar 段必须是映射')
    expect(() => config.mapping('list')).toThrow('list 段必须是映射')
  })

  it('resolvePath：相对路径按 rootDir，绝对路径不变', () => {
    expect(config.resolvePath('data/x.db')).toBe('/repo/data/x.db')
    expect(config.resolvePath('/abs/x.db')).toBe('/abs/x.db')
  })
})

describe('ConfigModule', () => {
  @Injectable()
  class Consumer {
    constructor(@Inject(ConfigService) readonly config: ConfigService) {}
  }
  // 不 import ConfigModule：靠全局
  @Module({ providers: [Consumer] })
  class ConsumerModule {}
  @Module({})
  class Root {}

  const boot = (imports: unknown[]) =>
    NestFactory.createApplicationContext({ module: Root, imports } as never, { logger: false, abortOnError: false })

  it('全局注入，读 DATA_DIR 指向的文件；启动时读，不是 import 时读', async () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'server:\n  port: 4000\n')
    vi.stubEnv('DATA_DIR', dir)
    vi.stubEnv('NODE_ENV', 'production')
    const app = await boot([ConsumerModule, ConfigModule])
    const { config } = app.get(Consumer)
    expect(config.dataDir).toBe(dir)
    expect(config.isProduction).toBe(true)
    expect(config.section('server')).toEqual({ port: 4000 })
    await app.close()
  })

  it('配置文件读坏了 → 启动失败', async () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), '- not-a-mapping\n')
    vi.stubEnv('DATA_DIR', dir)
    await expect(boot([ConfigModule])).rejects.toThrow('顶层必须是映射')
  })
})

describe('测试入口', () => {
  it('testConfigModule 是全局模块，给同一个 token；默认不落到真实仓库', async () => {
    @Injectable()
    class Consumer {
      constructor(@Inject(ConfigService) readonly config: ConfigService) {}
    }
    @Module({ providers: [Consumer] })
    class ConsumerModule {}
    @Module({})
    class Root {}

    const app = await NestFactory.createApplicationContext(
      { module: Root, imports: [ConsumerModule, testConfigModule({ a: 1 }, { isProduction: true })] },
      { logger: false, abortOnError: false },
    )
    const { config } = app.get(Consumer)
    expect(config.section('a')).toBe(1)
    expect(config.isProduction).toBe(true)
    expect(config.rootDir.startsWith(os.tmpdir())).toBe(true)
    await app.close()
  })

  it('主入口不导出测试工具', async () => {
    expect(await import('../src/index.js')).not.toHaveProperty('testConfigModule')
  })
})
