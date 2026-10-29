import * as THREE from "three"

import { getBindPoseBone } from "@/components/three-editor/SkeletonBindPose"
import {
  readAuthored,
  writeAuthored
} from "@/components/three-editor/EvaluatedTransform"

import { getRigRootBone, resolveCharacterRig } from "./characterRig"

// ————————————————————————————————————————————————————————————————
// 图形的「中心位置」
//
// 一个图形的原点（object.position 所在的那一点、变换 gizmo 的落点、旋转与缩放的枢轴）
// 此前完全由模型自己决定：角色是脚底中心（FBX 包裹容器的原点即脚底），几何预设是几何体
// 自身的中心。中心位置这个属性把这件事交给用户——它声明「模型上的哪一点该落在原点」，
// 落地方式是把**内容整体平移 -center**：设成 (0, 0.9, 0) 后腰部对齐原点，此后旋转绕腰部
// 发生、机位跟随注视腰部、轨迹上走的也是腰部。
//
// 三条设计取舍，改动前先看明白：
//
// 1）平移的是**内容**，不是对象自己的 position。对象的 position 是用户摆的站位、是位置
//    关键帧的读写对象、是 gizmo 的落点、也是唯一被持久化的那一份（同 directorActionRootMotion
//    与脚底吸附的取舍）。把偏移加进去就得回答「存下来的到底是站位还是站位+中心偏移」，
//    重新打开导演台再落地一次就会叠第二遍。写进内容层则天然免疫：偏移是「center → 位移」
//    的纯函数，任何时刻重算都得同一个值，且 gizmo 稳定停在原点上。
//
// 2）**不认对象类型**，按「内容住在哪儿」分派——这决定了偏移写到哪一层：
//      ①有专用的中心节点（角色：wrapper → pivot → content，见 directorAssets 的
//        attachCharacterContent）→ 绝对写入该节点的 position；
//      ②对象自己带几何（几何预设、根为 Mesh 的导入模型）→ geometry.translate 增量平移，
//        它没有可供偏移的内层节点，而顶层 Mesh 的 matrix 是 gizmo 的落点，动不得。代价是
//        偏移**烘焙进顶点**，故几何必须由这个网格独占——见 ensureExclusiveGeometry；
//      ③其余容器（群众分组、根为 Group 的导入模型）→ 直接子节点 position 增量平移。
//    新增图形种类不必回到这里，只要它落进这三种形态之一。
//
// 3）角色**必须**有那个专用中心节点，不能把偏移直接写进 content——content 上还写着切线
//    朝向（directorMotionPath 的 applyMotionTangent 改 content.rotation）。同一个节点上
//    T(-c)·R 会让中心点转到 R·c - c 而不是留在原点，轨迹一开启朝向对齐，角色就绕着中心
//    点画圈。分成两层（外层转、内层偏移）后组合成 R·(q - c)，中心点恒在原点。
//    脚底吸附与动作根位移写的也是外层（它们经 getCharacterContentNode 拿节点，该函数
//    返回的正是 pivot），故这两处不必改动。
// ————————————————————————————————————————————————————————————————

export interface ObjectCenter {
  x: number
  y: number
  z: number
}

const ZERO_CENTER: ObjectCenter = { x: 0, y: 0, z: 0 }

/** 内部承载中心偏移的那一层（root → **pivot** → content）的标记与名称。 */
export const CENTER_PIVOT_NAME = "__directorCenterPivot__"

/**
 * 「这是图形本体的根」的标记——**全域唯一的一个**：选中冒泡、gizmo、时间轴轨道、序列化
 * 认的都是它，它下面的节点只是「模型长什么样」。
 *
 * 角色容器（createCharacterContainer）与普通图形容器（createShapeContainer）都打这个标记。
 * `isCharacter` 回答的是另一个问题——「这个图形是不是角色」（要不要姿势页、骨架叠加层），
 * 两者不可互相顶替：**不要**回到「点中里面的网格该选中谁」那类地方去 `isCharacter ||
 * isShapeContainer` 地并列判断，那样每加一种图形都要回头补一个标记，漏一处的表现是
 * 「拖不动这个对象」（挪的是内部节点，根纹丝不动）。
 */
export const SHAPE_CONTAINER_FLAG = "isShapeContainer"

/** 这个对象是不是图形本体的根（角色容器、工具栏加的几何体、导入的模型）。 */
export function isShapeContainer(object: any): boolean {
  return object?.userData?.[SHAPE_CONTAINER_FLAG] === true
}

/**
 * 建一层中心 pivot。**装配这一层的唯一入口**——角色（attachCharacterContent）与普通图形
 * （createShapeContainer）共用它，标记与名字因此只有一处定义。
 */
export function createCenterPivot(): THREE.Group {
  const pivot = new THREE.Group()
  pivot.name = CENTER_PIVOT_NAME
  pivot.userData.isCenterPivot = true
  return pivot
}

/** 三层装配里最内层那些「模型自己的节点」的名字（仅为调试可读，不作判据）。 */
const SHAPE_CONTENT_NAME = "__directorShapeContent__"

/**
 * 把一个模型节点装配成三层：`root(Group) → pivot → content`，返回 root。
 *
 * root 是此后对象的**身份**：uuid/名字/变换/userData 都归它，选中、gizmo、时间轴轨道、
 * 序列化认的都是它；content 只是「模型长什么样」。这与角色的装配完全同构，故中心位置、
 * 轨迹切线朝向这些「派生的内部变换」对两者是同一套实现（见 getObjectCenterPivot）。
 *
 * 内容节点自身的变换搬到 root 上：调用方（工具栏创建、存量数据迁移）交进来的往往已经摆过
 * 位置，而摆位说的是「这个图形在场景里的站位」，那是 root 的事。
 */
export function createShapeContainer(content: THREE.Object3D): THREE.Group {
  const root = new THREE.Group()
  root.userData[SHAPE_CONTAINER_FLAG] = true
  root.name = content.name
  root.position.copy(content.position)
  root.quaternion.copy(content.quaternion)
  root.scale.copy(content.scale)
  root.visible = content.visible

  content.position.set(0, 0, 0)
  content.quaternion.identity()
  content.scale.set(1, 1, 1)
  // 可见性同样归根管（属性面板的开关、场景列表的眼睛写的都是它）。内层必须**放开**：
  // 两层都是 false 的话，用户在面板上把对象打开，它仍旧不显示。
  content.visible = true
  content.name = SHAPE_CONTENT_NAME

  const pivot = createCenterPivot()
  pivot.add(content)
  root.add(pivot)
  return root
}

/**
 * 存量数据的迁移：把一个「根就是模型」的老对象装配成三层，返回新的根。已经是三层的（新存
 * 下来的数据）原样返回。
 *
 * **uuid 必须跟着搬到 root 上**：时间轴的关键帧/片段、锁定态、机位跟随的目标都以 uuid 寻址
 * 对象，换一个就等于把那些数据全部与对象脱钩（表现是「打开旧场景，动画全没了」）。userData
 * 同理整份搬走——中心位置、缩放分解都记在那儿，留在里层没有人会去读。
 */
export function ensureShapeContainer(object: any): any {
  if (!object || isShapeContainer(object) || getObjectCenterPivot(object))
    return object

  const uuid = object.uuid
  const userData = object.userData ?? {}
  const root = createShapeContainer(object)
  object.userData = {}
  root.userData = { ...userData, [SHAPE_CONTAINER_FLAG]: true }
  root.uuid = uuid
  object.uuid = THREE.MathUtils.generateUUID()
  return root
}

/** 该对象是否已被显式设置过中心位置（区别于「设成了 (0,0,0)」，见 getObjectCenterWorld）。 */
export function hasObjectCenter(object: any): boolean {
  return Boolean(object?.userData?.center)
}

/** 读中心位置；未设置过时为 (0,0,0)——即「模型自己的原点就是中心」这一现状。 */
export function getObjectCenter(object: any): ObjectCenter {
  const value = object?.userData?.center
  if (!value) return { ...ZERO_CENTER }
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    z: Number(value.z) || 0
  }
}

/**
 * 对象**属于自己的**中心 pivot 层（三层结构 object → pivot → content 的中间那层），没有
 * 这一层则 null。
 *
 * 判据是显式标记 `userData.isCenterPivot`（由 attachCharacterContent 建），**不是**「子树里
 * 有没有骨骼」那类推断——推断会把群众分组的第一个成员（它自己带骨骼、也带自己的 pivot）
 * 当成分组自己的承载层交出来，照它转整队人里只有排头那个会动。
 *
 * 这一层是「派生的内部变换」的公共落点：中心偏移落在它的子节点上（本文件），脚底吸附、
 * 动作根位移、轨迹切线朝向落在它自己身上（见 characterPose.getCharacterContentNode，
 * 它返回的正是这一层）。故「某类对象支不支持这些派生变换」= 「它装配时有没有这一层」，
 * 各处不必再各写一套类型判断——新增图形种类时按同样的三层装配即可一并获得。
 */
export function getObjectCenterPivot(object: any): any | null {
  if (!object?.children) return null
  for (const child of object.children as any[]) {
    if (child.userData?.isCenterPivot) return child
  }
  return null
}

/**
 * 角色的中心节点（pivot 的唯一子节点）。占位阶段（FBX 网格尚未换入）还没有这一层，
 * 返回 null——那时偏移落在占位精灵上，网格换入后由 attachCharacterContent 补一次绝对落地。
 */
export function getObjectCenterNode(object: any): any | null {
  return getObjectCenterPivot(object)?.children?.[0] ?? null
}

/**
 * 把中心位置落到对象的内容层上。**不写 userData**——序列化要临时还原一次几何/子节点的
 * 偏移（见 directorSceneCodec 的通用对象分支），那时 userData 上的中心位置必须原样保留。
 *
 * @param next 目标中心位置
 * @param prev 当前已落地的中心位置（增量分支据此求位移；绝对分支忽略它）
 */
export function applyObjectCenter(
  object: any,
  next: ObjectCenter,
  prev: ObjectCenter = getObjectCenter(object)
): void {
  if (!object) return

  const centerNode = getObjectCenterNode(object)
  if (centerNode) {
    // 专用节点，除中心偏移外没有别的主人，故**绝对写入**——占位阶段换入网格后补落地时
    // 拿不到「上一次落到了哪儿」，只有绝对写入才是幂等的。
    //
    // 但不能假设它从原点起步：模型自己可能带一段内部偏移（导入的资产不保证根节点在
    // 原点上）。直接 set(-center) 会把那一段抹掉，且归零时也回不来。故与脚底吸附的
    // poseBaseY、根位移的 rootMotionBase 同一套记账——首次落地前抄下原始位置当基准，
    // 此后一律在它之上叠加。
    if (centerNode.userData.centerBase === undefined) {
      centerNode.userData.centerBase = [
        centerNode.position.x,
        centerNode.position.y,
        centerNode.position.z
      ]
    }
    const base = centerNode.userData.centerBase as number[]
    centerNode.position.set(
      (base[0] ?? 0) - next.x,
      (base[1] ?? 0) - next.y,
      (base[2] ?? 0) - next.z
    )
    markLocalMatrixDirty(centerNode)
  } else {
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    const dz = next.z - prev.z
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      // 对象自带几何时先平移几何本身；子节点无论哪种形态都要跟着走，否则整体会被拆开。
      if (object.geometry) object.geometry.translate(-dx, -dy, -dz)
      for (const child of object.children as any[]) {
        if (child.userData?.isCenterPivot) continue
        child.position.set(
          child.position.x - dx,
          child.position.y - dy,
          child.position.z - dz
        )
        markLocalMatrixDirty(child)
      }
    }
  }

  // 动作竖向那两条通道读的是**装配元数据 + 逐帧脚底表**，两者都量在未偏移的模型上，
  // 与此刻的中心偏移无关，故改中心不必让谁重测（脚底吸附时代这里要删一个缓存基准）。
}

/**
 * 只把**动过的那一个节点**的局部矩阵刷新掉，不碰它的子树。
 *
 * 早先这里是对整个对象 `updateMatrixWorld(true)`：一次强制刷新整棵子树，而属性面板的步进器
 * 一秒能提交几十次——上百人的群众分组（每人一副骨架）每一次都要重算上万个矩阵，纯属白付。
 *
 * 世界矩阵不必在这里算：`matrixWorldNeedsUpdate`（updateMatrix 会置位）一路让渲染循环下一帧
 * 自然带上，而在此之前就要量的那几个消费方——骨架线（`getWorldPosition`）、机位跟随
 * （`getObjectCenterWorld`）、选中框与角色标签（`Box3.setFromObject`）、轨迹画线
 * （`pathSpaceMatrix`）——用的都是自带 updateWorldMatrix 的入口，各自会把需要的那条链刷正确。
 *
 * 局部矩阵则**必须**在这里刷：`Object3D.toJSON()` 直接读 `this.matrix`、不会自己重算，而
 * serializeGenericObject 是「改完立刻 toJSON」的同步流程，中间插不进一帧渲染——不刷就会
 * 把过期的矩阵存进画布数据。
 */
function markLocalMatrixDirty(node: any): void {
  if (node.matrixAutoUpdate) node.updateMatrix()
  else node.matrixWorldNeedsUpdate = true
}

/**
 * 让这个网格独占自己的几何——中心偏移是**烘焙进顶点**的（顶层 Mesh 的 matrix 是 gizmo 的
 * 落点，动不得，见取舍 2），所以几何一旦被两个对象共用，调其中一个的中心会把另一个也拖走。
 *
 * 今天这个不变式天然成立：几何预设每次 `new`，场景恢复时每个条目各自 parse。**将来加「复制
 * 图形」时会被打破**——`Object3D.clone()` 共用几何与材质引用（材质那一侧已有先例：
 * directorAssets 的 cloneMeshMaterials 正是为按实例染色而逐网格克隆材质）。故在真正要写顶点
 * 之前查一次，共用就先克隆出一份自己的。
 *
 * 查的是「场景里还有没有别人引用同一个几何」而不是记一个 owner 标记：标记答不了「复制发生在
 * 认领之后」那一种——那时原件仍是 owner，照样会把副本一起拖走。场景遍历的量级（几十到几百个
 * 节点）远小于一帧渲染，而这条路只在用户手调普通网格的中心时才走。
 *
 * 克隆自然带着当前已烘焙的偏移，故两边此刻长得一模一样，此后各调各的。旧几何仍被别人用着，
 * 不 dispose。
 */
function ensureExclusiveGeometry(editor: any, object: any): void {
  const geometry = object?.geometry
  if (!geometry || !editor?.scene) return

  let shared = false
  editor.scene.traverse((node: any) => {
    if (!shared && node !== object && node.geometry === geometry) shared = true
  })
  if (!shared) return

  const exclusive = geometry.clone()
  object.geometry = exclusive
  editor.addGeometry?.(exclusive)
}

/**
 * 设置中心位置：先落地到内容层，再记进 userData（持久化与回读的单点源）。
 *
 * `editor` 只为「几何独占」那一道检查（见 ensureExclusiveGeometry）而来，故是可选的：
 * 序列化时的临时还原走 applyObjectCenter，那一路两次平移前后抵消、不会把共用的几何留在
 * 错位上；场景恢复走 reapplyObjectCenter，几何是刚 parse 出来的、本就独占。只有**用户的
 * 编辑**会永久改写顶点，那一路（SetObjectCenterCommand）必须把 editor 递进来。
 */
export function setObjectCenter(
  object: any,
  next: ObjectCenter,
  editor?: any
): void {
  if (!object) return
  const value = { x: next.x || 0, y: next.y || 0, z: next.z || 0 }
  const previous = getObjectCenter(object)
  if (editor) ensureExclusiveGeometry(editor, object)
  applyObjectCenter(object, value)
  object.userData.center = value
  // 换基准不该让模型动（只有**用户的编辑**这一路要补，故与几何独占同一道 editor 闸门：
  // 场景恢复与序列化的临时还原都不能补，那会把补偿一次次叠进存下来的站位里）。
  if (editor) compensateCenterShift(object, value, previous)
}

const _shift = new THREE.Vector3()
const _linear = new THREE.Matrix4()
const _quat = new THREE.Quaternion()

/**
 * 换中心位置时把模型**钉在原地**：中心一变，内容整体平移 −Δ，模型在世界里就跟着挪了；把同样
 * 的 Δ 补进对象的站位，两者抵消，画面纹丝不动。
 *
 * 中心位置说的是「原点落在模型的哪一点」，**不是**「把模型搬到哪儿」。用户在属性面板上把基准从
 * 底部换到中心，期待的是 gizmo 从脚底跳到胯上，而不是整个人往下掉一米。
 *
 * 三条：
 * · 写的是 **authored**（`writeAuthored`），不是节点上的合成值——那上面还叠着轨迹/动作的派生量，
 *   直写会把它们当成用户摆的站位收编，下一帧再复合一次。
 * · **位置被轨迹片段或位置关键帧驱动着时补了也白补**（authored 不参与那几秒的合成），画面仍会
 *   跳一下。这是已知且接受的——用户的原话就是「如果不处于轨迹或关键帧」。补偿照样落到 authored
 *   上，故那几秒之外仍是对的。
 * · **不因此产生关键帧**：这是「换个原点」而不是「挪动对象」。落法在 SetObjectCenterCommand
 *   ——它在派发 objectChanged 之前把自动补帧的基准同步掉，故补帧比不出任何变化。
 */
function compensateCenterShift(
  object: any,
  next: ObjectCenter,
  previous: ObjectCenter
): void {
  const dx = next.x - previous.x
  const dy = next.y - previous.y
  const dz = next.z - previous.z
  if (dx === 0 && dy === 0 && dz === 0) return

  _shift.set(dx, dy, dz)
  // 先过承载层自己的线性部分（模型的单位缩放等静态变换住在那儿），再过对象自己的缩放与
  // 旋转——补偿要落在**父层**坐标里，与 position 同一空间。
  const pivot = getObjectCenterPivot(object)
  if (pivot) {
    _linear.copy(pivot.matrix).setPosition(0, 0, 0)
    _shift.applyMatrix4(_linear)
  }
  if (object.scale) _shift.multiply(object.scale)
  // 旋转取 **authored**，不是节点上的合成值。合成值里还叠着轨迹的切线朝向
  // （`applyMotionTangent` 经求值层写在**对象自己**这条 quaternion 通道上），而它**逐帧
  // 都在变**，补偿却只写下**一个**静态的 authored 位置——拿某一帧的切线角去转这个向量，
  // 就等于把那一帧的朝向永久烙进补偿里：开着朝向对齐的角色，把中心基准从底部换到中心时
  // 若播放头正停在轨迹片段内，片段之外的角色会被平移 (R_切线 − I)·S·Δ。
  // 上面第二条注释说的正是「那几秒之外仍是对的」，用 authored 才当真。
  const authoredQuat = readAuthored(object, "quaternion") as number[] | null
  if (authoredQuat) _shift.applyQuaternion(_quat.fromArray(authoredQuat))
  else if (object.quaternion) _shift.applyQuaternion(object.quaternion)

  const authored = readAuthored(object, "position") as number[] | null
  const base = authored ?? [
    object.position.x,
    object.position.y,
    object.position.z
  ]
  writeAuthored(object, "position", [
    (base[0] ?? 0) + _shift.x,
    (base[1] ?? 0) + _shift.y,
    (base[2] ?? 0) + _shift.z
  ])
}

/**
 * 新建角色的**默认中心**：脚底（「底部」基准）。只在**创建**那一路调用，网格换入之后。
 *
 * 为什么要有这么一步——角色的原点此前是「FBX 恰好把模型摆在了地面上」这个**巧合**，没有任何
 * 地方声明过。声明出来之后有三件事跟着成立：属性面板的中心基准直接显示「底部」而不是「自定义」；
 * 换一具装配不再需要重新赌它的原点在哪儿；接地间隙那 3.1cm 由元数据补掉（见
 * resolveObjectCenterAnchor）。落下去的值本身**几乎为零**（male −0.0001m、female −0.00035m），
 * 故创建时的观感与此前逐像素相同——这一步买的是「有据可依」，不是把模型挪个位置。
 *
 * 三条边界：
 * · **场景恢复不走这里**（directorSceneCodec）。存量场景没存过 center，补一个默认值等于把每
 *   一具角色静默平移一次；恢复只认存下来的那一份，没有就仍是「模型自己的原点」。
 * · **已经有中心位置就不动**（用户设过、或恢复时回填过）。
 * · 元数据/骨架都还没到手（模板加载失败、非骨骼模型）时 `resolveObjectCenterAnchor` 给 null，
 *   此时**什么也不做**——编一个中心比没有中心糟糕。
 */
export function applyDefaultCharacterCenter(object: any): void {
  if (!object || hasObjectCenter(object)) return
  const bottom = resolveObjectCenterAnchor(object, "bottom")
  if (!bottom) return
  setObjectCenter(object, bottom)
}

/** 网格换入/场景恢复后把已记录的中心位置重新落地一次（绝对，幂等）。 */
export function reapplyObjectCenter(object: any): void {
  if (!hasObjectCenter(object)) return
  applyObjectCenter(object, getObjectCenter(object), ZERO_CENTER)
}

const _box = new THREE.Box3()
const _matrix = new THREE.Matrix4()
const _vec = new THREE.Vector3()

/**
 * 中心位置的两个**基准**：模型的哪一处该落在对象原点上。
 *
 * 「原点在哪儿」是这套坐标系里唯一需要用户拿主意的事（见下方 resolveObjectCenterAnchor 的
 * 说明），而实际要的答案几乎总是这两个之一，故给成枚举；手输 xyz 仍然保留（中心位置字段），
 * 枚举只是把「量一次包围盒再填进去」这件事省掉。
 */
export type ObjectCenterAnchor = "bottom" | "center"

const _relative = new THREE.Matrix4()
const _corner = new THREE.Vector3()

interface SkeletonAnchor {
  /** rig 根骨骼（Mixamo 即 Hips）在 frame 空间里的位置——角色的「所在位置」。 */
  root: THREE.Vector3
  /** 绑定姿态下最低骨骼的高度（frame 空间）——角色的「脚底」。 */
  floorY: number
}

/**
 * 骨骼模型的锚点：从**骨架**取，不从包围盒取；没有骨骼时返回 null（刚体走包围盒那条）。
 *
 * 理由是「几何中心对骨骼模型根本不是一个稳定的锚点」：姿势改变身体的分布，脚底吸附还会再把
 * 整具网格上下推一段，任何一次量出来的固定偏移都追不上它——用户看到的就是「调完姿势，中心和
 * 底部都偏了」。游戏引擎/DCC 里角色的「位置」从来不是几何中心，而是**骨架根**（Mixamo 的
 * Hips），轨迹带的是它，姿势与动作在它之上表达。
 *
 * 两个量都按**绑定姿态**算（骨骼的 bind 变换来自 SkeletonBindPose，姿势只改骨骼的旋转），
 * 故与当前摆的是什么姿势无关：
 *   · `root` —— 根骨骼的位置。旋转一根骨骼不会移动它自己的原点，故它本就恒定，这里按 bind
 *     算只是为了与 floorY 同源。
 *   · `floorY` —— 最低骨骼的高度。**必须**按 bind 算：按当前姿势量的话，抬一条腿就会把
 *     「底部」抬上去，那正是这次要修的漂移。
 */
function measureSkeletonIn(frame: any, node: any): SkeletonAnchor | null {
  node.updateWorldMatrix(true, true)
  frame.updateWorldMatrix(true, false)
  _matrix.copy(frame.matrixWorld).invert()

  let root: THREE.Vector3 | null = null
  let floorY = Infinity

  // 广度优先，逐层把「绑定姿态下的局部矩阵」乘下去；起点是内容节点相对 frame 的当前变换
  // （它不是骨骼，不受姿势影响）。一次性的用户操作，不必吝惜这几个矩阵。
  const queue: { node: any; matrix: THREE.Matrix4 }[] = [
    {
      node,
      matrix: new THREE.Matrix4().multiplyMatrices(_matrix, node.matrixWorld)
    }
  ]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const child of current.node.children as any[]) {
      const bind = child.isBone ? getBindPoseBone(child) : undefined
      const local = bind
        ? new THREE.Matrix4().compose(
            bind.position,
            bind.quaternion,
            bind.scale
          )
        : child.matrix
      const matrix = new THREE.Matrix4().multiplyMatrices(current.matrix, local)
      if (child.isBone) {
        const y = matrix.elements[13] ?? 0
        if (y < floorY) floorY = y
        // rig 根 = 父节点不是骨骼的那一根。
        if (!root && !current.node.isBone) {
          root = new THREE.Vector3().setFromMatrixPosition(matrix)
        }
      }
      queue.push({ node: child, matrix })
    }
  }

  if (!root || !Number.isFinite(floorY)) return null
  return { root, floorY }
}

/**
 * `node` 子树的包围盒，量在 `frame` 的**局部坐标**里；量不出（没有几何）时返回 false。
 *
 * 不能图省事用 `Box3.setFromObject` 再乘一次逆矩阵——那量的是**世界轴对齐**的盒子，对象一旦
 * 转过角度，盒子就被撑大，再换算回来仍是撑大的：同一个模型「站着」与「躺着」量出来的底部
 * 差出 0.22m（实测，2m 高的盒子转 45°），中心在多网格模型上也会偏。用户看到的就是「横竖一
 * 变，中心/底部基准跟着漂」。
 *
 * 故逐个网格取它自己的几何包围盒，用 `frame⁻¹ · child.matrixWorld` 这个**相对矩阵**把 8 个角
 * 变换过去再并起来：对象在世界里的姿态在这个相对矩阵里被约掉，结果只取决于模型自己的形状与
 * 它在装配里的摆放。蒙皮网格取的是几何（绑定姿态）的盒子，故也不随当前姿势漂。
 */
function measureBoxIn(frame: any, node: any, target: THREE.Box3): boolean {
  node.updateWorldMatrix(true, true)
  frame.updateWorldMatrix(true, false)
  _matrix.copy(frame.matrixWorld).invert()

  target.makeEmpty()
  node.traverse((child: any) => {
    const geometry = child.geometry
    if (!geometry) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const box = geometry.boundingBox as THREE.Box3 | null
    if (!box || box.isEmpty()) return

    _relative.multiplyMatrices(_matrix, child.matrixWorld)
    for (let i = 0; i < 8; i++) {
      _corner
        .set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z
        )
        .applyMatrix4(_relative)
      target.expandByPoint(_corner)
    }
  })
  return !target.isEmpty()
}

/**
 * 把基准换算成具体的中心位置（模型自己的坐标系），量不出尺寸时 null。
 *
 * **坐标系的分工**——这是整套变换的地基，改动前先对齐：
 *   · **世界（父层）坐标**：`object.position/quaternion` 把对象的**原点**摆到场景里。轨迹、
 *     位置/旋转关键帧、变换 gizmo 写的都是这一份，参照点恒为原点。
 *   · **对象内部坐标**：模型长什么样、原点落在模型的哪一处（本函数）、以及各种派生的内部
 *     变换（脚底吸附、动作根位移、轨迹切线朝向）。内部怎么改都**不动原点**——原点是内外
 *     两套坐标系唯一的交接点，一动，外面那套的一切参照就都跟着漂。
 *
 * 「模型看着不在轨迹线上」属于内部坐标的问题（角色的原点在脚底，摆成趴着后身子自然横在
 * 原点外），答案就是把基准换成「中心」，而不是去给外面那套加什么补偿。
 *
 * 量的是**内容节点自己**的包围盒（不含承载层的派生变换，故脚底吸附/切线朝向都不会掺进来）。
 * 蒙皮角色的包围盒随姿势变化，故这是「按此刻的样子」定的一次性换算，不是持续跟随的模式——
 * 与手型预设同理（`matchesHandShape`），事后用户手调过就落回「自定义」。
 */
export function resolveObjectCenterAnchor(
  object: any,
  anchor: ObjectCenterAnchor
): ObjectCenter | null {
  if (!object) return null

  // 内置素体：答案由**装配元数据**给出（characterRig），不再就地量骨架。这是「规范化」那一步
  // ——两具素体的胯高差 4.5cm、胯的 z 差 1.5cm、最低骨骼到鞋底还各差一段，实测那条路给得出
  // 前两项、给不出第三项（它要量网格，而骨架路只看骨骼）。
  //
  // 元数据量在**模板**上（未被任何中心偏移挪过），故已经是绝对值，**不要**像下面两条实测
  // 回退那样再叠一次 `getObjectCenter`——那是给「量的是已经挪过 −center 的模型」准备的补正。
  const rig = resolveCharacterRig(object)
  if (rig) {
    return {
      x: rig.hips[0],
      // 「底部」扣掉**接地间隙**：最低骨骼不在鞋底上。male 的 LeftToe_End 比鞋底高
      // 3.1cm，不扣的话选「底部」会让他陷进地里 3.1cm；female 只差 0.35mm，故这个错
      // 在她身上完全看不出来——最容易被读成「某一个模型有问题」的那一类差异。
      y:
        anchor === "bottom" ? rig.boneFloor - rig.groundClearance : rig.hips[1],
      z: rig.hips[2]
    }
  }

  const content = getObjectCenterNode(object)
  const node = content ?? object
  // 量在**中心位置这个量本身所在的那一层**里，不是内容节点自己的局部空间：
  //   · 有内容节点 → 偏移写的是 `content.position`，故那一层是它的**父节点**（pivot）空间；
  //   · 没有内容节点 → 偏移烘焙在几何/子节点里，那一层就是对象自己的局部空间。
  // 这一条踩过一次：角色的内容节点上带着 FBX 的 0.01 单位缩放（见 applyFBXUnitScale），
  // 在它自己的局部空间里量出来的是**厘米**，当成米写进中心位置，模型直接飞出去几十米。
  const frame = content?.parent ?? object

  // 没有装配元数据的骨骼模型（用户导入的、存量数据里的）：就地实测骨架，从**骨架**取而不是
  // 从包围盒取（见 measureSkeletonIn 的说明）。这条路量不出接地间隙——它要量网格，而这里
  // 只认骨骼——故「底部」仍是最低骨骼，与内置素体差着那一段。要精确就给它一份元数据。
  const skeleton = measureSkeletonIn(frame, node)
  if (skeleton) {
    const applied = getObjectCenter(object)
    const y = anchor === "bottom" ? skeleton.floorY : skeleton.root.y
    return {
      x: skeleton.root.x + applied.x,
      y: y + applied.y,
      z: skeleton.root.z + applied.z
    }
  }

  if (!measureBoxIn(frame, node, _box)) return null
  _box.getCenter(_vec)
  const y = anchor === "bottom" ? _box.min.y : _vec.y

  // 量到的是模型**此刻已经挪过 −center 的形态**，故把当前已应用的那一份加回去，才是这个
  // 字段要的绝对量（模型自带的内部偏移 centerBase 在这个式子里正好抵消掉）。
  const applied = getObjectCenter(object)
  return { x: _vec.x + applied.x, y: y + applied.y, z: _vec.z + applied.z }
}

/** 当前中心位置正好等于哪个基准（都不是即 null——用户手输过别的值）。 */
export function matchObjectCenterAnchor(
  object: any
): ObjectCenterAnchor | null {
  const current = getObjectCenter(object)
  for (const anchor of ["bottom", "center"] as ObjectCenterAnchor[]) {
    const resolved = resolveObjectCenterAnchor(object, anchor)
    if (!resolved) continue
    // 容差取中心位置字段的控件分辨率（步长 0.01）之下，与它的判等短路同一口径。
    if (
      Math.abs(resolved.x - current.x) < 0.001 &&
      Math.abs(resolved.y - current.y) < 0.001 &&
      Math.abs(resolved.z - current.z) < 0.001
    ) {
      return anchor
    }
  }
  return null
}

/**
 * 这个图形的中心在世界的哪一点——机位跟随、注视对齐这类「相对位置逻辑」的单点源。
 *
 * 四条，按优先级：
 *
 * 1）**有骨架的角色 → rig 根骨骼（Hips）的世界位置**。这条排在最前面，理由有两条：
 *    · 角色的原点如今显式声明为**脚底**（新建角色默认落「底部」中心，见 applyDefaultCharacterCenter）。
 *      照第 2 条走的话，机位跟随/注视会当场对准角色的**鞋** —— 默认中心这一步会把镜头拽到地上。
 *    · 包围盒中心本就不是角色的稳定参照：姿势改变身体的分布、脚底吸附还会把整具网格上下推，
 *      注视点因此会随姿势漂（抬一条腿镜头就动一下）。骨架根不受这些影响，这也正是
 *      `measureSkeletonIn` 与 characterRig 已经论证过的同一条——角色的「位置」是骨架根。
 *    取**当前**世界位置而不是元数据里的绑定姿态胯位：跟随要的就是「这一帧他在哪儿」，
 *    下蹲/迈步时镜头该跟着走。占位阶段（还没有骨骼）自然落到下面几条。
 * 2）用户设过中心位置 → **对象原点**：中心位置的语义正是「把这一点搬到原点」。
 * 3）否则按包围盒中心推断（设这个属性之前唯一的答案，故存量的非角色场景观感不变）。
 * 4）包围盒为空（空 Group、网格尚未换入的占位角色）→ 对象原点。
 */
export function getObjectCenterWorld(
  object: any,
  target: THREE.Vector3
): THREE.Vector3 {
  // 判据是**角色容器那个标记**，不是「子树里找不找得到骨骼」——后者会把群众分组的**第一个
  // 成员**的 Hips 当成整个分组的中心交出去（整队人只跟排头那一个），与 getObjectCenterPivot
  // 拒绝按骨骼推断是同一条。分组仍走包围盒中心，那对一队人本来就是对的答案。
  if (object?.userData?.isCharacter === true) {
    const bone = getRigRootBone(object)
    if (bone) return bone.getWorldPosition(target)
  }
  if (hasObjectCenter(object)) return object.getWorldPosition(target)
  _box.setFromObject(object)
  if (_box.isEmpty()) return object.getWorldPosition(target)
  return _box.getCenter(target)
}
