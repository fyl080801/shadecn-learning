import { describe, expect, it } from 'vitest'
import {
  AGENT_ATTACHMENT_MAX_COUNT,
  AGENT_ATTACHMENT_NAME_MAX_LENGTH,
  agentAttachmentKind,
  agentHolderLabel,
  parseAgentAttachmentRefs,
  agentRunAbortPath,
  agentRunEventsPath,
  canonicalSkillIds,
  formatAgentRunsMessage,
  parseAgentRunsMessage,
  withMine,
  type AgentRunEntry,
} from '../src/agent.ts'
import { AGENT_RUNS_MESSAGE, STORE_STATE_MESSAGE } from '../src/collab.ts'

/**
 * 运行中任务列表的推送载荷（docs/20 §3.10.4）：服务端序列化、前端防御式解析、`mine` 由前端自己算。
 * 解析器的底线同 `parseStoreState`：一条读不懂的 stateless 消息绝不能抛 —— 那会打断整条连接的消息处理。
 */

const run = (overrides: Partial<AgentRunEntry> = {}): AgentRunEntry => ({
  runId: 'run_1',
  conversationId: 'conv_1',
  conversationTitle: '改一下 @{node:n_a}',
  owner: { id: 'u1', name: '甲', avatarUrl: '/api/avatars/u1' },
  startedAt: 1_700_000_000_000,
  occupies: [],
  expiresAt: 1_700_000_030_000,
  ...overrides,
})

describe('任务列表消息', () => {
  it('序列化之后原样解析回来（含 flowId、顺序）', () => {
    const runs = [run(), run({ runId: 'run_2', owner: { id: 'u2', name: '乙', avatarUrl: null } })]
    const payload = formatAgentRunsMessage('flow_1', runs, 123)
    expect(JSON.parse(payload)).toMatchObject({ type: AGENT_RUNS_MESSAGE, flowId: 'flow_1', now: 123 })
    expect(parseAgentRunsMessage(payload)).toEqual({ flowId: 'flow_1', runs, now: 123 })
    expect(parseAgentRunsMessage(formatAgentRunsMessage('flow_1', [], 5))).toEqual({ flowId: 'flow_1', runs: [], now: 5 })
  })

  it('不是这类消息 / 不是 JSON / 整体形状不对 → null，不抛', () => {
    for (const payload of [
      '',
      '{',
      'null',
      '42',
      '[]',
      JSON.stringify({ type: STORE_STATE_MESSAGE, ok: false }),
      JSON.stringify({ type: AGENT_RUNS_MESSAGE }),
      JSON.stringify({ type: AGENT_RUNS_MESSAGE, flowId: 'f', runs: {} }),
      JSON.stringify({ type: AGENT_RUNS_MESSAGE, flowId: 1, runs: [] }),
    ]) {
      expect(parseAgentRunsMessage(payload)).toBeNull()
    }
  })

  it('个别项形状不对只丢那一项；多出来的字段不往下传；没有头像字段当 null', () => {
    const good = run()
    const payload = JSON.stringify({
      type: AGENT_RUNS_MESSAGE,
      flowId: 'f',
      runs: [
        good,
        null,
        'run_x',
        { ...good, runId: '' },
        { ...good, conversationId: null },
        { ...good, startedAt: 'yesterday' },
        { ...good, owner: { id: 'u3' } },
        { ...good, owner: { id: 'u3', name: '丙', avatarUrl: 7 } },
        { ...good, runId: 'run_extra', mine: true, owner: { id: 'u4', name: '丁', email: 'd@example.com' } },
      ],
    })
    expect(parseAgentRunsMessage(payload)).toEqual({
      flowId: 'f',
      runs: [good, { ...good, runId: 'run_extra', owner: { id: 'u4', name: '丁', avatarUrl: null } }],
    })
  })

  it('入口节点 nodeId 原样带回；不是非空字符串就当没有，不丢整项', () => {
    const bound = run({ runId: 'run_bound', nodeId: 'n_dir' })
    const plain = run()
    const payload = JSON.stringify({
      type: AGENT_RUNS_MESSAGE,
      flowId: 'f',
      runs: [bound, { ...plain, runId: 'run_empty', nodeId: '' }, { ...plain, runId: 'run_num', nodeId: 7 }, plain],
    })
    const parsed = parseAgentRunsMessage(payload)
    expect(parsed?.runs).toEqual([bound, { ...plain, runId: 'run_empty' }, { ...plain, runId: 'run_num' }, plain])
    expect(parsed?.runs[1]).not.toHaveProperty('nodeId')
  })

  it('occupies / expiresAt：防御式解析 —— 非数组当空、坏 id 丢掉、重复去掉；expiresAt 不是有限数字就没有；都不丢整项', () => {
    const plain = run()
    const payload = JSON.stringify({
      type: AGENT_RUNS_MESSAGE,
      flowId: 'f',
      now: 'later',
      runs: [
        { ...plain, runId: 'a', occupies: ['n1', 'n1', 7, '', 'x'.repeat(65), 'n2'] },
        { ...plain, runId: 'b', occupies: 'n1', expiresAt: 'soon' },
        { ...plain, runId: 'c', occupies: undefined, expiresAt: Number.NaN },
      ],
    })
    const parsed = parseAgentRunsMessage(payload)!
    expect(parsed).not.toHaveProperty('now')
    expect(parsed.runs.map((entry) => entry.occupies)).toEqual([['n1', 'n2'], [], []])
    expect(parsed.runs[0]!.expiresAt).toBe(plain.expiresAt)
    expect(parsed.runs[1]).not.toHaveProperty('expiresAt')
    expect(parsed.runs[2]).not.toHaveProperty('expiresAt')
  })

  it('agentHolderLabel：团队画布「某某的助手」、自己的「我的助手」、个人画布只说「助手」', () => {
    expect(agentHolderLabel({ name: '张三' })).toBe('张三的助手')
    expect(agentHolderLabel({ name: '张三' }, { mine: true })).toBe('我的助手')
    expect(agentHolderLabel({ name: '张三' }, { showOwner: false, mine: true })).toBe('助手')
    expect(agentHolderLabel({ name: '' })).toBe('匿名用户的助手')
  })

  it('withMine：按 owner.id 和自己的 user id 比', () => {
    const runs = [run(), run({ runId: 'run_2', owner: { id: 'u2', name: '乙', avatarUrl: null } })]
    expect(withMine(runs, 'u2').map((entry) => [entry.runId, entry.mine])).toEqual([
      ['run_1', false],
      ['run_2', true],
    ])
  })

  it('接回与中止的路径都挂在那一轮下面，id 做 URL 编码', () => {
    expect(agentRunEventsPath('f 1', 'run/1')).toBe('/api/flows/f%201/agent/runs/run%2F1/events')
    expect(agentRunAbortPath('f1', 'run_1')).toBe('/api/flows/f1/agent/runs/run_1/abort')
  })
})

describe('技能 id', () => {
  it('canonicalSkillIds：合并掉的 canvas-edit 换成 canvas，换完去重、保持首次出现的先后；别的 id 原样', () => {
    expect(canonicalSkillIds(['canvas', 'canvas-edit', 'director'])).toEqual(['canvas', 'director'])
    expect(canonicalSkillIds(['canvas-edit', 'notes', 'canvas'])).toEqual(['canvas', 'notes'])
    expect(canonicalSkillIds(['media-view', 'gone'])).toEqual(['media-view', 'gone'])
    expect(canonicalSkillIds([])).toEqual([])
  })
})

describe('消息附件（docs/20 §3.10.12）', () => {
  const ref = (index: number) => ({ key: `canvas/assets/aa/bb/${index}.png`, name: `图${index}.png` })

  it('不给 / null = 没有附件；合法的原样收下，显示名去掉首尾空白', () => {
    expect(parseAgentAttachmentRefs(undefined)).toEqual({ ok: true, attachments: [] })
    expect(parseAgentAttachmentRefs(null)).toEqual({ ok: true, attachments: [] })
    expect(parseAgentAttachmentRefs([{ key: 'k1', name: '  猫.png ' }])).toEqual({
      ok: true,
      attachments: [{ key: 'k1', name: '猫.png' }],
    })
  })

  it('数量超过上限 → 拒', () => {
    const many = Array.from({ length: AGENT_ATTACHMENT_MAX_COUNT + 1 }, (_, index) => ref(index))
    expect(parseAgentAttachmentRefs(many.slice(0, AGENT_ATTACHMENT_MAX_COUNT)).ok).toBe(true)
    expect(parseAgentAttachmentRefs(many)).toEqual({ ok: false, error: `附件最多 ${AGENT_ATTACHMENT_MAX_COUNT} 个` })
  })

  it('字段类型 / 长度 / 控制字符不对、键重复 → 拒', () => {
    const bad: unknown[] = [
      'k1',
      { key: 'k1' },
      [{ key: 1, name: 'a' }],
      [{ key: '', name: 'a' }],
      [{ key: 'k'.repeat(513), name: 'a' }],
      [{ key: 'k\n1', name: 'a' }],
      [{ key: 'k1', name: 1 }],
      [{ key: 'k1', name: '   ' }],
      [{ key: 'k1', name: 'a'.repeat(AGENT_ATTACHMENT_NAME_MAX_LENGTH + 1) }],
      [{ key: 'k1', name: 'a\u0000b' }],
      [ref(1), ref(1)],
      [null],
    ]
    for (const value of bad) expect(parseAgentAttachmentRefs(value).ok, JSON.stringify(value)).toBe(false)
  })

  it('按类型决定怎么显示：图片 / 视频有预览，其余是文件', () => {
    expect(agentAttachmentKind('image/png')).toBe('image')
    expect(agentAttachmentKind('video/mp4')).toBe('video')
    expect(agentAttachmentKind('application/pdf')).toBe('file')
    expect(agentAttachmentKind('')).toBe('file')
  })
})
