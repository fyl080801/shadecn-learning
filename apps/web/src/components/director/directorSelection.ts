import { computed, readonly, ref } from "vue"

// 时间轴的轨道 / 属性键。源项目从 timeline/directorTimelineData 取字面量联合类型；本仓库只迁移了
// 中心视口、没有时间轴，这几类选区（关键帧 / 片段 / 间补段 / 路径点）不会被产生，故这里放宽为
// string，只为保留选区的完整形状（删除键分派、gizmo 归属都按 kind 查表）。
type TimelineClipTrackKey = string
type TimelinePropertyKey = string

// 导演台里「现在选中的是什么」的**单点源**。
//
// 此前这件事散在九处彼此独立的状态里：引擎的 `editor.selected`、时间轴的
// selectedKeyframe/selectedClip/selectedSpan（互斥靠三个 setter 各自手写把另外两个置空）、
// 轨迹路径点与骨骼关节各自 composable 内的局部 ref（外界读不到）、gizmo 归属
// （与选中并行的第二套状态，要手工保持一致）、以及机位注视装置——它干脆没有状态，
// 于是位置模式下镜头与注视点**两个调节器同时在场**，用户读不出自己正在调哪一个。
// 代价体现在三处：加一种可选中的东西要改三个 setter；删除键的作用目标只能靠三处
// document 监听的注册顺序 + stopImmediatePropagation 分优先级；以及没有任何地方放得下多选。
//
// 现在只有这一份。三条构成规则：
//
// ① **每一项自带完整的祖先坐标**（宿主 uuid → clipId/property → index/time）。于是「组合
//    关系」是**派生量**而不是另一条要维护的链：选中一个路径点时，它属于哪一格轨迹片段、
//    哪个对象，直接从这一项上读得出来（见 directorTimeline 的 selectedClip 派生）。
//    **不要**再为上下文单开一个状态去和它对账。
//
// ② **同类可多选、跨类互斥**：`items` 里的项恒为同一 kind。多选的位置就此留好
//    （`toggleDirectorItem`/`extendDirectorSelection`），而跨类组合（一个关键帧 + 一个模型）
//    从一开始就排除在外——那样的选区回答不了「删除键删什么」「调节器调什么」。
//
// ③ **子元素选中不取消宿主对象的选中**：选区表达的是「在这个对象里，我正在调 X」。
//    `editor.selected` 仍是对象那一层的权威存储（three-editor 完整编辑器也在用它），由
//    `useDirectorSelection` 单点对账，本模块自己不碰 editor。
//
// 跨 Editor 实例存活，故导演台挂载时要 `resetDirectorSelection()`（同其余模块级状态，见
// .claude/rules/three-editor.md §3）。

/** 可被选中的东西有哪几类。新增一类：加一个成员 + 在下面的 union 里加一项，别处不必改。 */
export type DirectorSelectionKind =
  | "object"
  | "cameraTarget"
  | "pathNode"
  | "joint"
  | "keyframe"
  | "clip"
  | "span"

/** 选中了场景里的一个对象本体（缺省形态：没有更细的东西被选中时就是它）。 */
export interface DirectorObjectSelection {
  kind: "object"
  uuid: string
}

/**
 * 选中了某个机位的**注视点**——机位是「一个对象含两个可调元素」的那一类，镜头本体是
 * `object`，注视点是本项。两者互斥地出场，视口里因此永远只有一个调节器。
 */
export interface DirectorCameraTargetSelection {
  kind: "cameraTarget"
  uuid: string
}

/**
 * 选中了某格轨迹片段路径上的一个点。`index` 为 null = 选中整条路径（整体手柄）。
 *
 * `handle` 是这个点的第三层：选中的是点位本身（null / 不给），还是它某一侧的**贝塞尔调整点**。
 * 之所以不另立一个 kind：调整点没有脱离点位的身份（它属于第 index 个点），而选区的构成规则
 * ① 正是「每一项自带完整的祖先坐标」——多一个字段就把这层坐标补齐了，而多一个 kind 会让
 * gizmo 归属、删除键分派、面板反查各自都要再认一种东西。
 */
export interface DirectorPathNodeSelection {
  kind: "pathNode"
  uuid: string
  /**
   * 这个点属于**哪条轴**上的轨迹（镜头站位 `motion` / 机位注视点 `aimMotion`）。
   *
   * 同 clipId 一样是构成规则①的「祖先坐标」：一个机位身上两条轴可以各有一格轨迹，只记
   * clipId 的话，`selectedClip` 反查不出这个点在哪条轨道上——此前这里是写死的 'motion'。
   */
  track: TimelineClipTrackKey
  clipId: string
  index: number | null
  handle?: "in" | "out" | null
}

/**
 * 选中了某个角色的骨骼关节。`groupKey` 为 null = 「正在调关节，还没点具体哪一个」——
 * 姿势页一打开就是这个状态，它同时也是「角色级变换 gizmo 该让位」的判据（此前是姿势页
 * 挂载时单独声明一次 gizmo 所有权，那是与选中并行的第二套状态）。
 */
export interface DirectorJointSelection {
  kind: "joint"
  uuid: string
  groupKey: string | null
}

export interface DirectorKeyframeSelection {
  kind: "keyframe"
  uuid: string
  property: TimelinePropertyKey
  time: number
}

export interface DirectorClipSelection {
  kind: "clip"
  uuid: string
  track: TimelineClipTrackKey
  clipId: string
}

/** 两个锚点之间的那一段连线（间补）。以左端锚点时刻为主键，右端恒为下一个锚点。 */
export interface DirectorSpanSelection {
  kind: "span"
  uuid: string
  property: TimelinePropertyKey
  from: number
}

export type DirectorSelectionItem =
  | DirectorObjectSelection
  | DirectorCameraTargetSelection
  | DirectorPathNodeSelection
  | DirectorJointSelection
  | DirectorKeyframeSelection
  | DirectorClipSelection
  | DirectorSpanSelection

const items = ref<DirectorSelectionItem[]>([])

/** 当前选区（同类多选时不止一项；只读，改动一律经下面的动作函数）。 */
export const directorSelectionItems = readonly(items)

/**
 * 「当前正在调整的是什么」——选区的头一项。
 *
 * 调节器归属、删除键的作用目标、属性面板翻到哪一页，全部据它派生，**不要**再各存一份。
 */
export const activeDirectorSelection = computed<DirectorSelectionItem | null>(
  () => items.value[0] ?? null
)

export const activeDirectorSelectionKind =
  computed<DirectorSelectionKind | null>(
    () => activeDirectorSelection.value?.kind ?? null
  )

/** 选区所属的那个场景对象（选区为空时为 null）。子元素与时间轴要素都带着它。 */
export const selectedDirectorHostUuid = computed<string | null>(
  () => activeDirectorSelection.value?.uuid ?? null
)

/** 逐字段判等——选中态要跨「整表替换」存活（轨道整体替换会让对象引用失效），不能用引用比。 */
export function isSameDirectorSelection(
  a: DirectorSelectionItem | null,
  b: DirectorSelectionItem | null
): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind || a.uuid !== b.uuid) return false
  switch (a.kind) {
    case "object":
    case "cameraTarget":
      return true
    case "pathNode":
      return (
        // **track 也要比**：它与 clipId 一样是这一项的祖先坐标（规则①），漏掉的话
        // 「同一个下标、换了一条轴」会被判成没变——retargetDirectorSelection 据此短路，
        // 选中态就留在另一条轴的那一格上（机位身上两条轴各有一格轨迹时才露头）。
        a.track === (b as DirectorPathNodeSelection).track &&
        a.clipId === (b as DirectorPathNodeSelection).clipId &&
        a.index === (b as DirectorPathNodeSelection).index &&
        // 不给与给 null 是同一件事（选中的是点位本身），归一后再比。
        (a.handle ?? null) === ((b as DirectorPathNodeSelection).handle ?? null)
      )
    case "joint":
      return a.groupKey === (b as DirectorJointSelection).groupKey
    case "keyframe":
      return (
        a.property === (b as DirectorKeyframeSelection).property &&
        a.time === (b as DirectorKeyframeSelection).time
      )
    case "clip":
      return (
        a.track === (b as DirectorClipSelection).track &&
        a.clipId === (b as DirectorClipSelection).clipId
      )
    case "span":
      return (
        a.property === (b as DirectorSpanSelection).property &&
        a.from === (b as DirectorSpanSelection).from
      )
  }
}

/** 选区里有没有这一项（多选时逐项比）。 */
export function isDirectorItemSelected(item: DirectorSelectionItem): boolean {
  return items.value.some((current) => isSameDirectorSelection(current, item))
}

/** 选中了这一类东西吗（不问具体是哪一个）。 */
export function isDirectorSelectionKind(kind: DirectorSelectionKind): boolean {
  return activeDirectorSelectionKind.value === kind
}

/**
 * 取当前选区里这一类的头一项——「现在选中的是哪个片段/哪个关键帧」这类问题的统一入口，
 * 类型不对时返回 null（调用方因此不必先问 kind 再断言）。
 */
export function activeDirectorSelectionOf<K extends DirectorSelectionKind>(
  kind: K
): Extract<DirectorSelectionItem, { kind: K }> | null {
  const active = activeDirectorSelection.value
  return active?.kind === kind
    ? (active as Extract<DirectorSelectionItem, { kind: K }>)
    : null
}

/** 整个选区里这一类的全部项（多选用；类型不对时为空数组）。 */
export function directorSelectionsOf<K extends DirectorSelectionKind>(
  kind: K
): Extract<DirectorSelectionItem, { kind: K }>[] {
  return items.value.filter((item) => item.kind === kind) as Extract<
    DirectorSelectionItem,
    { kind: K }
  >[]
}

/** 选中一项，替换掉整个选区（单选路径，UI 上绝大多数动作走这一条）。 */
export function selectDirectorItem(item: DirectorSelectionItem): void {
  const current = items.value
  if (current.length === 1 && isSameDirectorSelection(current[0]!, item)) return
  items.value = [item]
}

/**
 * 追加一项到选区（多选）。**跨类即替换**——同一个选区里不混两种东西，见文件头规则②。
 * 已在选区里则原样不动。
 */
export function extendDirectorSelection(item: DirectorSelectionItem): void {
  if (activeDirectorSelectionKind.value !== item.kind) {
    selectDirectorItem(item)
    return
  }
  if (isDirectorItemSelected(item)) return
  items.value = [...items.value, item]
}

/** 在选区里加/减这一项（Ctrl 点选的语义）。减到空即清空选区。 */
export function toggleDirectorItem(item: DirectorSelectionItem): void {
  if (!isDirectorItemSelected(item)) {
    extendDirectorSelection(item)
    return
  }
  const next = items.value.filter(
    (current) => !isSameDirectorSelection(current, item)
  )
  items.value = next
}

export function clearDirectorSelection(): void {
  if (items.value.length > 0) items.value = []
}

/**
 * 整份换掉选区——**只给「先收起来、待会儿原样放回去」那一类流程用**（当前是成片录制：它要
 * `editor.select(null)` 才摘得掉变换 gizmo，那一下会把选区整个清掉）。
 *
 * 不是第二个选中入口：日常的选中一律走 selectDirectorItem / extendDirectorSelection，那两个
 * 入口带着「这一下用户点了什么」的语义。这里只负责把一份**先前存下来的**选区放回去，故跨类的
 * 项按规则②丢掉（同一个选区里不混两种东西），空数组即清空。
 */
export function restoreDirectorSelection(
  restored: readonly DirectorSelectionItem[]
): void {
  const kind = restored[0]?.kind ?? null
  items.value =
    kind === null ? [] : restored.filter((item) => item.kind === kind)
}

/** 只在当前选中的正好是这一类时清空（别的类被选中时清空等于把别人的选中一起收掉）。 */
export function clearDirectorSelectionOfKind(
  kind: DirectorSelectionKind
): void {
  if (activeDirectorSelectionKind.value === kind) clearDirectorSelection()
}

/** 逐项过滤（宿主对象被删、关键帧被移走这类失效清理的统一入口）。 */
export function pruneDirectorSelection(
  keep: (item: DirectorSelectionItem) => boolean
): void {
  const next = items.value.filter(keep)
  if (next.length !== items.value.length) items.value = next
}

/**
 * 就地改写选区里的项（拖动改了关键帧时刻这类 retarget）。返回是否有改动。
 *
 * 选中态以「坐标」而不是引用记录，故轨道整体替换之后它仍指得对；但**时刻本身被改了**的
 * 那几条路径（拖帧、片段让位、涟漪后移）必须把选区一起搬，否则删除键会指向一个不存在的
 * 时刻而静默失效。
 */
export function retargetDirectorSelection(
  map: (item: DirectorSelectionItem) => DirectorSelectionItem
): boolean {
  let changed = false
  const next = items.value.map((item) => {
    const mapped = map(item)
    if (!isSameDirectorSelection(mapped, item)) changed = true
    return mapped
  })
  if (changed) items.value = next
  return changed
}

/**
 * 复位选区本身。**不动删除动作注册表**——那张表的生命周期归各注册方
 * （`registerDirectorSelectionDelete` 已经交出了注销函数，各方在自己卸载时调用）。
 *
 * 从这里顺手清表的话，本函数就有了第二个身份：任何一次「把选中态归零」都会静默地把删除键
 * 整个停掉，而且**不报错**——`deleteActiveDirectorSelection` 对没有处理器的类照样返回 true
 * （那是防穿透的护栏，见下方），于是按键被消费、什么也没删、也没有兜底，用户看到的只是
 * 「删除键突然不管用了」。今天它只在导演台 setup 里、早于任何 onMounted 注册被调到，故一直
 * 相安无事，但那是调用顺序的巧合，不是这个函数该背的约定。
 */
export function resetDirectorSelection(): void {
  items.value = []
}

// ————————————————————————————————————————————————————————————————
// 删除动作注册表
//
// 「按下删除键删什么」此前靠三处 document 监听的注册顺序 + stopImmediatePropagation 分
// 优先级（时间轴帧/片段 > 路径点 > 场景对象），注释里明写着「靠 Vue 里子组件的 onMounted
// 先跑」——那是个会被任何一次组件树调整悄悄推翻的前提。
//
// 现在只有一处监听（useDirectorDeleteShortcut），按 activeKind 查表分派；各方在自己挂载
// 时注册、卸载时注销。**没有注册处理器的子元素类一律「消费掉但什么也不删」**（见
// deleteActiveDirectorSelection）：用户正在编注视点/关节/间补段，删除键绝不该落到宿主
// 对象上把整个模型删掉——那是这套机制最初要挡住的那个事故。
// ————————————————————————————————————————————————————————————————

type DirectorDeleteHandler = () => void

const deleteHandlers = new Map<DirectorSelectionKind, DirectorDeleteHandler>()

/** 注册某一类选中物的删除动作，返回注销函数（在 onBeforeUnmount 里调用）。 */
export function registerDirectorSelectionDelete(
  kind: DirectorSelectionKind,
  handler: DirectorDeleteHandler
): () => void {
  deleteHandlers.set(kind, handler)
  return () => {
    if (deleteHandlers.get(kind) === handler) deleteHandlers.delete(kind)
  }
}

/**
 * 对当前选区执行删除。返回**这次按键是否被选区消费掉**。
 *
 * 选区为空时返回 false，调用方按自己的缺省处理（当前即「什么也不做」——对象本体的删除
 * 由 'object' 这一类的处理器承担，见 useDirectorDeleteShortcut）。
 */
export function deleteActiveDirectorSelection(): boolean {
  const kind = activeDirectorSelectionKind.value
  if (kind === null) return false

  const handler = deleteHandlers.get(kind)
  handler?.()
  // 没有处理器也算消费：见上方注释，子元素选中期间删除键不该穿透到宿主对象。
  return true
}
