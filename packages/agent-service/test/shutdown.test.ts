import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { OpenedCanvas } from '@learning/agent-core/session'
import { createAgentRuntime, type AgentRuntime } from '@learning/agent-core/session'
import { gatewayFetch, registerScriptedModel } from '@learning/agent-core/testing'
import { CollabServer, roomOf } from '@learning/collab'
import { DataAccess } from '@learning/data-access'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENT_SHUTDOWN_TIMEOUT_MS } from '../src/agent.module.js'
import { AgentCanvasAccess } from '../src/canvas-access.js'
import { AgentConversation, AgentGrant, AgentRun } from '../src/entities.js'
import { AGENT_HOST_OPTIONS, type AgentHostOptions } from '../src/runtime.js'
import { AGENT_RUNTIME } from '../src/sandbox.js'
import { assertTestDatabase, bootAgentApp, createActor, createFlow, createProject, gated, redisValues, silenceConsole, storedNodeIds, type BootOptions } from './helpers.js'

/**
 * 退出（`docs/31` §4.2）：`abortAll` 在 `onModuleDestroy`，上限 5 秒。一轮收尾要断开 direct connection（落库、卸载），所以必须赶在 `CollabServer.beforeApplicationShutdown` 关房间之前。
 * 真 SIGTERM 在第 6 步；这里走 `app.close()`，是同一条关闭流程。
 */

function suite(name: string, databaseUrl: () => string, schema?: string) {
  describe(name, () => {
    const boot = (): BootOptions => ({ databaseUrl: databaseUrl(), s3: null, values: schema ? redisValues() : {}, agentBelowCollab: true })
    let scripted = registerScriptedModel()

    /** 模块的 runtime 换成脚本化模型 + 生产宿主接线：退出钩子拿到的就是这一份 */
    const scriptedBoot = (): BootOptions => ({
      ...boot(),
      override: (builder) => {
        builder.overrideProvider(AGENT_RUNTIME).useFactory({
          inject: [AGENT_HOST_OPTIONS],
          factory: (host: AgentHostOptions) => createAgentRuntime({ ...scripted.runtimeOptions(), ...host }),
        })
      },
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    afterAll(async () => {
      if (!schema) return
      assertTestDatabase(databaseUrl().split('?')[0]!)
      const app = await bootAgentApp(boot())
      await app.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
      await app.close()
    })

    interface Started {
      app: NestFastifyApplication
      runtime: AgentRuntime
      flowId: string
      userId: string
      /** 这一轮彻底结束 */
      done: Promise<void>
      order: string[]
      closeSeen: { documentLoaded: boolean; connections: number } | null
    }

    /** 起一个 app，发起一轮停在模型请求上；记下收尾和协同关闭的先后 */
    async function startRun(canvasClose?: (real: () => Promise<void>) => Promise<void>): Promise<Started> {
      scripted = registerScriptedModel()
      const hold = gated()
      scripted.setResponses([fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '收尾前写的' } })], { stopReason: 'toolUse' }), hold.step])
      const app = await bootAgentApp(scriptedBoot())
      const runtime = app.get<AgentRuntime>(AGENT_RUNTIME, { strict: false })
      vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
      const alice = await createActor(app)
      const flowId = await createFlow(alice, await createProject(alice))

      const order: string[] = []
      const collab = app.get(CollabServer, { strict: false })
      const realShutdown = collab.beforeApplicationShutdown.bind(collab)
      vi.spyOn(collab, 'beforeApplicationShutdown').mockImplementation(async () => {
        order.push('collab.beforeApplicationShutdown')
        await realShutdown()
      })
      const data = app.get(DataAccess)
      const realClose = data.onApplicationShutdown.bind(data)
      vi.spyOn(data, 'onApplicationShutdown').mockImplementation(() => {
        order.push('orm.close')
        return realClose()
      })

      const state: Started = { app, runtime, flowId, userId: alice.userId, done: Promise.resolve(), order, closeSeen: null }
      const access = app.get(AgentCanvasAccess, { strict: false })
      const started = await runtime.start({
        flowId,
        userId: alice.userId,
        conversationId: null,
        text: '慢慢来',
        openCanvas: async (runId, authority): Promise<OpenedCanvas> => {
          const canvas = await access.open({ flowId, userId: alice.userId, runId, authority })
          const closeReal = canvas.close.bind(canvas)
          return {
            ...canvas,
            close: async () => {
              const document = collab.hocuspocus.documents.get(roomOf(flowId))
              state.closeSeen = { documentLoaded: document !== undefined, connections: document?.getConnectionsCount() ?? 0 }
              order.push('canvas.close')
              await (canvasClose ? canvasClose(closeReal) : closeReal())
              order.push('canvas.closed')
            },
          }
        },
        emit: () => {},
      })
      if (!started.ok) throw new Error(`应该启动成功：${started.message}`)
      state.done = started.done
      await hold.reached
      return state
    }

    it('有一轮在跑时 app.close() 在 5 秒内返回；房间在断开之前还开着，协同是之后才关的；对话、运行日志、画布内容都落了库', async () => {
      const { app, flowId, order, closeSeen: _unused, ...rest } = await startRun()
      void _unused
      const startedAt = Date.now()
      await app.close()
      expect(Date.now() - startedAt).toBeLessThan(AGENT_SHUTDOWN_TIMEOUT_MS)
      await rest.done

      expect(order.indexOf('canvas.close')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('canvas.closed')).toBeGreaterThan(order.indexOf('canvas.close'))
      expect(order.indexOf('collab.beforeApplicationShutdown')).toBeGreaterThan(order.indexOf('canvas.closed'))
      expect(order.indexOf('orm.close')).toBeGreaterThan(order.indexOf('collab.beforeApplicationShutdown'))

      const reopened = await bootAgentApp(boot())
      try {
        const em = reopened.get(DataAccess).em()
        const conversation = await em.findOneOrFail(AgentConversation, { flow: flowId }, { populate: ['messages'] })
        expect(conversation.messageCount).toBeGreaterThan(0)
        expect(await em.findOneOrFail(AgentRun, { flowId })).toMatchObject({ status: 'cancelled', error: '服务正在重启' })
        expect((await em.findOneOrFail(AgentGrant, { flowId })).revokedAt).not.toBeNull()
        // 收尾前写进画布的改动保留
        expect(await storedNodeIds(reopened, flowId)).toHaveLength(1)
      } finally {
        await reopened.close()
      }
    }, 30_000)

    it('断开 direct connection 的时候房间还开着', async () => {
      const state = await startRun()
      await state.app.close()
      expect(state.closeSeen).toEqual({ documentLoaded: true, connections: 1 })
    }, 30_000)

    it('收不了尾的轮次不挡退出：到 5 秒上限就往下走，协同和 ORM 照常关', async () => {
      const state = await startRun(() => new Promise<void>(() => undefined))
      const startedAt = Date.now()
      await state.app.close()
      const elapsed = Date.now() - startedAt
      expect(elapsed).toBeGreaterThanOrEqual(AGENT_SHUTDOWN_TIMEOUT_MS - 100)
      expect(elapsed).toBeLessThan(AGENT_SHUTDOWN_TIMEOUT_MS + 3_000)
      expect(state.order).toContain('collab.beforeApplicationShutdown')
      expect(state.order).toContain('orm.close')
    }, 30_000)

    it('没有轮次在跑时立刻返回', async () => {
      const app = await bootAgentApp(boot())
      const startedAt = Date.now()
      await app.close()
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    }, 30_000)
  })
}

beforeAll(() => silenceConsole())
afterAll(() => vi.restoreAllMocks())

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shutdown-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
suite('退出（SQLite）', () => `file:${path.join(dir, 'test.db')}`)

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
if (postgresUrl) suite('退出（PostgreSQL，PLATFORM_TEST_DATABASE_URL）', () => `${postgresUrl}?schema=agent_shutdown`, 'agent_shutdown')
