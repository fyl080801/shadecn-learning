import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'

/**
 * Kubernetes API 的最小客户端（`k8s` 沙箱驱动用，docs/22 §7.5）：**只用 `node:https` / `node:http`**，不加依赖，
 * **不解析 kubeconfig**（集群内用 ServiceAccount；集群外开发显式给地址 / token 文件 / CA，或者 `kubectl proxy`）。
 *
 * - **token 文件每个请求重新读**：集群内是 projected ServiceAccount token，kubelet 会在过期前轮换文件内容
 *   （默认 1 小时）；读一次缓存住的客户端跑到一小时后就开始 401。读一个几百字节的文件比一次 API 请求便宜得多。
 * - **CA 只在建客户端时读一次**（集群 CA 轮换要重启服务端，和绝大多数客户端一样）。
 * - `http://` 只许回环地址（测试里的假 API、`kubectl proxy`）：bearer token 不能明文出本机。
 * - 连不上（拒绝连接 / 解析不了 / 超时 / TLS 校验失败 / 读不到 token）抛 {@link KubeUnavailableError}，
 *   消息里写明该配哪一项；API 回了非 2xx 抛 {@link KubeError}（带状态码、`Status.reason` 和 API 给的 message）。
 *
 * 本包不读 `process.env`：地址、文件路径由宿主给（{@link kubeConnection} 只是把宿主传进来的值排成一份连接配置）。
 */

export const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'
export const SERVICE_ACCOUNT_TOKEN_FILE = `${SERVICE_ACCOUNT_DIR}/token`
export const SERVICE_ACCOUNT_CA_FILE = `${SERVICE_ACCOUNT_DIR}/ca.crt`

export class KubeError extends Error {
  readonly status: number
  /** API 的 `Status.reason`（`NotFound` / `Forbidden` / `AlreadyExists` / `Expired` …）；没有就是空串 */
  readonly reason: string
  /** API 原样给的 message（不带本客户端加的前缀），驱动拿它判断「配额满了」「准入拒绝」之类 */
  readonly apiMessage: string
  constructor(status: number, reason: string, apiMessage: string, message: string) {
    super(message)
    this.name = 'KubeError'
    this.status = status
    this.reason = reason
    this.apiMessage = apiMessage
  }
}

export class KubeUnavailableError extends Error {
  readonly server: string
  constructor(server: string, detail: string, cause?: unknown) {
    super(`连不上 k8s API（${server}：${detail}）`, cause === undefined ? undefined : { cause })
    this.name = 'KubeUnavailableError'
    this.server = server
  }
}

export const isKubeNotFound = (err: unknown) => err instanceof KubeError && err.status === 404

/** 一份连接配置：`kubeConnection` 算出来，`createKubeClient` 用 */
export interface KubeConnection {
  /** API 地址（可以带路径前缀，如 Rancher 的 `/k8s/clusters/<id>`）；`http://` 只许回环地址 */
  server: string
  /** bearer token 文件，**每个请求重新读**；`null` = 不带 token（`kubectl proxy` 自己加凭据） */
  tokenFile: string | null
  /** CA 证书文件（只对 https 有意义）；`null` = 用系统 CA */
  caFile: string | null
}

/** 宿主传进来的环境值（本包不读 `process.env`） */
export interface KubeConnectionEnv {
  KUBERNETES_SERVICE_HOST?: string | undefined
  KUBERNETES_SERVICE_PORT?: string | undefined
}

/** 宿主的显式配置。文件路径：`undefined` = 用 ServiceAccount 的默认位置，`''` = 不用（不带 token / 用系统 CA） */
export interface KubeConnectionConfig {
  apiUrl: string
  tokenFile?: string | undefined
  caFile?: string | undefined
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 连哪个 API：显式的 `apiUrl` 优先；没配就按集群内的约定（kubelet 给每个 Pod 注入的
 * `KUBERNETES_SERVICE_HOST` / `KUBERNETES_SERVICE_PORT`，IPv6 地址加方括号）。token / CA 默认是 ServiceAccount 挂进来的那两个文件。
 */
export function kubeConnection(
  config: KubeConnectionConfig,
  env: KubeConnectionEnv,
): { ok: true; value: KubeConnection } | { ok: false; reason: string } {
  let server = config.apiUrl.trim()
  if (!server) {
    const host = env.KUBERNETES_SERVICE_HOST?.trim()
    if (!host) {
      return {
        ok: false,
        reason:
          '不在 k8s 集群里（没有 KUBERNETES_SERVICE_HOST），也没配 AGENT_SANDBOX_K8S_API_URL；' +
          '集群外开发可以用 kubectl proxy（AGENT_SANDBOX_K8S_API_URL=http://127.0.0.1:8001、AGENT_SANDBOX_K8S_TOKEN_FILE= 留空；注意它连的是 kubectl 当前的 context）',
      }
    }
    const port = env.KUBERNETES_SERVICE_PORT?.trim() || '443'
    server = `https://${host.includes(':') ? `[${host}]` : host}:${port}`
  }
  let url: URL
  try {
    url = new URL(server)
  } catch {
    return { ok: false, reason: `AGENT_SANDBOX_K8S_API_URL=${server} 不是合法的 URL` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `AGENT_SANDBOX_K8S_API_URL=${server} 只能是 https://（或回环地址上的 http://）` }
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: `AGENT_SANDBOX_K8S_API_URL=${server}：http:// 只许回环地址（kubectl proxy），否则 token 会明文出本机` }
  }
  const pick = (value: string | undefined, fallback: string) => (value === undefined ? fallback : value.trim() || null)
  return {
    ok: true,
    value: {
      server: server.replace(/\/+$/, ''),
      tokenFile: pick(config.tokenFile, SERVICE_ACCOUNT_TOKEN_FILE),
      caFile: url.protocol === 'https:' ? pick(config.caFile, SERVICE_ACCOUNT_CA_FILE) : null,
    },
  }
}

/** 一条流式响应（watch 的事件、日志的行） */
export interface KubeStream {
  /** 流结束（对端结束 / 被 `close()` / 连接断了）时兑现；非 2xx 或连不上时 reject */
  readonly done: Promise<void>
  close(): void
}

export interface KubeLineOptions {
  /** 每行最多保留多少字，超出的部分丢掉（行照样在换行处结束）；默认 1 Mi 字 */
  maxLineChars?: number
  /** 这么久没收到任何字节就当连接死了（watch 用：服务端每 `timeoutSeconds` 会主动结束）；不给 = 不设 */
  idleTimeoutMs?: number
}

export interface KubeClient {
  readonly server: string
  /** 普通请求：2xx → 解析后的 JSON（空响应 = null）；其余抛 {@link KubeError} */
  json<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: object): Promise<T>
  /** 流式 GET：按 `\n` 切行交给 `onLine`（返回 `false` = 不要了，断开）。行内的 `\r` 去掉 */
  lines(path: string, onLine: (line: string) => boolean | void, options?: KubeLineOptions): KubeStream
  /** 关掉保活的连接（测试收尾用） */
  destroy(): void
}

/** 普通请求的超时（建 Pod、列 Pod、删 Pod 都在这之内；流式请求另算） */
const REQUEST_TIMEOUT_MS = 15_000
/** 普通响应最多读这么多（列表 / 错误信息），超了按 API 异常处理 */
const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_LINE_CHARS = 1024 * 1024

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE'])

export function createKubeClient(connection: KubeConnection, options: { timeoutMs?: number } = {}): KubeClient {
  const { server } = connection
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const secure = server.startsWith('https:')
  let ca: Buffer | undefined
  if (secure && connection.caFile) {
    try {
      ca = readFileSync(connection.caFile)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? String(err)
      throw new Error(`读不到 k8s API 的 CA 证书（${connection.caFile}：${code}）；集群外请配 AGENT_SANDBOX_K8S_CA_FILE（留空 = 用系统 CA）`, {
        cause: err,
      })
    }
  }
  const agent = secure ? new https.Agent({ keepAlive: true, ...(ca ? { ca } : {}) }) : new http.Agent({ keepAlive: true })

  async function bearer(): Promise<Record<string, string>> {
    if (!connection.tokenFile) return {}
    let token: string
    try {
      token = (await readFile(connection.tokenFile, 'utf8')).trim()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? String(err)
      throw new KubeUnavailableError(server, `读不到 ServiceAccount token ${connection.tokenFile}（${code}）；集群外请配 AGENT_SANDBOX_K8S_TOKEN_FILE`, err)
    }
    if (!token) throw new KubeUnavailableError(server, `ServiceAccount token ${connection.tokenFile} 是空的`)
    return { authorization: `Bearer ${token}` }
  }

  function unavailable(err: unknown): Error {
    const e = err as NodeJS.ErrnoException
    const code = e?.code ?? ''
    if (CONNECT_ERRORS.has(code)) return new KubeUnavailableError(server, code, err)
    if (code.startsWith('ERR_TLS') || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
      return new KubeUnavailableError(server, `TLS 校验失败 ${code}；检查 AGENT_SANDBOX_K8S_CA_FILE`, err)
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  /** 发请求，拿到响应头就兑现（响应体由调用方读） */
  async function open(
    method: string,
    path: string,
    body: object | undefined,
    opts: { timeout: boolean },
  ): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
    const headers: Record<string, string | number> = { accept: 'application/json', ...(await bearer()) }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
    const url = new URL(server + path)
    return new Promise((resolve, reject) => {
      const req = (secure ? https : http).request(url, { method, headers, agent }, (res) => resolve({ req, res }))
      if (opts.timeout) {
        req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`超过 ${timeoutMs}ms 没有响应`), { code: 'ETIMEDOUT' })))
      }
      req.on('error', (err) => reject(unavailable(err)))
      req.end(payload)
    })
  }

  function readBody(res: http.IncomingMessage, req: http.ClientRequest): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let ended = false
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          ended = true
          reject(new Error(`k8s API 的响应超过 ${MAX_BODY_BYTES} 字节`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        ended = true
        resolve(Buffer.concat(chunks))
      })
      res.on('error', (err) => reject(unavailable(err)))
      // 没读完连接就断了（对端崩溃、网络断开）：按连不上处理，调用方会重试
      res.on('close', () => {
        if (!ended) reject(new KubeUnavailableError(server, '响应中途断开'))
      })
    })
  }

  return {
    server,

    async json<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: object): Promise<T> {
      const { req, res } = await open(method, path, body, { timeout: true })
      const raw = await readBody(res, req)
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) throw kubeError(method, path, status, raw)
      return (raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null) as T
    },

    lines(path, onLine, lineOptions = {}) {
      let req: http.ClientRequest | null = null
      let closed = false
      const maxChars = lineOptions.maxLineChars ?? DEFAULT_MAX_LINE_CHARS
      const done = (async () => {
        const opened = await open('GET', path, undefined, { timeout: false })
        req = opened.req
        const { res } = opened
        if (closed) {
          req.destroy()
          return
        }
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 300) throw kubeError('GET', path, status, await readBody(res, opened.req))
        if (lineOptions.idleTimeoutMs) {
          opened.req.setTimeout(lineOptions.idleTimeoutMs, () => opened.req.destroy())
        }
        await new Promise<void>((resolve) => {
          const splitter = createLineSplitter(maxChars, (line) => {
            if (closed) return
            if (onLine(line) === false) {
              closed = true
              opened.req.destroy()
              resolve()
            }
          })
          res.on('data', (chunk: Buffer) => splitter.push(chunk))
          res.on('end', () => {
            splitter.end()
            resolve()
          })
          // 被 close() / 对端断开 / 空闲超时：流到此为止（不是错误 —— 调用方自己决定要不要重连）
          res.on('error', () => resolve())
          res.on('close', () => resolve())
        })
      })()
      return {
        done,
        close() {
          closed = true
          req?.destroy()
        },
      }
    },

    destroy() {
      agent.destroy()
    },
  }
}

function kubeError(method: string, path: string, status: number, raw: Buffer): KubeError {
  let reason = ''
  let message = raw.toString('utf8').trim()
  try {
    const parsed = JSON.parse(message) as { kind?: string; reason?: string; message?: string }
    if (parsed?.reason) reason = parsed.reason
    if (parsed?.message) message = parsed.message
  } catch {
    // 不是 Status JSON：原样（截短）
  }
  const apiMessage = message.slice(0, 1000)
  const where = `${method} ${path.split('?')[0]}`
  return new KubeError(status, reason, apiMessage, `k8s API 拒绝 ${where}（${status}${reason ? ` ${reason}` : ''}）：${apiMessage.slice(0, 500)}`)
}

/**
 * 按 `\n` 切行（UTF-8 多字节字符跨块也不乱码），每行最多留 `maxChars` 字：超长的行**不会**在内存里无限长 ——
 * 留够了就丢后面的字，直到换行。流结束时剩下的半行也交出去。
 */
export function createLineSplitter(maxChars: number, sink: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  const decoder = new StringDecoder('utf8')
  let partial = ''
  const flush = (line: string) => sink(line.endsWith('\r') ? line.slice(0, -1) : line)
  const take = (text: string) => {
    const pieces = text.split('\n')
    const last = pieces.pop() ?? ''
    for (const piece of pieces) {
      flush((partial + piece).slice(0, maxChars))
      partial = ''
    }
    if (partial.length < maxChars) partial = (partial + last).slice(0, maxChars)
  }
  return {
    push(chunk) {
      take(decoder.write(chunk))
    },
    end() {
      take(decoder.end())
      if (partial) flush(partial)
      partial = ''
    },
  }
}
