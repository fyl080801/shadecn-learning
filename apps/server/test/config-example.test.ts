import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { rootDir } from '@shadecn/server-core/config'
import { serverConfigSchema } from '@shadecn/server-core/config-source'
import { resolveConfig } from '@shadecn/server-kit/config'
import { parseLlmProviders } from '@shadecn/server-kit/llm'
import type { RuntimeInfo } from '@shadecn/server-kit/platform'
import { appsConfig } from '@shadecn/mod-apps/config'
import { modules } from '../modules.ts'

/**
 * `sample/server.config.example.yaml` 是发布出去的示例（docs/28 §3.3）：配置项几乎都注释着，**去掉注释后**必须能过校验 ——
 * 改了 schema 忘了改示例、示例里留着已经删掉的键，在这里红。
 */
const text = readFileSync(path.join(rootDir, 'sample/server.config.example.yaml'), 'utf8')

/** 注释掉的配置行（`# key: …` / `#   - 列表项`）；说明文字（中文、`→` 之类）不是这个形状，留着 */
const COMMENTED_SETTING = /^(\s*)# ?(\s*)((?:"[^"]+":(?:\s|$)|[A-Za-z0-9_./-]+:(?:\s|$)|- ).*)$/

/** 文件头那段说明不算：从第一个顶层键开始 */
function uncomment(source: string): string {
  const lines = source.split('\n')
  return lines
    .slice(lines.findIndex((line) => /^[a-z]+:/.test(line)))
    .map((line) => line.replace(COMMENTED_SETTING, '$1$2$3'))
    .join('\n')
}

describe('sample/server.config.example.yaml', () => {
  const data = parseYaml(uncomment(text)) as Record<string, any>

  it('去掉注释后过完整 schema 的校验', () => {
    expect(() => resolveConfig(serverConfigSchema(modules), { files: [], data }, {})).not.toThrow()
  })

  it('确实解开了：几个有代表性的项都在（防止「什么都没解开所以校验通过」）', () => {
    expect(data.server.port).toBe(3000)
    expect(data.modules.agent.provider).toBeTruthy()
    expect(data.modules.agent.sandbox.k8s.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64' })
  })

  it('llm.providers 过形状校验，三种写法都有；agent 段不再有连接信息', () => {
    const source = resolveConfig(serverConfigSchema(modules), { files: [], data }, {})
    const table = parseLlmProviders(source.get('llm.providers'))
    expect(Object.keys(table)).toEqual(['ollama', 'selfhost', 'anthropic'])
    expect(table.ollama!.models.length).toBeGreaterThan(0)
    expect(table.selfhost).toMatchObject({ apiKeyEnv: 'MY_LLM_API_KEY', api: 'openai-completions' })
    expect(table.anthropic).toMatchObject({ baseUrl: expect.any(String), models: [] })
    for (const legacy of ['baseUrl', 'api', 'apiKey', 'imageInput', 'contextWindow', 'maxTokens']) {
      expect(data.modules.agent, legacy).not.toHaveProperty(legacy)
    }
  })

  it('modules.apps 只有 timeoutMs / providers / apps：写了已经删掉的 file、models → 启动失败', () => {
    const schema = serverConfigSchema(modules)
    for (const legacy of ['file', 'models']) {
      expect(() => resolveConfig(schema, { files: [], data: { modules: { apps: { [legacy]: {} } } } }, {}), legacy).toThrow(`modules.apps.${legacy}`)
    }
  })

  it('modules.apps：解开注释之后（ComfyUI、ollama、手写的 llm、缺确切 id 的那几个模型）整段都解析得过；示例不用锚点，每个条目写全', () => {
    const source = resolveConfig(serverConfigSchema(modules), { files: [], data }, {})
    const llmProviders = parseLlmProviders(source.get('llm.providers'))
    // 工作流文件是示例路径，这里放一份节点对得上的
    const appRoot = mkdtempSync(path.join(tmpdir(), 'config-example-'))
    try {
      mkdirSync(path.join(appRoot, 'data/comfy'), { recursive: true })
      writeFileSync(
        path.join(appRoot, 'data/comfy/sdxl.json'),
        JSON.stringify({ '3': { class_type: 'KSampler' }, '6': { class_type: 'CLIPTextEncode' }, '10': { class_type: 'LoadImage' } }),
      )
      const runtime = { envVar: () => undefined, appRoot, dataDir: appRoot, llmProviders } as unknown as RuntimeInfo
      const { catalog } = appsConfig.parse((key: string) => source.get(`modules.apps.${key}` as never), runtime)
      const ids = [...catalog.apps.keys()]
      expect(ids).toEqual(
        expect.arrayContaining([
          'ark:doubao-seedream-5-0-pro-260628',
          'ark:doubao-seedream-5-0-lite-XXXXXX',
          'ark:doubao-seedream-4-5-XXXXXX',
          'ark:doubao-seedream-4-0-XXXXXX',
          'ark:doubao-seedance-2-5-XXXXXX',
          'ark:doubao-seedance-2-0-mini-XXXXXX',
          'comfy:sdxl',
          'local:qwen3',
          'writer:qwen-max',
          'llm-selfhost:qwen-max',
        ]),
      )
      expect(catalog.apps.get('ark:doubao-seedream-5-0-lite-XXXXXX')!.info.params.size!.presets!['1:1']).toEqual(['2048x2048', '3072x3072', '4096x4096'])
    } finally {
      rmSync(appRoot, { recursive: true, force: true })
    }
    expect(text).not.toMatch(/^\s*[^#\s].*(?:: |- )[&*][\w-]+/m)
  })
})
