import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common'
import type { HttpAdapterHost } from '@nestjs/core'
import type { ViteDevServer } from 'vite'
import { htmlEntryFor, isBackendPath, type WebModuleOptions } from './options.js'
import { isHtmlFilePath, type PageGate } from './page-gate.js'

/**
 * 开发态：Vite 以中间件形式挂到 Nest 的 http server 上，前后端同一个端口。
 *
 * 中间件跑在路由匹配之前，所以**后端路由必须都在 apiPrefix 下**，否则会被前端接管。
 * vite 只在这里动态加载：它是可选 peer，生产环境没有，这个文件不能有 vite 的运行时静态 import。
 *
 * 配了闸门时，指向 HTML 文件的请求**不进 Vite**，直接走 {@link ViteHost.sendHtml} 的判定：Vite 有好几条路能把 HTML 原文交出去
 * （`/@fs/<绝对路径>/index.html`、`/index.html?raw&import`、`/@id/...?raw&import`），都发生在回落到 sendHtml 之前。
 * 代价：入口 HTML 不能写内联的 `<script type="module">`（Vite 把它拆成 `/index.html?html-proxy&...` 请求，这里会回 HTML 而不是 JS）。
 */
export class ViteHost implements OnModuleInit, BeforeApplicationShutdown {
  private vite?: ViteDevServer

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly options: WebModuleOptions,
    private readonly gate: PageGate,
  ) {}

  async onModuleInit() {
    // 排在启动 Vite 之前：闸门接不上就拒绝启动，不留一个开着文件监听的 Vite
    this.gate.connect()
    const adapter = this.adapterHost.httpAdapter
    const { createServer } = await import('vite')
    const vite = await createServer({
      root: this.options.root,
      // SPA fallback 由这里自己做，这样才能区分多个 HTML 入口
      appType: 'custom',
      server: {
        middlewareMode: true,
        // HMR 复用后端的 http server，不另开 24678 端口
        hmr: { server: adapter.getHttpServer() },
      },
    })
    this.vite = vite

    adapter.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
      if (isBackendPath(this.options, req.url)) {
        next()
        return
      }
      if (this.options.auth && isHtmlFilePath(this.options, req.url)) {
        this.sendHtml(vite, req, res).catch(next)
        return
      }
      // Vite 的中间件可能改写 req.url，闸门和入口选择要用原始地址
      const url = req.url
      vite.middlewares(req, res, (err?: unknown) => {
        if (err) next(err)
        else this.sendHtml(vite, req, res, url).catch(next)
      })
    })
  }

  /** 连接在这一步之后才关闭：Vite 要先断开 HMR 连接，否则 http server 等不到连接清空 */
  async beforeApplicationShutdown() {
    await this.vite?.close()
  }

  private async sendHtml(vite: ViteDevServer, req: IncomingMessage, res: ServerResponse, url = req.url) {
    const sendJson = (statusCode: number, message: string) => {
      res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ statusCode, message }))
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(404, 'Not Found')
      return
    }

    let access
    try {
      access = await this.gate.check({ url, headers: req.headers })
    } catch (err) {
      // 判断不了就不发 HTML。这里不交给 next(err)：错误信息不该原样进响应，和 static 模式的 500 保持一致
      console.error('[web] 页面闸门校验失败', err)
      sendJson(500, 'Internal server error')
      return
    }
    if (access.kind === 'not-found') {
      sendJson(404, 'Not Found')
      return
    }
    if (access.kind === 'redirect') {
      res.writeHead(302, { location: access.location, 'cache-control': 'no-store' })
      res.end()
      return
    }

    const file = path.join(this.options.root, htmlEntryFor(this.options, url))
    const html = await vite.transformIndexHtml(url ?? '/', await fs.readFile(file, 'utf8'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : html)
  }
}
