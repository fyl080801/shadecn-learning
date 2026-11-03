import type { FlowTarget } from '@learning/canvas'
import { describe, expect, it, vi } from 'vitest'
import { TASK_ACCESS_LOST, TASK_ACCESS_REVOKED, TASK_AUTHORIZE_UNAVAILABLE, TaskAuthorities, VERDICT_TTL_MS } from '../src/task-authority.js'

/** 执行身份（docs/29 §3.10）：有效权限 = 发起人此刻的权限 ∩ 签发时的快照，失效即停 */
const TEAM: FlowTarget = { projectId: 'p1', kind: 'team', personalOwnerId: null }

function setup(initial: { target?: FlowTarget | null; role?: string | null } = {}) {
  const state = { target: initial.target === undefined ? TEAM : initial.target, role: initial.role === undefined ? 'member' : initial.role, fail: false }
  let clock = 1_000
  const calls = { locate: 0 }
  const authorities = new TaskAuthorities({
    canvas: {
      locate: async () => {
        calls.locate += 1
        if (state.fail) throw new Error('库挂了')
        return state.target
      },
      roleOf: async () => state.role,
    },
    now: () => clock,
  })
  const stop = vi.fn()
  return { state, calls, authorities, stop, request: { taskId: 't1', flowId: 'f1', userId: 'u1', stop }, tick: (ms: number) => (clock += ms) }
}

describe('TaskAuthorities', () => {
  it('签发：画布没了、不是成员都是 revoked，不登记', async () => {
    const noFlow = setup({ target: null })
    await expect(noFlow.authorities.issue(noFlow.request)).rejects.toMatchObject({ kind: 'revoked', message: TASK_ACCESS_LOST })
    const noMember = setup({ role: null })
    await expect(noMember.authorities.issue(noMember.request)).rejects.toMatchObject({ kind: 'revoked' })
    expect(noMember.authorities.live()).toEqual([])
  })

  it('判权结论缓存 3 秒，到期重查；并发判权共用一次查询', async () => {
    const { authorities, request, calls, tick } = setup()
    const authority = await authorities.issue(request)
    const base = calls.locate
    await Promise.all([authority.authorize('flow:read'), authority.authorize('flow:write')])
    expect(calls.locate).toBe(base + 1)
    tick(VERDICT_TTL_MS - 1)
    await authority.authorize('flow:read')
    expect(calls.locate).toBe(base + 1)
    tick(1)
    await authority.authorize('flow:read')
    expect(calls.locate).toBe(base + 2)
  })

  it('被移出项目：下一次判权 revoked + 叫停一次，之后直接拒、不再查库', async () => {
    const { authorities, request, state, stop, calls } = setup()
    const authority = await authorities.issue(request)
    state.role = null
    await expect(authority.authorize('flow:write')).rejects.toMatchObject({ kind: 'revoked', message: TASK_ACCESS_REVOKED })
    expect(stop).toHaveBeenCalledTimes(1)
    const base = calls.locate
    await expect(authority.authorize('flow:read')).rejects.toMatchObject({ kind: 'revoked' })
    expect(calls.locate).toBe(base)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('画布挪到别的项目、个人画布换了所有者：是成员也 revoked', async () => {
    const moved = setup()
    const a = await moved.authorities.issue(moved.request)
    moved.state.target = { ...TEAM, projectId: 'p2' }
    await expect(a.authorize('flow:read')).rejects.toMatchObject({ kind: 'revoked' })

    const personal = setup({ target: { projectId: 'p1', kind: 'personal', personalOwnerId: 'u1' } })
    const b = await personal.authorities.issue(personal.request)
    personal.state.target = { projectId: 'p1', kind: 'personal', personalOwnerId: 'u2' }
    await expect(b.authorize('flow:read')).rejects.toMatchObject({ kind: 'revoked' })
  })

  it('查不了库：这一次 denied、不叫停、不缓存，恢复后照常', async () => {
    const { authorities, request, state, stop } = setup()
    const authority = await authorities.issue(request)
    state.fail = true
    await expect(authority.authorize('flow:write')).rejects.toMatchObject({ kind: 'denied', message: TASK_AUTHORIZE_UNAVAILABLE })
    expect(stop).not.toHaveBeenCalled()
    state.fail = false
    await expect(authority.authorize('flow:write')).resolves.toBeUndefined()
  })

  it('reconcileLive 不用缓存：权限变化当场叫停；查不了库的这次跳过；release 之后不再对账', async () => {
    const { authorities, request, state, stop } = setup()
    const authority = await authorities.issue(request)
    await authority.authorize('flow:read')
    state.fail = true
    await authorities.reconcileLive()
    expect(stop).not.toHaveBeenCalled()
    state.fail = false
    state.role = null
    await authorities.reconcileLive()
    expect(stop).toHaveBeenCalledTimes(1)

    const again = setup()
    const released = await again.authorities.issue(again.request)
    released.release()
    again.state.role = null
    await again.authorities.reconcileLive()
    expect(again.stop).not.toHaveBeenCalled()
    expect(again.authorities.live()).toEqual([])
  })

  it('不在签发范围里的能力 → denied', async () => {
    const { authorities, request } = setup()
    const authority = await authorities.issue(request)
    await expect(authority.authorize('flow:delete' as never)).rejects.toMatchObject({ kind: 'denied' })
  })
})
