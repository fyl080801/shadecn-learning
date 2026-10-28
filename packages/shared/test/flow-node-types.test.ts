import { describe, expect, it } from 'vitest'
import { FALLBACK_NODE_TYPE } from '../src/flow-graph.ts'
import {
  buildNodeData,
  buildNodeDefaults,
  GROUP_DEFAULT_BACKGROUND,
  GROUP_DEFAULT_SIZE,
  GROUP_Z_INDEX,
  nodeTypeDefaultsOf,
} from '../src/flow-node-types.ts'

/**
 * 节点类型的默认值 —— 人在界面上点出来的节点和 agent 建的节点必须长得一样，
 * 所以默认值只有这一份（REQ-AGENT §3.2）。
 */
describe('节点类型默认值', () => {
  it('文本节点：框架字段 + 空正文', () => {
    const data = buildNodeData('text', '标题')
    expect(data).toMatchObject({ label: '标题', status: 'idle', text: '' })
    expect(typeof data.createdAt).toBe('number')
    expect(buildNodeDefaults('text')).toEqual({})
  })

  it('分组：底色 + 固定尺寸 + 负层级（压在所有节点下面）', () => {
    expect(buildNodeData('group', '组')).toMatchObject({ background: GROUP_DEFAULT_BACKGROUND })
    expect(buildNodeDefaults('group')).toEqual({ ...GROUP_DEFAULT_SIZE, zIndex: GROUP_Z_INDEX })
    expect(GROUP_Z_INDEX).toBeLessThan(0)
  })

  it('认不出的类型按兜底类型（和 fromYNode 同一个），不带业务字段', () => {
    expect(nodeTypeDefaultsOf('不存在的类型').type).toBe(FALLBACK_NODE_TYPE)
    expect(Object.keys(buildNodeData('不存在的类型', 'x')).sort()).toEqual(['createdAt', 'label', 'status'])
  })

  it('每次拿到的是新对象：改一个节点的默认值不会串到下一个', () => {
    const a = buildNodeDefaults('group')
    a.width = 1
    expect(buildNodeDefaults('group').width).toBe(GROUP_DEFAULT_SIZE.width)
  })
})
