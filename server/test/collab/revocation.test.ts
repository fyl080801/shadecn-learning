import { describe, expect, it } from 'vitest'
import { announceRevocation, createRevocationWatcher } from '../../collab/revocation.ts'

/**
 * 权限撤销的跨实例广播。
 *
 * 要解决的问题：被移出项目的人，他的 WebSocket 很可能挂在**另一个实例**上，
 * 那个进程对这次 HTTP 请求一无所知。定期复验终究会发现，但那段时间里他改的东西
 * 会被 CRDT 合并、落库，而且其他人撤销不回来 —— 所以窗口要从「一轮轮询」
 * 压到「一次巡检」。
 *
 * 一个 watcher = 一个实例。同进程造两个就能测跨实例那条路，不用真起两个服务。
 */
describe('权限撤销广播', () => {
  it('第一次问只记不报 —— 进程刚起来时键里本来就可能留着上一次的 token', async () => {
    await announceRevocation()

    const fresh = createRevocationWatcher()
    expect(await fresh.changed()).toBe(false)
  })

  it('没人改过权限就一直答「没变」—— 平时这个定时器什么都不该做', async () => {
    const watcher = createRevocationWatcher()
    await watcher.changed()

    expect(await watcher.changed()).toBe(false)
    expect(await watcher.changed()).toBe(false)
  })

  it('别的实例宣告之后 → 变了，这就是跨实例踢线的触发点', async () => {
    const other = createRevocationWatcher()
    await other.changed() // 先对齐

    await announceRevocation()

    expect(await other.changed()).toBe(true)
  })

  it('报过一次就不再重复报 —— 否则每 3 秒都要白扫一轮', async () => {
    const watcher = createRevocationWatcher()
    await watcher.changed()

    await announceRevocation()
    expect(await watcher.changed()).toBe(true)
    expect(await watcher.changed()).toBe(false)
  })

  it('多个实例各自都会收到同一次宣告', async () => {
    const a = createRevocationWatcher()
    const b = createRevocationWatcher()
    await a.changed()
    await b.changed()

    await announceRevocation()

    expect(await a.changed()).toBe(true)
    expect(await b.changed()).toBe(true)
  })

  it('连续两次宣告之间没来得及查 → 只报一次，不会漏（下一轮复验是全量的）', async () => {
    const watcher = createRevocationWatcher()
    await watcher.changed()

    await announceRevocation()
    await announceRevocation()

    expect(await watcher.changed()).toBe(true)
    expect(await watcher.changed()).toBe(false)
  })
})
