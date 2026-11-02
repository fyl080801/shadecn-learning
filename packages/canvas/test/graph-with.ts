import { emptyGraph, type FlowGraph } from '@learning/contracts/flow-graph'

/** 造一张有 n 个节点、n-1 条边的图 */
export function graphWith(nodeCount: number): FlowGraph {
  const graph = emptyGraph()
  for (let i = 0; i < nodeCount; i += 1) {
    graph.nodes.push({
      id: `n${i}`,
      type: 'process',
      layout: { position: { x: i * 100, y: 0 } },
      metadata: { label: `节点 ${i}` },
      data: {},
      runtime: { status: 'idle' },
    })
    if (i > 0) graph.edges.push({ id: `e${i}`, source: `n${i - 1}`, target: `n${i}`, data: {} })
  }
  return graph
}
