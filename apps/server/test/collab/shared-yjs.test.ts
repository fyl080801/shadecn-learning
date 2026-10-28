import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { nodeData, nodesMap, readNodes, toYNode } from '@shadecn/shared/flow-doc'
import { defaultNodeData } from '@shadecn/shared/flow-graph'

/**
 * `@shadecn/shared` 里的 Y.Doc 读写和后端自己 import 的必须是**同一份 yjs**。
 *
 * shared 通篇靠 `instanceof Y.Map` 判断结构；两份副本之间的 `instanceof` 永远为 false，
 * 画布会静默读成一张空图、落库的投影也跟着空掉。shared 把 yjs 声明成 peerDependency
 * 就是为了这个 —— 这里把它钉住。
 */

const serverDir = path.resolve(import.meta.dirname, '../..')
const sharedDir = path.resolve(serverDir, '../../packages/shared')

function yjsEntryFrom(dir: string) {
  return realpathSync(createRequire(path.join(dir, 'package.json')).resolve('yjs'))
}

describe('shared 与后端共用一份 yjs', () => {
  it('从 apps/server 和 packages/shared 解析到的 yjs 是同一个文件', () => {
    expect(yjsEntryFrom(sharedDir)).toBe(yjsEntryFrom(serverDir))
  })

  it('shared 造的 Y.Map 是后端这份 yjs 的实例，反过来也读得出来', () => {
    const made = toYNode({
      id: 'n1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: defaultNodeData('节点'),
    })
    expect(made).toBeInstanceOf(Y.Map)

    // 后端这份 yjs 建的文档，交给 shared 读
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', made)
    expect(nodeData(doc, 'n1')).toBeInstanceOf(Y.Map)
    expect(readNodes(doc).map((node) => node.id)).toEqual(['n1'])
  })
})
