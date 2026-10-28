import { describe, expect, it } from 'vitest'
import {
  emptyGraph,
  GRAPH_SCHEMA_VERSION,
  isLegacyNodeData,
  normalizeNodeData,
  STRICT_UPGRADE,
  upgradeEdgeData,
  upgradeNodeData,
} from '../src/flow-graph.ts'

/**
 * 图结构的纯函数。v1 → v2 的升级在前端（读 Y.Doc）和服务端（parseGraph / 投影）
 * 走的是同一份实现，这里守住它本身的契约。
 */

describe('v1 节点 data 升级', () => {
  it('config 拆平、kind 丢掉、补上 status，空壳端口不留', () => {
    const data = upgradeNodeData({
      label: '老节点',
      kind: 'process',
      config: { prompt: '你好', model: 'm1' },
      ports: { inputs: [], outputs: [] },
    })
    expect(data).toEqual({ label: '老节点', status: 'idle', prompt: '你好', model: 'm1' })
  })

  it('框架字段压在业务字段之上：config 里叫 label 的键顶不掉真正的标题', () => {
    const data = upgradeNodeData({ label: '真标题', kind: 'process', config: { label: '业务值' } })
    expect(data.label).toBe('真标题')
  })

  it('有内容的端口保留', () => {
    const ports = { inputs: [{ id: 'in' }], outputs: [] }
    const data = upgradeNodeData({ label: 'x', kind: 'process', config: {}, ports })
    expect(data.ports).toEqual(ports)
  })

  it('createdAt 缺省只要求是 number（前端编辑器投影的判据）', () => {
    expect(upgradeNodeData({ label: 'x', kind: 'p', config: {}, createdAt: 1.5 }).createdAt).toBe(1.5)
    expect(upgradeNodeData({ label: 'x', kind: 'p', config: {}, createdAt: -1 }).createdAt).toBe(-1)
    expect('createdAt' in upgradeNodeData({ label: 'x', kind: 'p', config: {}, createdAt: '1' })).toBe(
      false,
    )
  })

  it('STRICT_UPGRADE 下 createdAt 必须是正的安全整数（服务端的判据）', () => {
    const strict = (createdAt: unknown) =>
      upgradeNodeData({ label: 'x', kind: 'p', config: {}, createdAt }, STRICT_UPGRADE)
    expect('createdAt' in strict(1.5)).toBe(false)
    expect('createdAt' in strict(-1)).toBe(false)
    expect(strict(1_700_000_000_000).createdAt).toBe(1_700_000_000_000)
  })

  it('只有字符串 kind 和对象 config 同时在才算 v1，不误伤叫 config 的业务字段', () => {
    expect(isLegacyNodeData({ kind: 'process', config: {} })).toBe(true)
    expect(isLegacyNodeData({ config: {} })).toBe(false)
    expect(isLegacyNodeData({ kind: 'process', config: 'x' })).toBe(false)
  })
})

describe('v2 节点 data 规范化', () => {
  it('原样收下业务字段，只把框架字段的形状扶正', () => {
    expect(normalizeNodeData({ label: 3, status: 'weird', prompt: 'p' })).toEqual({
      label: '',
      status: 'idle',
      prompt: 'p',
    })
  })
})

describe('v1 连线 data 升级', () => {
  it('config 平铺，kind / condition 是边自己的语义，保留', () => {
    expect(upgradeEdgeData({ kind: 'cond', condition: 'a > 1', config: { weight: 2 } })).toEqual({
      kind: 'cond',
      condition: 'a > 1',
      weight: 2,
    })
  })
})

describe('空图', () => {
  it('是当前版本、视口在原点', () => {
    expect(emptyGraph()).toEqual({
      schemaVersion: GRAPH_SCHEMA_VERSION,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      meta: {},
    })
  })
})
