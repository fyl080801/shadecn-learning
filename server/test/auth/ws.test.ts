import type { IncomingMessage } from 'node:http'
import { beforeEach, describe, expect, it } from 'vitest'
import { authorizeUpgrade } from '../../auth/ws.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, joinViaInvite } from '../helpers/project.ts'

/**
 * WebSocket 握手鉴权。
 *
 * 房间即资源：画布房间（`flow:<id>`）必须是项目成员才进得去，
 * 否则任何登录用户都能连进别人项目的画布，看见在场的人和他们的光标。
 */

/** 只用到 headers.cookie，够 authorizeUpgrade 用了 */
function upgrade(cookie?: string): IncomingMessage {
  return { headers: cookie ? { cookie } : {} } as IncomingMessage
}

describe('authorizeUpgrade', () => {
  beforeEach(resetDb)

  it('没有 cookie → 拒绝', async () => {
    expect(await authorizeUpgrade(upgrade(), 'demo')).toBe(false)
  })

  it('cookie 是伪造的 → 拒绝', async () => {
    expect(await authorizeUpgrade(upgrade('sid=not-a-real-token'), 'demo')).toBe(false)
  })

  it('登录用户可以进演示房间', async () => {
    const alice = await actor('alice')
    expect(await authorizeUpgrade(upgrade(alice.cookie), 'demo')).toBe(true)
  })

  it('项目成员可以进自己画布的房间', async () => {
    const alice = await actor('alice')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    expect(await authorizeUpgrade(upgrade(alice.cookie), `flow:${flowId}`)).toBe(true)
  })

  it('加入项目之后就进得去了', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    expect(await authorizeUpgrade(upgrade(bob.cookie), `flow:${flowId}`)).toBe(false)

    await joinViaInvite(alice, projectId, bob)
    expect(await authorizeUpgrade(upgrade(bob.cookie), `flow:${flowId}`)).toBe(true)
  })

  it('画布不存在 → 拒绝（不给探测画布是否存在的机会）', async () => {
    const alice = await actor('alice')
    expect(await authorizeUpgrade(upgrade(alice.cookie), 'flow:不存在的画布')).toBe(false)
  })
})
