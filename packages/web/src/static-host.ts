import fs from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import { Controller, Get, Inject, NotFoundException, type OnModuleInit, Req, Res } from '@nestjs/common'
import type { HttpAdapterHost } from '@nestjs/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  fallbackEntryOf,
  htmlEntriesOf,
  htmlEntryFor,
  isBackendPath,
  protectedHtmlGlobs,
  WEB_MODULE_OPTIONS,
  type WebModuleOptions,
} from './options.js'
import { PageGate } from './page-gate.js'

/**
 * 生产态：直接吐 `vite build` 的产物。
 *
 * 没用 `@nestjs/serve-static`：它只能回退到一个 index 文件，放不下多个 HTML 入口。
 * `wildcard: false` 按启动时的文件列表逐个注册路由，把 `/*` 留给 HtmlFallbackController；
 * `index: false` 让 `/` 也走回退，和其他页面一样带 no-store。
 *
 * 配了闸门时 HTML 文件不注册路由：否则 `GET /index.html` 命中文件路由，绕过 HtmlFallbackController 里的闸门。
 * 不注册之后这些路径落到回退路由，和其他页面走同一个判定。
 */
export class StaticHost implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly options: WebModuleOptions,
    private readonly gate: PageGate,
  ) {}

  async onModuleInit() {
    this.gate.connect()
    const { root } = this.options
    for (const entry of [fallbackEntryOf(this.options), ...htmlEntriesOf(this.options).values()]) {
      if (!fs.existsSync(path.join(root, entry))) {
        throw new Error(`[web] 没找到 ${path.join(root, entry)}，先构建前端`)
      }
    }
    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>()
    await fastify.register(fastifyStatic, {
      root,
      prefix: '/',
      index: false,
      wildcard: false,
      ...(this.options.auth ? { globIgnore: protectedHtmlGlobs(this.options) } : {}),
    })
  }
}

/**
 * 路由未命中文件时回落到 HTML 入口；后端前缀下的未知路径仍是 JSON 404。
 *
 * 静态 `@Module` 不能按配置决定 controllers，所以 dev 下它也注册着。不会抢 Vite 的路由：Vite 是中间件，跑在 Fastify 的 onRequest 里，
 * 除了后端前缀的路径都在那里答完，走不到路由处理函数；走到这里的只有后端前缀下的未知路径，两种模式都是 404。
 * 万一有页面请求漏过来也回 404：dev 的 root 里是没转译过的源码入口，不能原样发出去。
 */
@Controller()
export class HtmlFallbackController {
  constructor(
    @Inject(WEB_MODULE_OPTIONS) private readonly options: WebModuleOptions,
    @Inject(PageGate) private readonly gate: PageGate,
  ) {}

  @Get('*')
  async sendHtml(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    if (this.options.mode !== 'static' || isBackendPath(this.options, req.url)) throw new NotFoundException()
    // 闸门抛错不接：Nest 的异常过滤器回 500，HTML 不会发出去
    const access = await this.gate.check({ url: req.url, headers: req.headers })
    if (access.kind === 'not-found') throw new NotFoundException()
    if (access.kind === 'redirect') {
      return reply.code(302).header('location', access.location).header('cache-control', 'no-store').send()
    }
    const file = path.join(this.options.root, htmlEntryFor(this.options, req.url))
    const html = await fs.promises.readFile(file, 'utf8')
    // HTML 可能带着 query 渲染（如登录页的 ?error=），不能被缓存
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html)
  }
}
