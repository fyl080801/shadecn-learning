import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadServerConfig } from './helpers/config.ts'

/**
 * 配置文件（docs/28 §3.3）：`SERVER_CONFIG` 指到临时目录里的 YAML / JSON，重新 import config.ts 看各项取到什么。
 * config.ts 的值是模块加载时算好的常量，所以每个用例 resetModules 之后重新 import。
 */
const loadConfig = loadServerConfig

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'server-config-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function useConfig(name: string, text: string) {
  const file = path.join(dir, name)
  writeFileSync(file, text)
  vi.stubEnv('SERVER_CONFIG', file)
  return file
}

/** 测试的 test.env 占了一批变量；要看文件生效，先把它们从环境里拿掉 */
function unsetEnv(...names: string[]) {
  for (const name of names) vi.stubEnv(name, undefined)
}

describe('配置文件 → config.ts', () => {
  it('YAML：底座的段和能力模块的段都从文件取', async () => {
    unsetEnv('PORT', 'AGENT_MODEL', 'AGENT_SANDBOX', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_MAX_UPLOAD_MB')
    const file = useConfig(
      'server.config.yaml',
      [
        'server:',
        '  port: 4100',
        '  roles: [web, collab]',
        'modules:',
        '  storage:',
        '    bucket: canvas',
        '    accessKeyId: ak',
        '    secretAccessKey: sk',
        '    maxUploadMb: 5',
        '  agent:',
        '    model: claude-opus-4-1',
        '    sandbox:',
        '      driver: oci',
        '      cpus: 2',
        '      k8s:',
        '        nodeSelector:',
        '          kubernetes.io/arch: arm64',
      ].join('\n'),
    )
    const config = await loadConfig()
    expect(config.configFiles).toEqual([file])
    expect(config.port).toBe(4100)
    expect([...config.serverRoles]).toEqual(['web', 'collab'])
    expect(config.s3Enabled).toBe(true)
    expect(config.s3Config).toMatchObject({ bucket: 'canvas', accessKeyId: 'ak', maxUploadBytes: 5 * 1024 * 1024 })
    expect(config.agentConfig).toMatchObject({
      model: 'claude-opus-4-1',
      sandbox: 'oci',
      sandboxResources: expect.objectContaining({ cpu: 2 }),
      k8s: expect.objectContaining({ nodeSelector: 'kubernetes.io/arch=arm64' }),
    })
    expect(config.switchedOffModules.size).toBe(0)
  })

  it('JSON 同样认；环境变量盖过文件', async () => {
    useConfig('cfg.json', JSON.stringify({ server: { port: 4100 }, log: { level: 'debug' } }))
    vi.stubEnv('PORT', '4200')
    unsetEnv('LOG_LEVEL')
    const config = await loadConfig()
    expect(config.port).toBe(4200)
    expect(config.logLevel).toBe('debug')
  })

  it('enabled: false 关掉模块，原因写明出处；关掉 storage 时 s3Enabled 也是 false（agent 不接看图）', async () => {
    unsetEnv('S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY')
    useConfig(
      'server.config.yaml',
      'modules:\n  storage:\n    enabled: false\n    bucket: b\n    accessKeyId: a\n    secretAccessKey: s\n  agent:\n    enabled: false\n',
    )
    const config = await loadConfig()
    expect(config.switchedOffModules.get('storage')).toMatch(/配置关闭（modules\.storage\.enabled \/ STORAGE_ENABLED）/)
    expect(config.switchedOffModules.has('agent')).toBe(true)
    expect(config.switchedOffModules.has('collab')).toBe(false)
    expect(config.s3Enabled).toBe(false)
  })

  it('enabled: true 不能把缺配置的模块硬打开：只是交给模块自己判', async () => {
    unsetEnv('S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY')
    useConfig('server.config.yaml', 'modules:\n  storage:\n    enabled: true\n')
    const config = await loadConfig()
    expect(config.switchedOffModules.size).toBe(0)
    expect(config.s3Enabled).toBe(false)
  })

  it('环境变量也能关：AGENT_ENABLED=0', async () => {
    vi.stubEnv('AGENT_ENABLED', '0')
    expect((await loadConfig()).switchedOffModules.has('agent')).toBe(true)
  })

  it('拼错的键 → import 时就抛（进程不监听端口）', async () => {
    useConfig('server.config.yaml', 'modules:\n  agent:\n    modle: x\n')
    await expect(loadConfig()).rejects.toThrow(/modules\.agent\.modle 不是认得的配置项/)
  })

  it('SERVER_CONFIG 指的文件不存在 → 抛', async () => {
    vi.stubEnv('SERVER_CONFIG', path.join(dir, 'missing.yaml'))
    await expect(loadConfig()).rejects.toThrow(/指定的配置文件不存在/)
  })

  it('SERVER_CONFIG 为空串 = 不用配置文件', async () => {
    expect((await loadConfig()).configFiles).toEqual([])
  })
})
