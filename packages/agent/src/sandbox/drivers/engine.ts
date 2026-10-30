import { statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * Docker Engine API 的最小客户端（`oci` 沙箱驱动用，docs/22 §7）：**HTTP over unix socket，只用 `node:http`**，不加依赖。
 * Podman 的 compat API（`podman system service` / podman machine 的 socket）说的是同一套协议。
 *
 * - **路径不带版本前缀**（`/containers/create` 而不是 `/v1.41/…`）：两家都按「这个引擎的当前 API 版本」处理。
 *   写死版本号会撞上 Docker 29 起把最低 API 版本抬到 1.44 这种事；这里用到的字段多年没变过。
 * - 只实现驱动要的那几个接口：ping / version / 镜像与网络查询 / 容器的建、起、等、杀、删、列、日志。
 * - 引擎连不上（socket 不存在 / 拒绝连接 / 没权限）抛 {@link EngineUnavailableError}，消息里带 socket 路径和该配哪一项；
 *   引擎回了非 2xx 抛 {@link EngineError}（带状态码和引擎给的 message）。
 *
 * 本包不读 `process.env`：socket 路径由宿主给（{@link engineSocketCandidates} 只是把宿主传进来的环境值排成候选）。
 */

export class EngineError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'EngineError'
    this.status = status
  }
}

export class EngineUnavailableError extends Error {
  readonly socketPath: string
  constructor(socketPath: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | null)?.code ?? (cause instanceof Error ? cause.message : String(cause))
    super(`连不上容器引擎（${socketPath}：${code}）；确认 Docker / Podman 在运行，或用 AGENT_SANDBOX_OCI_SOCKET 指定 socket`, { cause })
    this.name = 'EngineUnavailableError'
    this.socketPath = socketPath
  }
}

export const isNotFound = (err: unknown) => err instanceof EngineError && err.status === 404

/** `GET /containers/json` 的一项（只取驱动要的字段） */
export interface ContainerSummary {
  Id: string
  Names?: string[]
  State?: string
  Labels?: Record<string, string>
}

/** `GET /containers/{id}/json` 里驱动要的那几个字段 */
export interface ContainerState {
  running: boolean
  exitCode: number | null
  oomKilled: boolean
}

export interface EngineVersion {
  /** 「Docker Engine」/「Podman Engine」… */
  name: string
  version: string
  apiVersion: string
}

/** 日志的一行（stdout / stderr 已经分开，按 `\n` 切好） */
export type LogSink = (stream: 'stdout' | 'stderr', line: string) => void

export interface LogFollow {
  /** 日志流结束（容器停了 / 被删 / 连接断了）时兑现；从不 reject */
  readonly done: Promise<void>
  /** 不再读了（容器删之前调，免得留一条挂着的连接） */
  close(): void
}

export interface EngineClient {
  readonly socketPath: string
  ping(): Promise<void>
  version(): Promise<EngineVersion>
  imageExists(image: string): Promise<boolean>
  /** 网络不存在 → null */
  network(name: string): Promise<{ internal: boolean; driver: string } | null>
  createContainer(name: string, config: object): Promise<string>
  startContainer(id: string): Promise<void>
  /** 长轮询到容器不在运行，给出退出码（`signal` 掐掉这个长连接） */
  waitContainer(id: string, signal?: AbortSignal): Promise<number>
  inspectContainer(id: string): Promise<ContainerState>
  /** SIGKILL；容器已经停了（409）/ 不在了（404）不算错 */
  killContainer(id: string): Promise<void>
  /** 强制删除（在跑也删）连同匿名卷；不在了（404）不算错 */
  removeContainer(id: string): Promise<void>
  /** 带着全部这些 label（`key=value`）的容器，含已停止的 */
  listContainers(labels: readonly string[]): Promise<ContainerSummary[]>
  /** 从头跟随容器日志，直到它停下 */
  followLogs(id: string, sink: LogSink): LogFollow
}

/** 普通请求的超时（建容器、起容器都在这之内；等退出和跟日志不设超时） */
const REQUEST_TIMEOUT_MS = 30_000
/** 响应体最多读这么多（列表 / 错误信息），超了按引擎异常处理 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

interface RawResponse {
  status: number
  body: Buffer
}

export function createEngineClient(socketPath: string, options: { timeoutMs?: number } = {}): EngineClient {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  function request(
    method: string,
    requestPath: string,
    body?: object,
    opts: { timeout?: boolean; signal?: AbortSignal } = {},
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = http.request(
        {
          socketPath,
          method,
          path: requestPath,
          ...(opts.signal ? { signal: opts.signal } : {}),
          headers: {
            host: 'engine',
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
              req.destroy(new Error(`引擎响应超过 ${MAX_BODY_BYTES} 字节`))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
          res.on('error', reject)
        },
      )
      if (opts.timeout !== false) {
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`引擎请求 ${method} ${requestPath.split('?')[0]} 超过 ${timeoutMs}ms 没有响应`)))
      }
      req.on('error', (err: NodeJS.ErrnoException) => {
        reject(isConnectError(err) ? new EngineUnavailableError(socketPath, err) : err)
      })
      req.end(payload)
    })
  }

  async function json<T>(
    method: string,
    requestPath: string,
    body?: object,
    opts?: { timeout?: boolean; signal?: AbortSignal },
  ): Promise<T> {
    const res = await request(method, requestPath, body, opts)
    if (res.status < 200 || res.status >= 300) throw engineError(method, requestPath, res)
    return (res.body.length > 0 ? JSON.parse(res.body.toString('utf8')) : null) as T
  }

  async function send(method: string, requestPath: string, ok: readonly number[], body?: object): Promise<number> {
    const res = await request(method, requestPath, body)
    if ((res.status >= 200 && res.status < 300) || ok.includes(res.status)) return res.status
    throw engineError(method, requestPath, res)
  }

  const id = (value: string) => encodeURIComponent(value)

  return {
    socketPath,

    async ping() {
      await send('GET', '/_ping', [])
    },

    async version() {
      const v = await json<{ Version?: string; ApiVersion?: string; Components?: { Name?: string }[] }>('GET', '/version')
      return {
        name: v?.Components?.[0]?.Name ?? 'Docker Engine',
        version: v?.Version ?? '?',
        apiVersion: v?.ApiVersion ?? '?',
      }
    },

    async imageExists(image) {
      const res = await request('GET', `/images/${id(image)}/json`)
      if (res.status === 404) return false
      if (res.status >= 200 && res.status < 300) return true
      throw engineError('GET', '/images/…/json', res)
    },

    async network(name) {
      const res = await request('GET', `/networks/${id(name)}`)
      if (res.status === 404) return null
      if (res.status < 200 || res.status >= 300) throw engineError('GET', '/networks/…', res)
      const net = JSON.parse(res.body.toString('utf8')) as { Internal?: boolean; Driver?: string }
      return { internal: net.Internal === true, driver: net.Driver ?? '' }
    },

    async createContainer(name, config) {
      const created = await json<{ Id: string }>('POST', `/containers/create?name=${id(name)}`, config)
      if (!created?.Id) throw new EngineError(500, '引擎建了容器却没给 Id')
      return created.Id
    },

    async startContainer(containerId) {
      // 304 = 已经在跑
      await send('POST', `/containers/${id(containerId)}/start`, [304])
    },

    async waitContainer(containerId, signal) {
      const result = await json<{ StatusCode?: number }>('POST', `/containers/${id(containerId)}/wait?condition=not-running`, undefined, {
        timeout: false,
        ...(signal ? { signal } : {}),
      })
      return typeof result?.StatusCode === 'number' ? result.StatusCode : -1
    },

    async inspectContainer(containerId) {
      const c = await json<{ State?: { Running?: boolean; ExitCode?: number; OOMKilled?: boolean } }>('GET', `/containers/${id(containerId)}/json`)
      return {
        running: c?.State?.Running === true,
        exitCode: typeof c?.State?.ExitCode === 'number' ? c.State.ExitCode : null,
        oomKilled: c?.State?.OOMKilled === true,
      }
    },

    async killContainer(containerId) {
      await send('POST', `/containers/${id(containerId)}/kill?signal=SIGKILL`, [404, 409])
    },

    async removeContainer(containerId) {
      await send('DELETE', `/containers/${id(containerId)}?force=true&v=true`, [404])
    },

    async listContainers(labels) {
      const filters = encodeURIComponent(JSON.stringify({ label: labels }))
      return (await json<ContainerSummary[]>('GET', `/containers/json?all=true&filters=${filters}`)) ?? []
    },

    followLogs(containerId, sink) {
      let req: http.ClientRequest | null = null
      const done = new Promise<void>((resolve) => {
        req = http.request(
          {
            socketPath,
            method: 'GET',
            path: `/containers/${id(containerId)}/logs?follow=true&stdout=true&stderr=true`,
            headers: { host: 'engine' },
          },
          (res) => {
            if ((res.statusCode ?? 0) >= 300) {
              res.resume()
              res.on('end', resolve)
              return
            }
            const demux = createLogDemuxer(sink)
            res.on('data', (chunk: Buffer) => demux.push(chunk))
            res.on('end', () => {
              demux.end()
              resolve()
            })
            res.on('error', () => {
              demux.end()
              resolve()
            })
            res.on('close', resolve)
          },
        )
        req.on('error', () => resolve())
        req.end()
      })
      return {
        done,
        close: () => {
          req?.destroy()
        },
      }
    },
  }
}

function isConnectError(err: NodeJS.ErrnoException): boolean {
  return ['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTSOCK', 'ECONNRESET', 'EPIPE'].includes(err.code ?? '')
}

function engineError(method: string, requestPath: string, res: RawResponse): EngineError {
  let message = res.body.toString('utf8').trim()
  try {
    const parsed = JSON.parse(message) as { message?: string }
    if (parsed?.message) message = parsed.message
  } catch {
    // 不是 JSON：原样（截短）
  }
  return new EngineError(res.status, `容器引擎拒绝 ${method} ${requestPath.split('?')[0]}（${res.status}）：${message.slice(0, 500)}`)
}

/**
 * 拆 Docker 的多路日志流（没开 TTY 时 `/logs` 和 `/attach` 都是这个格式）：
 * 每帧 8 字节头 `[流类型, 0, 0, 0, 长度(大端 u32)]` + 内容；流类型 1 = stdout、2 = stderr。
 * 帧可能被拆在任意位置，一行也可能跨帧；按流各自攒到 `\n` 再交出去（UTF-8 多字节字符跨帧也不乱码）。
 */
export function createLogDemuxer(sink: LogSink): { push(chunk: Buffer): void; end(): void } {
  let pending: Buffer = Buffer.alloc(0)
  const streams = {
    stdout: { decoder: new StringDecoder('utf8'), partial: '' },
    stderr: { decoder: new StringDecoder('utf8'), partial: '' },
  }
  const emit = (name: 'stdout' | 'stderr', text: string) => {
    const state = streams[name]
    const lines = (state.partial + text).split('\n')
    state.partial = lines.pop() ?? ''
    for (const line of lines) sink(name, line.endsWith('\r') ? line.slice(0, -1) : line)
  }
  return {
    push(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      while (pending.length >= 8) {
        const size = pending.readUInt32BE(4)
        if (pending.length < 8 + size) break
        const type = pending[0]
        const payload = pending.subarray(8, 8 + size)
        pending = pending.subarray(8 + size)
        // 0 = stdin（不会出现）；其余按 stdout 处理
        const name = type === 2 ? 'stderr' : 'stdout'
        emit(name, streams[name].decoder.write(payload))
      }
    },
    end() {
      for (const name of ['stdout', 'stderr'] as const) {
        const state = streams[name]
        const rest = state.partial + state.decoder.end()
        state.partial = ''
        if (rest) sink(name, rest)
      }
    },
  }
}

// —— socket 在哪 ——

/** 宿主传进来的环境值（本包不读 `process.env`） */
export interface EngineSocketEnv {
  DOCKER_HOST?: string | undefined
  XDG_RUNTIME_DIR?: string | undefined
  HOME?: string | undefined
  TMPDIR?: string | undefined
}

/**
 * 没显式配 socket 时按这个顺序找（docs/22 §7）：
 *
 * 1. `DOCKER_HOST`（只认 `unix://`；配了别的协议直接报错 —— 它表达了「用哪个引擎」，悄悄换一个更糟）；
 * 2. `/var/run/docker.sock`（Docker 的默认位置；macOS 上 podman 的 mac-helper 也在这儿放链接）；
 * 3. Linux 上的 Podman：`$XDG_RUNTIME_DIR/podman/podman.sock`（rootless）、`/run/podman/podman.sock`（rootful）；
 * 4. macOS 的 podman machine：`~/.local/share/containers/podman/machine/podman.sock`（podman 维护的链接）、
 *    `$TMPDIR/podman/podman-machine-default-api.sock`（默认机器的 API socket，
 *    即 `podman machine inspect` 的 `ConnectionInfo.PodmanSocket.Path`）；
 * 5. Docker Desktop（macOS）：`~/.docker/run/docker.sock`。
 *
 * **不调 podman / docker CLI**：服务端运行时不依赖它们在不在 PATH 上。找不到就让人配 `AGENT_SANDBOX_OCI_SOCKET`。
 */
export function engineSocketCandidates(env: EngineSocketEnv): { ok: true; candidates: string[] } | { ok: false; reason: string } {
  const dockerHost = env.DOCKER_HOST?.trim()
  if (dockerHost) {
    if (!dockerHost.startsWith('unix://')) {
      return { ok: false, reason: `DOCKER_HOST=${dockerHost} 不是 unix:// socket；oci 沙箱驱动只连本机 socket，请配 AGENT_SANDBOX_OCI_SOCKET` }
    }
    return { ok: true, candidates: [dockerHost.slice('unix://'.length)] }
  }
  const candidates = ['/var/run/docker.sock']
  if (env.XDG_RUNTIME_DIR) candidates.push(path.join(env.XDG_RUNTIME_DIR, 'podman', 'podman.sock'))
  candidates.push('/run/podman/podman.sock')
  if (env.HOME) candidates.push(path.join(env.HOME, '.local/share/containers/podman/machine/podman.sock'))
  if (env.TMPDIR) candidates.push(path.join(env.TMPDIR, 'podman', 'podman-machine-default-api.sock'))
  if (env.HOME) candidates.push(path.join(env.HOME, '.docker/run/docker.sock'))
  return { ok: true, candidates }
}

/** 显式配置的那个（`unix://` 前缀可有可无）；不是 socket 就报错，不再往下找 */
export function findEngineSocket(configured: string, env: EngineSocketEnv): { ok: true; path: string } | { ok: false; reason: string } {
  if (configured) {
    const explicit = configured.startsWith('unix://') ? configured.slice('unix://'.length) : configured
    if (isSocket(explicit)) return { ok: true, path: explicit }
    return { ok: false, reason: `AGENT_SANDBOX_OCI_SOCKET=${configured} 不是一个可用的 unix socket` }
  }
  const listed = engineSocketCandidates(env)
  if (!listed.ok) return listed
  const found = listed.candidates.find(isSocket)
  if (found) return { ok: true, path: found }
  return {
    ok: false,
    reason: `找不到容器引擎的 socket（找过：${listed.candidates.join('、')}）；请用 AGENT_SANDBOX_OCI_SOCKET 指定（podman machine 见 \`podman machine inspect\` 的 ConnectionInfo.PodmanSocket.Path）`,
  }
}

function isSocket(candidate: string): boolean {
  try {
    // statSync 跟随符号链接：podman / docker 常把 socket 链到别处
    return statSync(candidate).isSocket()
  } catch {
    return false
  }
}
