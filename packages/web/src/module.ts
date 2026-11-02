import { ConfigService } from '@learning/config'
import { Module } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { resolveWebOptions, WEB_MODULE_OPTIONS, type WebModuleOptions } from './options.js'
import { PageGate } from './page-gate.js'
import { HtmlFallbackController, StaticHost } from './static-host.js'
import { ViteHost } from './vite-host.js'

const WEB_HOST = Symbol('WEB_HOST')

/**
 * 按 `mode` 选开发态（Vite 中间件）或生产态（静态资源）。两个实现都是普通类，由这个工厂 new，生命周期钩子照常跟着 provider 跑
 * （Nest 按实例上有没有这个方法来调）：Fastify 插件和中间件都在 onModuleInit 注册，早于 listen。
 * import vite-host.ts 不会加载 vite：那个文件对它只有类型 import 和 onModuleInit 里的动态 import。
 */
function createHost(adapterHost: HttpAdapterHost, options: WebModuleOptions, gate: PageGate): StaticHost | ViteHost {
  return options.mode === 'static' ? new StaticHost(adapterHost, options, gate) : new ViteHost(adapterHost, options, gate)
}

/**
 * 托管前端的模块，依赖 Fastify 适配器。配置是 config.yaml 的 `web` 段，经全局的 `ConfigService` 取，校验和默认值在 options.ts。
 *
 * 页面闸门**默认开启**，校验的实现由别的模块提供 `WEB_PAGE_AUTH`（本包不依赖 `@learning/session`，接线在应用里）。
 * 闸门开着却没人提供，启动失败，不会悄悄变成不校验（page-gate.ts 的 `connect`）。
 */
@Module({
  controllers: [HtmlFallbackController],
  providers: [
    { provide: WEB_MODULE_OPTIONS, inject: [ConfigService], useFactory: resolveWebOptions },
    PageGate,
    { provide: WEB_HOST, inject: [HttpAdapterHost, WEB_MODULE_OPTIONS, PageGate], useFactory: createHost },
  ],
})
export class WebModule {}
