import { describe, expect, it } from 'vitest'
import {
  AGENT_RUNS_MESSAGE,
  CLOSE_QUOTA_LOCKED,
  CLOSE_REVOKED,
  CLOSE_SUPERSEDED,
  CLOSE_UNAUTHORIZED,
  COLLAB_PATH,
  FLOW_ROOM_PREFIX,
  FLOW_STATE_VECTOR_HEADER,
  STORE_STATE_MESSAGE,
} from '../src/collab.ts'
import { LOGIN_DONE_MESSAGE, LOGIN_DONE_PATH, LOGIN_DONE_SOURCE } from '../src/auth.ts'

/**
 * 线上约定的字面量。前后端现在引的是同一个常量，改了两边都跟着变 —— 但已经发出去的
 * 页面、还连着的老客户端、反向代理的路径规则认的是旧值，所以这些值本身也钉住：
 * 真要改，先把这条用例改掉，等于留一句「我知道这是一次协议变更」。
 */
describe('同步通道的线上约定', () => {
  it('挂载点、房间名前缀、stateless 消息类型、状态向量响应头', () => {
    expect(COLLAB_PATH).toBe('/ws/collaboration')
    expect(FLOW_ROOM_PREFIX).toBe('flow:')
    expect(STORE_STATE_MESSAGE).toBe('flow:store-state')
    expect(AGENT_RUNS_MESSAGE).toBe('agent:runs')
    expect(FLOW_STATE_VECTOR_HEADER).toBe('x-flow-state-vector')
  })

  it('四种终局信号的 code 与 reason', () => {
    expect(CLOSE_SUPERSEDED).toEqual({ code: 4409, reason: 'session-superseded' })
    // 必须与 Hocuspocus 内置的 Unauthorized 一致，前端靠同一个 reason 认两条路
    expect(CLOSE_UNAUTHORIZED).toEqual({ code: 4401, reason: 'Unauthorized' })
    expect(CLOSE_REVOKED).toEqual({ code: 4403, reason: 'permission-revoked' })
    expect(CLOSE_QUOTA_LOCKED).toEqual({ code: 4413, reason: 'quota-exceeded' })
  })
})

describe('新窗口重新登录的线上约定', () => {
  it('落地路径与 postMessage 标记', () => {
    expect(LOGIN_DONE_PATH).toBe('/auth/login-done')
    expect(LOGIN_DONE_SOURCE).toBe('app-auth')
    expect(LOGIN_DONE_MESSAGE).toBe('app-auth:login-done')
  })
})
