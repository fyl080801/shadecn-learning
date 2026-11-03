import { AppsService } from '../src/apps.service.js'
import { buildCatalog } from '../src/catalog.js'
import { DRIVERS } from '../src/drivers/index.js'
import type { LlmProviderTable } from '@learning/llm/llm-config'

export interface Recorded {
  url: string
  method: string
  headers: Headers
  body: unknown
}

type Handler = (request: Recorded) => Response | Promise<Response>

/** 脚本化的上游：按 `METHOD 路径前缀` 匹配，记下每个请求 */
export function scriptedFetch(routes: Record<string, Handler>) {
  const requests: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = init?.body
    let body: unknown = raw
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    const recorded: Recorded = { url, method, headers: new Headers(init?.headers), body }
    requests.push(recorded)
    const path = new URL(url).pathname + new URL(url).search
    const key = Object.keys(routes)
      .filter((route) => {
        const [m, prefix] = route.split(' ')
        return m === method && path.startsWith(prefix!)
      })
      .sort((a, b) => b.length - a.length)[0]
    if (!key) return new Response(`没有脚本：${method} ${path}`, { status: 599 })
    return routes[key]!(recorded)
  }) as typeof fetch
  return { fetch: fetchImpl, requests }
}

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

export function serviceOf(
  data: unknown,
  options: { env?: Record<string, string>; fetch?: typeof fetch; appRoot?: string; defaultTimeoutMs?: number; llmProviders?: LlmProviderTable } = {},
): AppsService {
  const catalog = buildCatalog(data, 'modules.apps', {
    drivers: DRIVERS,
    env: { envVar: (name) => options.env?.[name], appRoot: options.appRoot ?? process.cwd(), llmProviders: options.llmProviders ?? {} },
    defaultTimeoutMs: options.defaultTimeoutMs ?? 5_000,
  })
  return new AppsService(catalog, options.fetch ? { fetch: options.fetch } : {})
}
