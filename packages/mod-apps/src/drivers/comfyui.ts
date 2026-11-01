import { randomInt, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { APP_CATEGORIES, AppError, type AppOutput, type ParamSpec, type ParamType } from '../contract.ts'
import { defineDriver, isRecord, type Fields, type RunContext } from '../driver.ts'
import { decodeDataUrl, fileTypeOf, requestBytes, requestJson, requestOk } from '../http.ts'
import { readParamSpec } from '../params.ts'

/**
 * ComfyUI（docs/29 §4.2）：一个应用 = 一份 **API 格式**的工作流（ComfyUI 里「导出（API）」存下来的 JSON）+ 参数到节点输入的映射。
 * 出图、出视频、出 3D 都是这一个操作，类别由应用自己声明 —— 加一种生成能力 = 加一份工作流和一段应用配置，不改代码。
 *
 * ```yaml
 * options:
 *   workflow: data/comfy/sdxl.json      # 相对应用根目录
 *   category: image
 *   inputs:                              # 参数名 → 节点输入；其余字段同参数表（type / description / required / default / enum / min / max）
 *     prompt: { node: "6", field: text, type: string, required: true }
 *     seed:   { node: "3", field: seed, type: integer, random: true }   # 没给就随机（同参数的请求 ComfyUI 会直接回缓存）
 *     image:  { node: "10", field: image, type: image }                  # 先上传到 ComfyUI，再把文件名填进去
 *   outputs: ["9"]                       # 只收这些节点的产物；不写 = 全部输出节点
 * ```
 *
 * - 流程：`POST /prompt`（`submit` 回句柄 = `prompt_id`）→ `GET /history/{id}`（`poll`，完成时逐个 `GET /view` 取字节）；
 *   取消 = 从队列删掉（还在排队）+ 打断这个 prompt（在跑）。ComfyUI 的地址浏览器通常到不了，所以产物是字节（`data`），不是地址；
 * - **图片参数只收 data URL**：服务端替调用方去抓一个任意地址再上传是 SSRF 的入口（地址可以指向内网）。
 */

interface ComfyProvider {
  baseUrl: string
  apiKey?: string
  pollIntervalMs: number
}

interface InputBinding {
  node: string
  field: string
  random: boolean
  type: ParamType
}

type ComfyGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188'
const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_MAX_OUTPUT_MB = 100
/** 随机种子的范围（ComfyUI 的种子是 64 位，取一个各采样器都接受的区间） */
const MAX_RANDOM_SEED = 2 ** 47

function authHeaders(provider: ComfyProvider): Record<string, string> {
  return provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}
}

function loadWorkflow(file: string, at: string): ComfyGraph {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${at}：读不到工作流 ${file}：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (!isRecord(parsed) || Object.values(parsed).some((node) => !isRecord(node) || typeof node.class_type !== 'string')) {
    throw new Error(`${at}：${file} 不是 API 格式的工作流（要用 ComfyUI 的「导出（API）」，每个节点有 class_type）`)
  }
  return parsed as ComfyGraph
}

/** 读一条 `inputs.<参数名>`：节点绑定（node / field / random）+ 参数说明（其余字段） */
function parseInput(fields: Fields, graph: ComfyGraph): { binding: InputBinding; spec: ParamSpec } {
  const node = fields.string('node', { required: true })
  const field = fields.string('field', { required: true })
  const random = fields.boolean('random', { default: false })!
  const spec = readParamSpec(fields)
  if (!graph[node]) throw new Error(`${fields.at}：工作流里没有节点 ${node}`)
  if (random && spec.type !== 'integer') throw new Error(`${fields.at}：random 只能用在 integer 参数上`)
  if (spec.type === 'images') throw new Error(`${fields.at}：一个节点输入只能填一张图，用 image`)
  return { binding: { node, field, random, type: spec.type }, spec }
}

async function uploadImage(provider: ComfyProvider, value: string, ctx: RunContext): Promise<string> {
  const decoded = decodeDataUrl(value)
  if (!decoded) throw new AppError('invalid_params', 'ComfyUI 的图片参数只收 data:image/…;base64,…（服务端不替调用方抓外部地址）')
  const ext = decoded.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
  const form = new FormData()
  form.append('image', new Blob([decoded.data as Uint8Array<ArrayBuffer>], { type: decoded.mimeType }), `shadecn-${randomUUID()}.${ext}`)
  form.append('overwrite', 'true')
  const uploaded = await requestJson<{ name?: string; subfolder?: string }>(ctx, 'ComfyUI 上传图片', `${provider.baseUrl}/upload/image`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: form,
  })
  if (!uploaded.name) throw new AppError('upstream', 'ComfyUI 上传图片没有返回文件名')
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
}

interface ComfyFile {
  filename: string
  subfolder?: string
  type?: string
}

interface ComfyHistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] }
  outputs?: Record<string, Record<string, unknown>>
}

/** 一个输出节点的产物：`images` / `gifs` / `videos` / `audio` / `3d`… 各种键名，统一认「带 filename 的对象」；预览（`temp`）不要 */
function filesOf(nodeOutput: Record<string, unknown>): ComfyFile[] {
  return Object.values(nodeOutput)
    .filter(Array.isArray)
    .flat()
    .filter((item): item is ComfyFile => isRecord(item) && typeof item.filename === 'string' && item.type !== 'temp')
}

function errorOf(entry: ComfyHistoryEntry): string {
  const message = entry.status?.messages?.find(([kind]) => kind === 'execution_error')?.[1]
  return typeof message?.exception_message === 'string' ? message.exception_message : '执行出错'
}

export const comfyuiDriver = defineDriver<ComfyProvider>({
  type: 'comfyui',
  description: 'ComfyUI（按工作流出图 / 视频 / 3D）',
  parseProvider(fields) {
    const apiKey = fields.secret('apiKey')
    return {
      baseUrl: fields.url('baseUrl', { default: DEFAULT_BASE_URL }),
      pollIntervalMs: fields.integer('pollIntervalMs', { default: DEFAULT_POLL_INTERVAL_MS })!,
      ...(apiKey ? { apiKey } : {}),
    }
  },
  operations: {
    workflow: {
      description: '执行一份 API 格式的工作流',
      // 模型在工作流里（Checkpoint 节点）：要让调用方选，就在 inputs 里把 ckpt_name 映射成带 enum 的参数
      requiresModel: false,
      prepare(options, provider, env) {
        const file = path.resolve(env.appRoot, options.string('workflow', { required: true }))
        const graph = loadWorkflow(file, options.at)
        const category = options.oneOf('category', APP_CATEGORIES, { required: true })
        const maxOutputBytes = options.integer('maxOutputMb', { default: DEFAULT_MAX_OUTPUT_MB })! * 1024 * 1024
        const outputsList = options.list('outputs')
        const missingNode = outputsList?.find((id) => !graph[id])
        if (missingNode) throw new Error(`${options.at}：outputs 里的节点 ${missingNode} 不在工作流里`)
        const outputNodes = outputsList ? new Set(outputsList) : null

        const inputs = options.nested('inputs')
        const bindings = new Map<string, InputBinding>()
        const params: Record<string, ParamSpec> = {}
        for (const name of Object.keys(inputs.raw)) {
          const { binding, spec } = parseInput(inputs.nested(name), graph)
          bindings.set(name, binding)
          params[name] = spec
        }

        return {
          category,
          params,
          pollIntervalMs: provider.pollIntervalMs,
          async submit(values, ctx) {
            const prompt = structuredClone(graph)
            for (const [name, binding] of bindings) {
              let value = values[name]
              if (value === undefined && binding.random) value = randomInt(0, MAX_RANDOM_SEED)
              if (value === undefined) continue
              if (binding.type === 'image') value = await uploadImage(provider, value as string, ctx)
              const node = prompt[binding.node]!
              node.inputs = { ...node.inputs, [binding.field]: value }
            }
            const queued = await requestJson<{ prompt_id?: string; node_errors?: Record<string, unknown> }>(
              ctx,
              'ComfyUI 提交工作流',
              `${provider.baseUrl}/prompt`,
              { method: 'POST', headers: authHeaders(provider), body: { prompt, client_id: `shadecn-${randomUUID()}` } },
            )
            if (!queued.prompt_id) throw new AppError('upstream', 'ComfyUI 没有返回 prompt_id', queued.node_errors)
            return { done: false, handle: { upstreamId: queued.prompt_id } }
          },
          async poll(handle, ctx) {
            const promptId = handle.upstreamId
            const history = await requestJson<Record<string, ComfyHistoryEntry>>(
              ctx,
              'ComfyUI 查询结果',
              `${provider.baseUrl}/history/${encodeURIComponent(promptId)}`,
              { headers: authHeaders(provider) },
            )
            const entry = history[promptId]
            if (!entry) return { done: false, status: 'queued' }
            if (entry.status?.status_str === 'error') throw new AppError('upstream', `ComfyUI 执行失败：${errorOf(entry)}`, { promptId })
            if (!entry.status?.completed) return { done: false, status: 'running' }

            const outputs: AppOutput[] = []
            for (const [nodeId, nodeOutput] of Object.entries(entry.outputs ?? {})) {
              if (outputNodes && !outputNodes.has(nodeId)) continue
              for (const file of filesOf(nodeOutput)) {
                const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
                const { data, contentType } = await requestBytes(ctx, 'ComfyUI 取产物', `${provider.baseUrl}/view?${query}`, {
                  maxBytes: maxOutputBytes,
                  headers: authHeaders(provider),
                })
                const guessed = fileTypeOf(file.filename)
                outputs.push({
                  kind: guessed.kind,
                  data,
                  mimeType: guessed.mimeType ?? contentType,
                  meta: { node: nodeId, filename: file.filename },
                })
              }
            }
            if (outputs.length === 0) throw new AppError('upstream', 'ComfyUI 执行完了，但没有产物（工作流里有保存节点吗？）', { promptId })
            return { done: true, value: { outputs, upstreamId: promptId } }
          },
          async cancel(handle, ctx) {
            const headers = authHeaders(provider)
            // 还在排队：从队列删掉；已经在跑：打断它（带 prompt_id，不打断别人的）
            await requestOk(ctx, 'ComfyUI 取消排队', `${provider.baseUrl}/queue`, { method: 'POST', headers, body: { delete: [handle.upstreamId] } })
            await requestOk(ctx, 'ComfyUI 打断执行', `${provider.baseUrl}/interrupt`, { method: 'POST', headers, body: { prompt_id: handle.upstreamId } })
          },
        }
      },
    },
  },
})
