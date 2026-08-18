# 协同方案案例研究：竞品与横向对比

> 本文不是需求，是调研记录。它回答的是「别人的画布协同怎么做的、踩了什么坑、我们的选择对不对」，
> 用来给 [REQ-COLLAB](04-realtime-collab.md) 和 [REQ-CANVAS](13-flow-canvas-management.md) 的设计决策提供外部依据。
>
> 调研日期：2026-08-18

## 1. 目标与背景

本项目的画布协同（Yjs CRDT + awareness、不加锁、悬空边交给 GC）是一组**主动选择**，
其中「元素占用实现了但不启用」这条尤其反直觉——文档里写着理由，但缺少外部佐证。

本文考察两个外部实现：

| 对象 | 性质 | 协同方案 |
|---|---|---|
| **libtv**（liblib.tv 画布） | 竞品，AI 工作流画布 | WebSocket 实时协同 + 节点独占锁 |
| **灵境**（`ai-creater/client`，studio-flow） | 内部项目，AI 创作画布 | 无实时协同，HTTP 全量快照覆盖 |

结论先行：**libtv 的核心 bug 出在数据建模，不在锁策略；灵境的建模基本对，但有一条回写链会让未来的协同无解。**
两者都反向印证了本项目「用建模消除冲突，而不是用锁串行化冲突」的取向。

---

## 2. libtv：一个可复现的协同缺陷

### 2.1 抓包情况

连接是 `wss://im.liblib.tv/ws/collaboration?token=…&project_id=…`，走 istio-envoy，握手 101 正常。

**Firefox 导出的 HAR 不含 WebSocket 帧**（Chrome 同样不含），只有握手记录。
要拿帧数据必须在页面注入 `WebSocket` 包装器，且 payload 是二进制、必须 base64 存。
本次未取到帧，以下结论来自行为观察。

### 2.2 复现的异常

> A 用户选中某节点 → B 用户删除连到该节点的连线 → B 看到连线消失 →
> 某时刻连线自己恢复 → **A 全程都能看到这条连线**。

关键观察：**节点被他人选中时，删除连线不发任何 ws 包；节点未被选中时，正常发删除包。**

### 2.3 结论

- 独占锁是**纯客户端实现**——一个包都没出去，服务端根本不知道有人试图删
- 失败是**静默丢弃**：不发包、不提示、本地乐观 UI 也不回滚
- 「连线被恢复」不是别人的 update，是本地视图被后续的全量同步覆盖
- 对端全程可见该连线，佐证了删除从未传播出去

### 2.4 术语归类

| 维度 | libtv 的选择 | 术语 |
|---|---|---|
| 锁的凭证 | 别人选中 = 加锁 | 软锁 / 在场锁（presence-based locking） |
| 锁的粒度 | 节点级，且级联到关联边 | 对象级锁 + 锁传播 |
| 执行点 | 纯客户端自检 | client-side enforcement（不可信、可绕过） |
| 拒绝方式 | 什么都不发，也不提示 | **静默写抑制（silent write suppression）** |
| 本地视图 | 乐观 UI，且不回滚 | optimistic UI without rollback |

前两行是产品设计选择（Figma 早期、Miro 都用过「选中即锁」），本身不算错。**真正的 bug 是后三行。**

一句话概括：它不是丢失了别人的更新（lost update），而是**静默丢弃了用户自己的写入**，
然后让本地视图带着这个谎言运行，直到下一次全量同步把真相盖回来。

### 2.5 根因在建模层，不在策略层

边被建模进了节点 data（ComfyUI 血统的 `inputs: { image: ["3", 0] }`），
所以在数据层面「删一条边」根本不存在，它是「写节点」：

```
用户意图：删边
数据操作：写 node.data.inputs.image = null
锁检查：  node 被别人选中 → 拒绝写 node
结果：    删边被丢弃
```

**锁级联到边不是策略选择，是建模的必然结果。**
只要边住在节点里，任何节点级并发控制都必然吞掉边的变更。

这个建模还解释了为什么它一开始就需要锁：节点是个大 JSON blob，两人同时改必然互相覆盖（LWW），
只能靠锁串行化。**锁是坏建模的补丁，不是并发控制的起点。**

ComfyUI 原生格式把「槽的字面量」和「槽的连接」塞进同一个字段，这个 union 才是万恶之源。
分开存，问题自己消失。

---

## 3. 灵境：建模对了，但有一条回写链

代码位置：`ai-creater/client/src/components/studio-flow/`（外部仓库，行号为调研当时）。

### 3.1 节点与边的关系：核心做对了

边是独立实体，不住在节点里——`types/edges.ts:61` 就是 Vue Flow 原生的 `Edge<StudioEdgeData>`，
节点里没有任何字段存「我连着谁」。

**节点的输入是从边派生出来的**（`composables/studio-flow/inputNodes.ts`）：

- `buildEdgeTargetIndex`（:133）建 `target → edges[]` 索引，
  把复杂度从 `O(config节点 × 边 × 节点)` 降到对 edges 的一次遍历
- `getConfigInputPairs` / `buildConfigNodeInputs` 在读侧算出这个 config 节点有哪些图/视频/音频输入
- **连接自身的属性放在边上**：`sortIndex`（排序权重）、`frameRole`（首尾帧）、`edgeKind`

`edges.ts:50-55` 的 `sortIndex` 步长 1024 预留插入空间，是 fractional indexing 的雏形，天生对并发友好。

### 3.2 但派生结果被物化回了节点

算完之后又写回去了。删边时做三件事（`StudioCanvas.vue:5706-5730` 一带）：

```
删一条边  →  ① 删除 edge
          →  ② 重算并写回 targetNode.data.inputs（派生值被持久化）
          →  ③ 改写 targetNode.data.media.task.params.prompt 里的 {{Ref N}}
```

第 ③ 步是致命的。提示词用**位置序号**引用素材（`{{Ref 1}}`、`{{Ref 2}}`），
删掉第 1 条边，后面所有引用都得往前挪一位（`removeRefTag` / `remapRefTags`）。

单人下没问题，一个事务里做完。但它意味着**「删边」在数据层是对三个不同实体的扇出写**。
一旦多人协同：

> 甲删边 1（Ref2→Ref1、Ref3→Ref2），乙同时删边 3（删掉 Ref3）。
> 两人各自基于自己看到的顺序重排，合并后 prompt 序号必然错乱。

**没有任何 CRDT 能救这个。** 冲突在语义层不在存储层——Yjs 能合并「两人改了同一段文本」，
但合并不了「两人对同一组序号做了不同的全局重排」。
这比 libtv 那个 bug 更难修：libtv 只是建模错了，这里是**编码方式**本身对并发不友好。

### 3.3 协同实现：目前没有

全仓 grep 无 `yjs` / `hocuspocus` / `y-websocket` / `awareness` / CRDT，
studio-flow 目录里一个 WebSocket 都没有。实际链路：

```
patchNodeData → requestPersist → useDebounceFn 300ms → toObject() 全量导出 → POST /joycreator/canvas/save
```

| 项 | 现状 |
|---|---|
| 同步方式 | 无实时通道，HTTP 全量快照覆盖 |
| 快照粒度 | `FlowExportObject`（整图 nodes + edges + viewport） |
| 并发控制 | **无** |
| `version` 字段 | 存在，但只跟随服务端返回值更新，**没有冲突分支** |
| 多人场景 | 只读分享（`currentCanvas.readOnly`） |

定位是**单人编辑 + 只读分享**。乐观锁的字段备好了但没接冲突处理——
两个有编辑权的人同时开着同一张画布，后保存的那份会静默盖掉前一个人的全部工作。
这是**整图粒度的 last-write-wins**，比 libtv 的节点粒度还粗。

---

## 4. 对本项目的印证

三条设计决策拿到了外部佐证。

### 4.1 「不启用元素占用」是对的

`src/lib/presence.ts` 的占用仲裁写了、测了、没接进画布，
理由记在 [REQ-COLLAB §4.0.1](04-realtime-collab.md)。libtv 正好演示了接进去会发生什么。

真正要守的不是「要不要锁」，而是：**一旦拒绝写入，绝不能静默。**
必须在应用前拒绝 + 明确 NACK + 本地回滚 + UI 提示，
而且提示要在**动作发生之前**（删除键置灰、边上挂锁标），不是事后偷偷回滚。

本项目的配额拒绝已经是这个形状：`beforeHandleMessage` 只能在应用前拒绝（
已广播的 Yjs update 收不回来），且不抛异常而是把连接翻成 `readOnly`——
抛异常会让 Hocuspocus 关连接、重连的 provider 永远重发同一条消息。

### 4.2 「边是顶层实体」不是风格问题

`src/lib/flow-doc.ts` 把 `nodes` / `edges` 放成两个平级的顶层 `Y.Map`，
边不住在任何节点里。所以本项目的「删边」就是 `edgeMap.delete(id)`
（`src/stores/flow/index.ts:311`），**一个字节都不碰节点**。

甲改节点标题、乙删这条边，落在 Y.Doc 里是完全不相交的 key，CRDT 直接合并，
没有冲突需要仲裁。**libtv 那个 bug 在这个结构下不可能复现。**

### 4.3 「悬空边交给 GC」比加锁便宜

甲删节点、乙同时往它连线，CRDT 会诚实地合并出一条悬空边——这是正常产物，不是要预防的错误。
本项目是双层防御：投影层过滤不渲染（`src/stores/flow/index.ts:133`）+
服务端 `pruneDanglingEdges` 真正删除，并挂 `'gc'` origin 让清理不进任何人的撤销栈
（`server/collab/flow-doc.ts:285`）。

用锁去预防这件事，代价是冻结整片画布，收益是省掉一次 GC，不划算。

---

## 5. 本项目自身的潜在同类问题

调研过程中发现一处**尚未发作、但同源**的隐患。

`src/lib/flow-doc.ts:63-64` 把 `config` 和 `ports` 当整块 JSON 塞进 Y.Map：

```ts
data.set("config", node.data.config)
data.set("ports", node.data.ports)
```

现在没问题，因为 config 目前是整体编辑的。
但**如果哪天把「端口的字面量取值」放进 `config[slotId]`，这里就会变成 libtv 那个 bug 的小号版**——
甲改 `config.seed`、乙改 `config.steps`，两人写的是同一个 key `config`，
后到的整块覆盖先到的，乙的修改静默消失。

修法和 `data` 这层当初的做法一样，再套一层 Y.Map：

```ts
const config = new Y.Map<unknown>()
for (const [k, v] of Object.entries(node.data.config)) config.set(k, v)
data.set("config", config)
```

读侧不用改——`fromYNode` 的 `rawData.toJSON()` 已经是递归的。
服务端 `server/collab/flow-doc.ts` 那份镜像要同步改。

`ports` 同理：只要端口会被动态增删（可变参数节点）就得拆；
如果永远由 `kind` 静态决定，留作 blob 反而更省事。

---

## 6. 通用结论

给任何画布类协同的建模规则，按重要性排序：

1. **边是关系，关系不属于任何一个端点。** 边必须是顶层实体。
2. **派生值不落库。** 「这个节点有哪些输入」应当读时算，不能物化回节点——
   物化就等于把一次写变成扇出写，并发下必然打架。
3. **引用要用稳定标识，不要用位置序号。** `{{Ref 1}}` 这种全局重排型编码，
   CRDT 也救不了；换成指向 edgeId 的稳定引用，删除就不再触发重排。
4. **排序用 fractional index**（字符串 key，任意两个之间永远能插入），
   不要用整数步长——多人并发插入会撞。
5. **CRDT 合并的是存储层冲突，不是语义层冲突。** 上协同框架之前先把 2、3、4 做完，
   否则上什么都白搭。
6. **任何拒绝都不能静默。** 应用前拒绝 + 明确 NACK + 本地回滚 + 事前的 UI 提示。

其中 1、6 是本项目已经做到的；2、3、4 本项目目前不涉及（画布没有引用序号这类语义）；
5 是选型顺序的忠告。

---

## 7. 待确认事项

- libtv 的完整 ws 帧未取到，「连线恢复」那一刻究竟是全量快照还是增量 update，仍是推断。
  要坐实需用注入脚本抓帧（见 §2.1）。
- 本项目 `config` 拆成嵌套 Y.Map 的改动尚未做，目前只是隐患不是缺陷（见 §5）。
  做的时候要连带补一个「并发编辑不同 slot」的测试。
