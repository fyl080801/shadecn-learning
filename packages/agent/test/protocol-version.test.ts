import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RUNNER_PROTOCOL_VERSION } from '../src/protocol.ts'

/**
 * 防「改了线协议忘了加版本号」：对 `protocol.ts` 去掉注释和空白之后的内容算哈希，和下面记录的「版本号 → 哈希」比对。
 *
 * 取舍：
 * - **去掉注释和空白再算**：纯注释 / 排版改动不该逼人改版本号（否则大家会习惯性地乱加，版本号就失去意义）；
 *   类型、常量、解析器的校验规则都在哈希里，改了就会触发。
 * - **只覆盖 `protocol.ts` 这一个文件**：线协议的形状（路由、请求体、RunnerEvent、令牌声明、校验）都定义在这里。
 *   它 import 进来的类型（`CanvasToolDetails`、pi 的 `AgentEvent`）改了形状不会触发 ——
 *   那类改动要自己想到加版本号；这个测试兜的是最常见的那一类（直接改协议文件）。
 * - 去注释用正则而不是 TS 编译器的 printer：不随 TypeScript 版本升级而抖动。字符串字面量原样保留（里面的 `//` 不被当注释）。
 */

/** 版本号 → 那个版本的 protocol.ts 哈希。只增不改：旧版本的行留着当历史 */
const RECORDED_HASHES: Record<number, string> = {
  1: '0d3852a34b787bb2',
  2: '9da56f1cae995d91',
  3: 'fed5ea20f44fd633',
  4: '3ba28efff9089c79',
  5: '071f1a2e62c43f0c',
  6: 'bda69b3a658dc0d8',
  7: 'd5108c293ff344ee',
}

function normalized(source: string): string {
  const stripped = source.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_match, literal: string | undefined) => literal ?? ' ',
  )
  return stripped.replace(/\s+/g, ' ').trim()
}

export function protocolHash(source: string): string {
  return createHash('sha256').update(normalized(source)).digest('hex').slice(0, 16)
}

const current = protocolHash(readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8'))

describe('runner ↔ 网关协议版本', () => {
  it('protocol.ts 的内容和记录的哈希对得上；对不上 = 改了协议却没升 RUNNER_PROTOCOL_VERSION', () => {
    const recorded = RECORDED_HASHES[RUNNER_PROTOCOL_VERSION]
    const how =
      `改了 runner↔网关协议（protocol.ts）就把 RUNNER_PROTOCOL_VERSION 加一并更新这里的哈希：\n` +
      `  当前版本 ${RUNNER_PROTOCOL_VERSION}，protocol.ts 的哈希是 ${current}，` +
      (recorded ? `记录的是 ${recorded}。` : '这里还没有这个版本的记录。') +
      `\n  - 真改了协议：RUNNER_PROTOCOL_VERSION 加一，并在 RECORDED_HASHES 里加一行 ${RUNNER_PROTOCOL_VERSION + (recorded ? 1 : 0)}: '${current}'；` +
      `\n  - 只是纯注释 / 排版改动：不会走到这里（注释和空白不参与哈希）。`
    expect(recorded === current, how).toBe(true)
  })

  it('版本号是正整数，记录里没有比当前还新的版本', () => {
    expect(Number.isInteger(RUNNER_PROTOCOL_VERSION) && RUNNER_PROTOCOL_VERSION >= 1).toBe(true)
    for (const version of Object.keys(RECORDED_HASHES).map(Number)) {
      expect(version, `RECORDED_HASHES 里有 ${version}，但 RUNNER_PROTOCOL_VERSION 才是 ${RUNNER_PROTOCOL_VERSION}`).toBeLessThanOrEqual(RUNNER_PROTOCOL_VERSION)
    }
  })

  it('纯注释和空白的改动不改变哈希；改一个常量会', () => {
    const base = "export const A = 'x // not a comment' // trailing\n/** doc */\nexport const B = 1"
    expect(protocolHash(`${base}\n\n// 新增注释\n`)).toBe(protocolHash(base.replace('/** doc */', '/** 另一句说明 */')))
    expect(protocolHash(base.replace('= 1', '=   1'))).toBe(protocolHash(base))
    expect(protocolHash(base.replace('= 1', '= 2'))).not.toBe(protocolHash(base))
    expect(protocolHash(base.replace('not a comment', 'changed'))).not.toBe(protocolHash(base))
  })
})
