import { Hono } from 'hono'
import { agentRuntime } from '../agent/index.ts'

/**
 * 画布 Agent 的网关（docs/22 §4）：沙箱里的 runner 只经这里够得着服务端 —— 换令牌、模型请求（服务端调上游，§4.3）、画布工具、
 * 改动通知、事件上报。协议与实现都在 `@shadecn/agent`（`protocol.ts` / `gateway.ts`），这里只是挂载点。
 *
 * 挂在 `AGENT_GATEWAY_PATH`（`/api/agent-gateway`）下，**在 `app.ts` 的登录那道闸之外**（`PUBLIC_API`）：
 * 这里只认 `Authorization: Bearer <run 短令牌>`，浏览器的会话 cookie 在这里一文不值（网关从不看 `c.get('user')`）；
 * 也没有 CSRF / Origin 的问题 —— 没有 cookie 可冒用。每次调用由网关按这一轮的 Grant 实时判权。
 *
 * 一轮只在发起它的那个进程里有登记（run 注册表在进程内存，F14），所以 runner 必须连回同一个实例
 * （`process` 驱动天然如此：`AGENT_GATEWAY_URL` 默认是本机回环）。
 */
export const agentGateway = new Hono().all('/*', (c) => agentRuntime().gateway.handle(c.req.raw))
