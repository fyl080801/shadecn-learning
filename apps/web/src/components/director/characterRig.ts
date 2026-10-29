import * as THREE from "three"

// ————————————————————————————————————————————————————————————————
// 骨骼装配（rig）的**标准化元数据**
//
// 两具素体长得几乎一样，但装配上的差异会一路漏到世界坐标里——胯高差 4.5cm、胯的 z 差
// 1.5cm、最低骨骼到鞋底还各差一段（male 3.1cm、female 0.35mm）。这些差异此前没有任何
// 地方声明过，于是「中心在哪儿」「底部在哪儿」只能在运行期**猜**：按包围盒猜（随姿势漂）、
// 或按最低**骨骼**猜（male 的鞋底因此陷到原点下 3.1cm）。
//
// 本文件把这些差异收成**一份可声明、可实测、可校验的数据**：每具装配各有一份 CharacterRig，
// 「中心/底部/身高/单位/正面」全部从它来。新增一具素体不必回到任何一处调用方——量出它自己
// 的那一份即可。
//
// —— 三条取舍 ——
//
// 1）**实测为主，manifest 覆盖**。数值一律从加载好的 FBX 实测（`measureCharacterRig`），
//    资源包 manifest 里的声明只**覆盖**其中几项。理由是两者各有各答不了的问题：实测永远与
//    实际文件同步（换一版模型自动跟上，不必重新发资源包），但量不出「正面是哪个轴」这类
//    约定；声明能表达约定、也能人工修正某一具装配的怪癖，但改一个数就要重跑
//    `pnpm director:build` + 上传。故两条都留，优先级是**声明盖实测**。
//    资源包那一侧的同名产出见 lingjing-modelconfig 的 `pnpm mixamo:measure-rig`——它用的是
//    与本文件**逐条同源**的口径，两处对不上就是 bug，不是两种合理答案。
//
// 2）**量在「内容节点的父层」空间，单位是米**。即三层装配 root → pivot → content 里的
//    pivot 空间（见 directorObjectCenter）。这一条是硬约束：中心位置这个量本身就住在那一层
//    （偏移写的是 content.position），而 content 上带着 FBX 的 0.01 单位缩放——量在 content
//    自己的局部空间里得到的是**厘米**，当成米写进中心位置，模型直接飞出去几十米。
//    实测时故意量在**模板**（尚未被任何中心偏移挪过）上，故 rig 里的值是**绝对**的，调用方
//    **不要**再叠一次 `getObjectCenter`（那是给「量的是已经挪过的模型」那条实测回退路准备的）。
//
// 3）**只描述，不校正**。`rootRestTilt` 记下 female 根骨骼那 0.74° 的静置倾角，但装配一个
//    字都不改：根骨骼的静置旋转是 `snapshotBindPose` 的基准，也是动作库一千多条动作离线
//    分解时的基准，改写它等于让这具素体的**每一个**姿势整体偏 0.74°——收益（肉眼不可见）
//    远小于风险。它在这里的用处是诊断与将来的判据（倾角一大，「正面 +Z」这条约定就不再
//    成立），**不要**改成「加载时把它转回去」。
// ————————————————————————————————————————————————————————————————

/**
 * 装配规范：决定根骨骼叫什么、控件表怎么对应、正面是哪个轴。
 *
 * 当前只有 Mixamo 一种（两具素体与整个动作库都出自它）。加第二种规范时，姿势控件表
 * （characterPoseGroups）与动作分解都要跟着分叉，故它是一个**枚举而不是布尔**——将来
 * 那些分支的判据落在这里，不要各处去嗅骨骼名字。
 */
export type RigConvention = "mixamo"

export interface CharacterRig {
  /** 装配规范。 */
  convention: RigConvention
  /** rig 根骨骼名（Mixamo 即 `mixamorigHips`）——「角色在哪儿」在骨架上的答案。 */
  rootBone: string
  /** 1 个模型单位 = 多少米（FBX 的 `unitScaleFactor / 100`，Mixamo 即 0.01）。 */
  unitScale: number
  /**
   * 角色正面在**模型局部**的哪个轴（Mixamo 即 +Z）。
   *
   * 判据是动作库「前进一步」的根位移正好朝 +Z（见 directorMotionPath 的 applyMotionTangent），
   * 不是量出来的——脚掌天然外八，按脚趾方向量 male 会得到偏 1.5° 的答案。故它是**规范给的
   * 约定**，随 convention 定，manifest 可覆盖。
   */
  forward: [number, number, number]
  /**
   * 绑定姿态下 rig 根骨骼的位置（米）——**「中心」基准的答案**。
   *
   * 取骨架根而不是包围盒中心：姿势改变身体的分布、脚底吸附还会把整具网格上下推，任何一次
   * 量出来的几何中心都追不上它（见 directorObjectCenter 的 measureSkeletonIn）。
   */
  hips: [number, number, number]
  /** 绑定姿态下最低**骨骼**的高度（米）。脚底吸附的基准就是这个量。 */
  boneFloor: number
  /**
   * **接地间隙**：最低骨骼到网格实际着地面的距离（米）。
   *
   * 骨骼末端不在鞋底上——male 的 `LeftToe_End` 比鞋底高 3.1cm，female 只差 0.35mm。
   * 「底部」基准 = `boneFloor − groundClearance`，扣掉它两具素体才都归到「鞋底正好落在
   * 对象原点上」。不扣的话选「底部」会让 male 陷进地里 3.1cm，而这件事在 female 身上
   * 看不出来——最容易被读成「某一个模型有问题」的那一类差异。
   */
  groundClearance: number
  /** 绑定姿态身高（米）：网格包围盒的高度。缩放归一与「这具装配有多大」的读数。 */
  height: number
  /**
   * 根骨骼的静置倾角（度，XYZ）。**只声明，不校正**（见文件头取舍 3）。
   * male ≈ 0，female 绕 X 有 0.74°。
   */
  rootRestTilt: [number, number, number]
}

/** manifest 可以覆盖的那几项（其余一律实测）。 */
export type CharacterRigOverride = Partial<CharacterRig>

/** 各规范的约定项——实测答不了的那些，按 convention 给缺省。 */
const CONVENTION_DEFAULTS: Record<
  RigConvention,
  Pick<CharacterRig, "forward">
> = {
  // Mixamo 装配的正面是 +Z（判据见 CharacterRig.forward）。
  mixamo: { forward: [0, 0, 1] }
}

/**
 * rig 根骨骼：父节点不是骨骼的那一根（Mixamo 即 Hips）。
 *
 * 住在本文件而不是 characterPose：`directorObjectCenter` 也要问它（注视参照点），而
 * characterPose 反过来 import directorObjectCenter，放在那边就成环。characterPose 仍
 * 原样导出它，调用方不必改。
 */
export function getRigRootBone(root: any): any | null {
  let bone: any = null
  root?.traverse?.((child: any) => {
    if (!bone && child.isBone && !child.parent?.isBone) bone = child
  })
  return bone
}

/**
 * 全部骨骼在 `root` **父层**空间里的最低 y —— 「这个姿势下脚底在多高」。
 *
 * 与装配元数据的 `boneFloor` 同一口径（那一份就是绑定姿态下的这个值），故两者可以直接相减，
 * 差出来的正是「这个姿势把脚抬高/放低了多少」。动作的竖向分解靠这个差值把**屈膝**（脚不动、
 * 胯下沉）与**起跳/坠落**（整个人离地）分开，见 characterActionGrounding。
 *
 * 量在父层而不是 root 自己的局部空间：父层那一层单位才是米（root 上带着 FBX 的 0.01 缩放）。
 */
export function boneFloorOf(root: any): number {
  if (!root) return Infinity
  root.updateWorldMatrix(true, true)
  if (root.parent) _floorMatrix.copy(root.parent.matrixWorld).invert()
  else _floorMatrix.identity()

  let floor = Infinity
  root.traverse((child: any) => {
    if (!child.isBone) return
    const y = _floorVec
      .setFromMatrixPosition(child.matrixWorld)
      .applyMatrix4(_floorMatrix).y
    if (y < floor) floor = y
  })
  return floor
}

const _floorMatrix = new THREE.Matrix4()
const _floorVec = new THREE.Vector3()

const _matrix = new THREE.Matrix4()
const _relative = new THREE.Matrix4()
const _vec = new THREE.Vector3()
const _scratch = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _corner = new THREE.Vector3()

/**
 * 从一具**加载好的**素体实测它的 rig。没有骨骼（不是骨骼模型）时返回 null。
 *
 * `root` 必须是**已经过 `applyFBXUnitScale`** 的那个 FBX 根节点，且此刻摆的是**绑定姿态**
 * （模板刚解析出来就是，见 directorAssets 的 loadCharacterTemplate）——两条都不成立时量出来
 * 的是别的东西：前者会得到厘米，后者会把「抬起来的那条腿」当成底部。
 *
 * 量在 `root` 的**父层**空间（= 运行期的 pivot 空间，含 root 自己的 0.01 缩放与位置），
 * 故结果直接就是米、也直接就是中心位置那个字段的取值空间（见文件头取舍 2）。
 */
export function measureCharacterRig(
  root: any,
  convention: RigConvention = "mixamo"
): CharacterRig | null {
  if (!root) return null
  const bone = getRigRootBone(root)
  if (!bone) return null

  root.updateWorldMatrix(true, true)
  // 父层空间 = 把 root 的宿主那一层约掉。模板通常没有父节点（世界即父层），但不能假设
  // ——挂在别处时按世界量会把宿主的变换掺进来。
  if (root.parent) _matrix.copy(root.parent.matrixWorld).invert()
  else _matrix.identity()

  const inParent = (source: THREE.Matrix4) =>
    _vec.setFromMatrixPosition(source).applyMatrix4(_matrix)

  // 「角色在哪儿」= 根骨骼。
  const hips = inParent(bone.matrixWorld).toArray() as [number, number, number]

  // 根骨骼的静置倾角：只作声明（见取舍 3）。取父层空间里的朝向，与 hips 同一参照。
  //
  // **必须走 decompose**，不能 `setFromRotationMatrix`——后者假定矩阵里没有缩放，而这条链上
  // 正带着 FBX 的 0.01 单位缩放（对角线是 0.01 而不是 1），它按 trace 解出来的四元数是废的
  // （实测把 female 那 0.74° 读成 0.01°）。decompose 会先把缩放除掉。
  _relative
    .multiplyMatrices(_matrix, bone.matrixWorld)
    .decompose(_scratch, _quat, _scale)
  _euler.setFromQuaternion(_quat, "XYZ")
  const rootRestTilt = [_euler.x, _euler.y, _euler.z].map((radian) =>
    THREE.MathUtils.radToDeg(radian)
  ) as [number, number, number]

  const boneFloor = boneFloorOf(root)

  // 网格底/顶：逐网格取它**几何**（蒙皮网格的几何即绑定姿态）的包围盒，八个角变换到父层
  // 空间再并起来。不用 Box3.setFromObject——那量的是世界轴对齐的盒子，模板一旦被转过角度
  // 就被撑大（同 directorObjectCenter 的 measureBoxIn）。
  let meshFloor = Infinity
  let meshTop = -Infinity
  root.traverse((child: any) => {
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
      if (_corner.y < meshFloor) meshFloor = _corner.y
      if (_corner.y > meshTop) meshTop = _corner.y
    }
  })

  if (!Number.isFinite(boneFloor)) return null
  // 没有网格（理论上不会：素体必然带蒙皮网格）时接地间隙记 0——猜一个数比记 0 糟糕，
  // 0 的含义正好是「骨骼底就是着地面」，与「量不出来」在落地效果上等价。
  const hasMesh = Number.isFinite(meshFloor) && Number.isFinite(meshTop)

  const unitScaleFactor = root.userData?.unitScaleFactor
  return {
    convention,
    rootBone: bone.name,
    // 单位缩放已经落在 root.scale 上（applyFBXUnitScale），故实测值本身已是米；这里记的
    // 是「当初按什么系数换的」，供诊断与资源包那一侧对账。
    unitScale: typeof unitScaleFactor === "number" ? unitScaleFactor / 100 : 1,
    ...CONVENTION_DEFAULTS[convention],
    hips,
    rootRestTilt,
    boneFloor,
    groundClearance: hasMesh ? boneFloor - meshFloor : 0,
    height: hasMesh ? meshTop - meshFloor : 0
  }
}

/**
 * 实测的那一份 + manifest 的声明。声明**盖**实测（见文件头取舍 1），未声明的项原样保留。
 *
 * 挑掉 `undefined`：manifest 里写了 `"rig": {}` 或某项为 null 时不该把实测值抹成空。
 */
export function mergeCharacterRig(
  measured: CharacterRig | null,
  override: CharacterRigOverride | null | undefined
): CharacterRig | null {
  if (!measured) return null
  if (!override) return measured
  const next: CharacterRig = { ...measured }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue
    ;(next as any)[key] = value
  }
  return next
}

// ————————————————————————————————————————————————————————————————
// 按 preset key 的缓存
//
// 素体 FBX 每个会话只解析一次（characterTemplateCache），rig 随那一次测出来存在这里，此后
// 每个角色实例、每次面板回填都是查表。
//
// **不进 userData**：它是从静态资产派生的量，随 preset key 可重算，存进去只会被 toJSON 带进
// 画布数据、并在换一版模型之后变成一份对不上的陈旧声明（同 SkeletonBindPose 与求值层的理由）。
// ————————————————————————————————————————————————————————————————

const rigByPreset = new Map<string, CharacterRig>()

export function cacheCharacterRig(
  presetKey: string,
  rig: CharacterRig | null
): void {
  if (!presetKey || !rig) return
  rigByPreset.set(presetKey, rig)
}

export function getCharacterRig(
  presetKey: string | undefined | null
): CharacterRig | null {
  if (!presetKey) return null
  return rigByPreset.get(presetKey) ?? null
}

/**
 * 这个对象的 rig。按它的 `userData.characterPreset` 查表；不是内置素体（导入的骨骼模型、
 * 存量数据）时返回 null，调用方退回实测那条路。
 *
 * **不在这里兜底实测**：实测要拿到内容节点、还要保证此刻是绑定姿态，那两条只有加载模板
 * 那一刻成立；运行期的角色随时摆着姿势，就地量出来的是错的。
 */
export function resolveCharacterRig(object: any): CharacterRig | null {
  return getCharacterRig(object?.userData?.characterPreset)
}

/** 只给测试用：生产代码一律经 loadCharacterTemplate 那一次实测写入。 */
export function seedCharacterRig(
  presetKey: string,
  rig: CharacterRig | null
): void {
  if (rig) rigByPreset.set(presetKey, rig)
  else rigByPreset.delete(presetKey)
}
