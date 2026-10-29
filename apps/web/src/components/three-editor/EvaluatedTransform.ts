import * as THREE from "three"

// ————————————————————————————————————————————————————————————————
// 求值层：authored（作者写的）与 evaluated（求值算出来的）分开
//
// 住在**引擎层**：它讲的是「three 的节点上，作者写的那一份与求值算出来的那一份怎么共存」，
// 与导演台/完整编辑器哪一个在用无关。两个消费方共用同一份实现与同一套纪律——引擎自己的
// 变换命令（SetPosition/SetRotation）与项目序列化（Editor.toJSON）也走它。
//
// 对齐 Blender 的 depsgraph 那套分层：一个对象的变换有两份含义完全不同的值——
//
//   · **authored**——用户在面板里填的、gizmo 拖出来的、关键帧插出来的那一份。它是**数据**：
//     序列化存它、撤销回退它、面板回读它。
//   · **evaluated**——把约束/驱动叠加上去之后、真正拿去渲染的那一份。它是**每次求值算出来的
//     结果**：轨迹的切线朝向、动作的内部位移、双脚贴地的竖向补偿都属于这一类。
//
// Blender 里这两份住在不同的数据结构上（`object.location` vs `matrix_world`），互不覆盖；
// three.js 没有这一层，节点上就一份 position/quaternion，谁写谁算数。于是本域此前是**每个
// 派生功能各自造一遍轮子**：先把「我动手之前它是多少」抄一份存进 userData（motionTangentBase /
// carrierBase / footSnapBaseY 各一份），每次求值都从那份基准重算，撤掉时再写回去。
// （那三份都已随各自的功能撤掉，留在这儿只为说明当初为什么要有统一记账。）
//
// 三份拷贝带来的实际代价（都真出过事，故收成这一处）：
//   ①**序列化会把派生量存进去**——基准存在 userData 里，而 userData 进 `object.toJSON()`；
//     派生量存下来，重开导演台就在它之上再叠一遍，每存一次歪一点。此前只有切线朝向单独做了
//     `suspendMotionTangent`，别的派生量漏在外面。现在 `suspendEvaluated` 一次覆盖全部。
//   ②**同一个通道多方争用**——两方各写各的基准，谁后写谁说了算（脚底吸附与动作位移曾靠
//     「恰好落在不相交的轴上」才相安无事，纯属巧合）。
//   ③ 每加一个派生量都要重新想一遍这两件事。
//
// 合成规则（与约束栈同构）。每份分量有两种口吻，对应约束的两种常见语义：
//   · **offset（叠加）**——「在作者写的那一份之上再动一点」。动作的内部位移、切线朝向都是。
//   · **override（顶替）**——「这一段由我说了算」。轨迹在片段区间内即是：对象贴着那条线走，
//     与它原本被摆在哪儿无关。
//   position   = (override ?? authored) + Σ offset
//   quaternion = (Π offset) · (override ?? authored)     ← 左乘：在**父层空间**里再转一次
// 同一通道上多方 override 时后写者胜（今天不存在这种情形，真出现了也该在上游避免）。
//
// 三条纪律：
//   · **按通道分别记账**：只有真被写过的通道才有 authored 快照，也只有它会被重算。骨骼的
//     quaternion 归姿势管、position 归贴地管，两者互不打扰，正是靠这一条。
//   · **authored 快照只抄一次**（首次贡献之前那一刻的值）。每次都重抄的话，第二次求值就把
//     上一轮的结果并进了 authored，位移/角度会一路累加出去。
//   · **不进 userData**——记在模块级 WeakMap 上，故 `object.toJSON()` 天然带不走它（同
//     SkeletonBindPose 对绑定姿态的处理，理由完全一样）。
// ————————————————————————————————————————————————————————————————

/** 可被派生变换驱动的通道。缩放暂无派生来源，等真有了再加。 */
export type EvaluatedChannel = "position" | "quaternion"

/**
 * 派生变换的来源标识——同一节点同一通道上，每个来源各占一份分量。
 *
 * 引擎层不认识具体有哪些来源（那是各消费方的域知识），故这里只约束成字符串；名字由各域
 * 自己定，**同一域内必须用同一个常量**——写入用 'footSnap'、撤销时写成 'footsnap' 的话，
 * 撤不掉的那一份会永久留在节点上。director 侧的取值见 `director/index.ts` 的再导出。
 */
export type EvaluatedSource = string

/** 分量的口吻：叠在 authored 之上，还是顶替掉它。 */
export type EvaluatedMode = "offset" | "override"

interface Contribution {
  value: number[]
  mode: EvaluatedMode
  /**
   * 本方 override 期间，别人直接改节点算不算**作者的意思**（缺省 false）。
   *
   * 两种 override 对这一问的答案相反，故必须由声明方说清楚：
   *   · **轨迹**（绝对）——不算。那几秒的取值整个由路径给出，拖动要折进路径本身
   *     （见 director 的 absorb），authored 一动都不该动，否则拖一下既弯了路径又挪了站位。
   *   · **动作的位移**（相对）——算。它答的是「从这儿再走多少」，用户拖动就是在说
   *     「从**这儿**开始走」，那个「这儿」正是 authored。
   */
  claim?: boolean
}

interface ChannelRecord {
  /** 本方介入之前节点上的那一份值（position 为 xyz，quaternion 为 xyzw）。 */
  authored: number[]
  /** 各来源当前声明的分量，按写入顺序合成。 */
  contributions: Map<EvaluatedSource, Contribution>
  /** 上一次由本层写进节点的值——据此认出「这一次是别人改的」，见 adoptExternalEdit。 */
  lastEvaluated: number[] | null
}

type NodeRecord = Partial<Record<EvaluatedChannel, ChannelRecord>>

const evaluatedNodes = new WeakMap<object, NodeRecord>()

const _quat = new THREE.Quaternion()
const _contribution = new THREE.Quaternion()
// 认领外部改动时专用（不与合成那两个共用：adoptExternalEdit 由 recompose 在用它们之前调用，
// 今天不会撞上，但两处共用一份暂存迟早会在某次调整顺序时静默算错）。
const _adoptAuthored = new THREE.Quaternion()
const _adoptDelta = new THREE.Quaternion()
const _adoptCurrent = new THREE.Quaternion()

function readChannel(node: any, channel: EvaluatedChannel): number[] {
  return channel === "position"
    ? [node.position.x, node.position.y, node.position.z]
    : [
        node.quaternion.x,
        node.quaternion.y,
        node.quaternion.z,
        node.quaternion.w
      ]
}

function ensureRecord(node: any, channel: EvaluatedChannel): ChannelRecord {
  let record = evaluatedNodes.get(node)
  if (!record) {
    record = {}
    evaluatedNodes.set(node, record)
  }
  let channelRecord = record[channel]
  if (!channelRecord) {
    channelRecord = {
      authored: readChannel(node, channel),
      contributions: new Map(),
      lastEvaluated: null
    }
    record[channel] = channelRecord
  }
  return channelRecord
}

/**
 * 合成之前先认领「别人刚刚改的那一笔」。
 *
 * 节点上此刻的值若与**我们上一次写下去的**不一致，说明中间有人动过手——用户拖了 gizmo、
 * 属性面板提交了一条命令、关键帧把这一帧的值写了进来、撤销回退了一步。那些改动表达的都是
 * **authored**（作者的意图），故原样收作新的 authored，下一次合成在它之上叠加。
 *
 * 没有这一步的话，authored 会永远停在「第一次施加派生变换那一刻」：轨迹段里拖一下旋转
 * gizmo，下一帧就被打回去（表现为「转不动」）；旋转关键帧也会在整段轨迹里失效。
 *
 * 判据是与**自己写下去的那份**逐分量比对，不是与 authored 比，故不受浮点漂移影响；容差只
 * 用来吸收 normalize 之类的末位噪声。
 */
const EXTERNAL_EDIT_EPSILON = 1e-9

/** 这条通道此刻被人 override 着，且那些 override 都不认领外部改动（见 Contribution.claim）。 */
function overrideBlocksClaim(record: ChannelRecord): boolean {
  let overridden = false
  for (const contribution of record.contributions.values()) {
    if (contribution.mode !== "override") continue
    if (contribution.claim === true) return false
    overridden = true
  }
  return overridden
}

function adoptExternalEdit(
  node: any,
  channel: EvaluatedChannel,
  record: ChannelRecord
): void {
  if (!record.lastEvaluated) return
  if (overrideBlocksClaim(record)) return
  const current = readChannel(node, channel)
  const changed = current.some(
    (value, index) =>
      Math.abs(value - (record.lastEvaluated![index] ?? 0)) >
      EXTERNAL_EDIT_EPSILON
  )
  if (!changed) return

  // 认领之后把基线推到当前值，使这一步**幂等**：readAuthored 与 recompose 各会调一次，而
  // 「收位移」不像「收绝对值」那样重复执行无害——两次就把同一段位移加了两遍（实测 6 变 12）。
  // recompose 随后会把它改写成真正写下去的那一份，故这里只影响同一轮内的重复调用。
  const previous = record.lastEvaluated
  record.lastEvaluated = current

  if (channel === "position") {
    // **收的是位移，不是绝对值**：节点上此刻是 `authored + Σ分量`（或 override 的产物），
    // 把整份原样收进 authored 会把分量一起收进去，下一次合成再叠一遍。
    //   · offset：authored=1、分量=2 → 节点 3；用户拖到 8（+5），absolute 会记下 8，
    //     下一次合成给出 10——用户要的是 8。
    //   · override：动作的位移里更直接，authored 会被记成 base+已走出去的那一段，
    //     每拖一次远一截（用户报的「再播放位置又跑了」）。
    // 收位移则两种都对：authored += 用户实际挪的那一段。
    record.authored = record.authored.map(
      (value, index) => value + (current[index] ?? 0) - (previous[index] ?? 0)
    )
    return
  }
  // quaternion **同样收增量**，只是这条通道的合成是左乘（`(Π offset) · authored`）。
  // 按绝对值收的话，那些 offset 会连同用户的意图一起被收进 authored，下一次合成再左乘一遍
  // ——用户把 gizmo 拖到哪儿，对象就比那儿**多转一个 offset**，且每认领一次多转一次。
  // 实际现象：开着朝向对齐切线的角色（motionTangent 在同一节点同一通道上有一份 offset），
  // 拖一下旋转 gizmo，人当场多转过一整个切线角；mouseUp 那一路走 readAuthored → 认领 →
  // SetRotationCommand 写回，写进去的也是这份多转过的值，故撤销也回不去。
  //
  // 写成 `authored' = authored · (lastEvaluated⁻¹ · node')`：与 `(Π offset)⁻¹ · node'` 同解
  // （代入 lastEvaluated = Π offset · authored 即得），但只用到**我们自己写下去的那一份**，
  // 不必在这里按与 recompose 一致的顺序把各方 offset 再乘一遍——那种「两处必须同序」的
  // 约定迟早会在某次改动里被打破，而算错的结果是静默多转一点。
  // 没有任何 offset 时 Π offset 为单位四元数，本式退化成 `authored' = node'`，即与此前
  // 的绝对值写法逐位相同，故这一改只作用在真有 offset 的那条路上。
  _adoptAuthored.fromArray(record.authored)
  _adoptDelta
    .fromArray(previous)
    .invert()
    .multiply(_adoptCurrent.fromArray(current))
  record.authored = _adoptAuthored.multiply(_adoptDelta).toArray()
}

/** 把某个通道重新合成并写回节点。没有任何分量时即还原 authored。 */
function recompose(
  node: any,
  channel: EvaluatedChannel,
  record: ChannelRecord
): void {
  adoptExternalEdit(node, channel, record)

  // 先挑出 override（有的话它顶替 authored 当基底），offset 再叠在基底之上。
  let base = record.authored
  for (const contribution of record.contributions.values()) {
    if (contribution.mode === "override") base = contribution.value
  }

  if (channel === "position") {
    let x = base[0] ?? 0
    let y = base[1] ?? 0
    let z = base[2] ?? 0
    for (const contribution of record.contributions.values()) {
      if (contribution.mode !== "offset") continue
      x += contribution.value[0] ?? 0
      y += contribution.value[1] ?? 0
      z += contribution.value[2] ?? 0
    }
    node.position.set(x, y, z)
    record.lastEvaluated = [x, y, z]
    return
  }

  _quat.identity()
  for (const contribution of record.contributions.values()) {
    if (contribution.mode !== "offset") continue
    _contribution.fromArray(contribution.value)
    _quat.multiply(_contribution)
  }
  node.quaternion.copy(_quat).multiply(_contribution.fromArray(base))
  record.lastEvaluated = node.quaternion.toArray()
}

/**
 * 声明本方在某个节点某个通道上的派生分量，并立即把合成结果写回节点。
 *
 * `value` 为 position 时是坐标/位移（xyz），为 quaternion 时是旋转（xyzw）；`mode` 决定它是
 * 叠在 authored 之上（offset，缺省）还是顶替掉它（override）。
 * 传 null 即撤掉本方的分量（= 本方此刻不作用），这正是各方的复位路径。
 */
export interface EvaluatedOptions {
  /** 见 Contribution.claim。 */
  claim?: boolean
}

export function setEvaluated(
  node: any,
  source: EvaluatedSource,
  channel: EvaluatedChannel,
  value: number[] | null,
  mode: EvaluatedMode = "offset",
  options: EvaluatedOptions = {}
): void {
  if (!node) return

  if (value === null) {
    const record = evaluatedNodes.get(node)?.[channel]
    if (!record || !record.contributions.has(source)) return
    record.contributions.delete(source)
    recompose(node, channel, record)
    return
  }

  const record = ensureRecord(node, channel)
  record.contributions.set(source, {
    value: [...value],
    mode,
    claim: options.claim === true
  })
  recompose(node, channel, record)
}

/**
 * 先把某个通道的 authored 快照抄下来，但不贡献任何分量。
 *
 * 给「动手之前要先改一下这个节点、而那次改动不属于 authored」的调用方用——典型是切线朝向
 * 落地前把承载层的 `rotation.order` 换成 'YXZ'：three 里改 order 会**用新轴序从当前欧拉重算
 * 四元数**，不先抄一份的话，那次重算的结果就被当成 authored 记下去了。
 */
export function captureAuthored(node: any, channel: EvaluatedChannel): void {
  if (node) ensureRecord(node, channel)
}

/** 本方当前声明的分量（没声明过即 null）。 */
export function getEvaluated(
  node: any,
  source: EvaluatedSource,
  channel: EvaluatedChannel
): number[] | null {
  const contribution = evaluatedNodes
    .get(node)
    ?.[channel]?.contributions.get(source)
  return contribution ? [...contribution.value] : null
}

/**
 * **显式**改写 authored，并立即重算 evaluated。
 *
 * 给「我很清楚自己写的是 authored」的调用方用——典型是时间轴把旋转关键帧这一帧的值落到
 * 对象上。`adoptExternalEdit` 那条启发式（节点上的值与我们写下去的不一致即认作 authored）
 * 兜的是 gizmo 拖拽、属性面板命令、撤销这些**从外部**改节点的路径，但它有一处天然的盲区：
 * 写进去的值恰好等于当前 evaluated 时看不出「有人写过」。关键帧每帧都写、且写的就是
 * authored，故这条路径不该赌那个概率，直接走这个入口。
 *
 * 没有记录（该通道没有任何派生分量）时就是一次普通写入。
 */
export function writeAuthored(
  node: any,
  channel: EvaluatedChannel,
  value: number[]
): void {
  if (!node) return
  const record = evaluatedNodes.get(node)?.[channel]
  if (!record) {
    if (channel === "position") node.position.fromArray(value)
    else node.quaternion.fromArray(value)
    return
  }
  record.authored = [...value]
  // recompose 头一件事是认领外部改动，而节点此刻还停在上一轮的 evaluated 上；把 lastEvaluated
  // 清掉即声明「这一次没有外部改动」，否则刚设好的 authored 会被那条启发式覆盖回去。
  record.lastEvaluated = null
  recompose(node, channel, record)
}

/**
 * 该节点某个通道的 authored 值——面板/关键帧/撤销要的是这一份，不是渲染用的那一份。
 *
 * **读之前先认领一次外部改动**（同 recompose 的第一步）：`record.authored` 只在合成时才刷新，
 * 而一个通道**可以长时间没有任何分量**——轨迹演完之后位置就是这样，`applyMotionPlacement`
 * 撤掉分量后短路，此后再没有人调用 recompose。这段时间里用户拖 gizmo / 面板提交，节点变了，
 * authored 却停在派生量撤掉那一刻的值上，于是所有读它的人拿到的都是过期数字：
 *   · 打关键帧记下的是**拖动之前**的位置（用户报的「轨迹后面打的位置关键帧不起作用，
 *     一移动时间轴对象又回到轨迹末端」——帧里存的本来就是轨迹末端）；
 *   · 自动关键帧拿过期值与基准比，比出「没变化」，一帧也不补；
 *   · `SetPositionCommand` 记下的 old 值是过期的，撤销会把对象送到别处；
 *   · 属性面板回填的是过期读数。
 *
 * 认领本身不是新规矩：节点上的值与**我们上一次写下去的**不一致即视为作者改的（见
 * adoptExternalEdit），此前只在合成路径上做。放到读这一端只是把同一条规矩补齐——有分量时
 * 两条路径给出的答案完全一致（recompose 每次求值都会先认领一次）。
 */
export function readAuthored(node: any, channel: EvaluatedChannel): number[] {
  const record = evaluatedNodes.get(node)?.[channel]
  if (!record) return readChannel(node, channel)
  adoptExternalEdit(node, channel, record)
  return record.authored
}

/**
 * 刷新节点**自己的局部矩阵**——改完 position/quaternion 必须补的一下。
 *
 * `Object3D.toJSON()` 直接读 `this.matrix` 且不会自己重算，而 matrixAutoUpdate 那条路要等
 * 下一帧渲染循环才刷。suspendEvaluated 的两个调用方（`Editor.toJSON`、`serializeDirectorScene`）
 * 都是「还原 → 立刻 toJSON → 装回去」的**同步**流程，中间插不进一帧——不刷的话还原的是
 * position、存下去的却是上一帧那份含派生量的矩阵，等于这整套 suspend 白做。
 *
 * 同 `director/directorObjectCenter` 的 markLocalMatrixDirty，理由完全一致；那边多的
 * `matrixWorldNeedsUpdate` 分支在这里没有意义——matrixAutoUpdate 关掉时矩阵由调用方自己管，
 * 本层写 position/quaternion 本就不会生效。
 */
function refreshLocalMatrix(node: any): void {
  if (node.matrixAutoUpdate) node.updateMatrix()
}

/**
 * 把整棵子树临时还原成 authored，返回「装回去」的收尾函数——**序列化的唯一正确入口**。
 *
 * 派生量一律不进持久化数据（它们是「时刻 → 值」的纯函数，重开导演台重算即得）；存进去的话
 * 重新落地时会在它之上再叠一遍，每存一次歪一点。这里按子树一次覆盖全部派生来源，故新增派生
 * 变换时**不必**再去序列化那边补一处 suspend——那正是此前只挡住切线朝向、漏掉其余的原因。
 */
export function suspendEvaluated(root: any): () => void {
  if (!root?.traverse) return () => {}

  const touched: {
    node: any
    channel: EvaluatedChannel
    record: ChannelRecord
  }[] = []
  const touchedNodes: any[] = []
  root.traverse((node: any) => {
    const record = evaluatedNodes.get(node)
    if (!record) return
    let restored = false
    for (const channel of ["position", "quaternion"] as EvaluatedChannel[]) {
      const channelRecord = record[channel]
      if (!channelRecord || channelRecord.contributions.size === 0) continue
      touched.push({ node, channel, record: channelRecord })
      if (channel === "position") {
        node.position.fromArray(channelRecord.authored)
      } else {
        node.quaternion.fromArray(channelRecord.authored)
      }
      // 还原也是「我们写的」——不记下来的话收尾时会把它当成外部编辑收作 authored。
      channelRecord.lastEvaluated = [...channelRecord.authored]
      restored = true
    }
    // 按节点刷一次而不是按通道刷两次：局部矩阵是 position/quaternion/scale 合成出来的
    // 一份，两个通道都动过时刷第二次纯属白付。
    if (restored) {
      refreshLocalMatrix(node)
      touchedNodes.push(node)
    }
  })

  return () => {
    for (const entry of touched)
      recompose(entry.node, entry.channel, entry.record)
    // 装回去同样要刷：序列化跑在自动保存里，后面未必紧跟一帧渲染，而 matrixWorld 的重算
    // 以局部矩阵为输入——留着还原态的那一份，下一次量包围盒/求世界坐标读到的就是它。
    for (const node of touchedNodes) refreshLocalMatrix(node)
  }
}
