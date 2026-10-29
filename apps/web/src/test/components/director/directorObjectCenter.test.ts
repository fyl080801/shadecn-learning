import { describe, expect, it } from "vitest"
import * as THREE from "three"

import { snapshotBindPose } from "@/components/three-editor/SkeletonBindPose"
import {
  readAuthored,
  setEvaluated
} from "@/components/three-editor/EvaluatedTransform"

import {
  CENTER_PIVOT_NAME,
  applyObjectCenter,
  createCenterPivot,
  createShapeContainer,
  ensureShapeContainer,
  getObjectCenter,
  getObjectCenterNode,
  getObjectCenterPivot,
  getObjectCenterWorld,
  hasObjectCenter,
  isShapeContainer,
  matchObjectCenterAnchor,
  reapplyObjectCenter,
  resolveObjectCenterAnchor,
  setObjectCenter
} from "@/components/director/directorObjectCenter"

/** 角色的三层结构：wrapper → pivot → content（见 directorAssets.attachCharacterContent）。 */
function characterLike(): {
  wrapper: THREE.Group
  pivot: THREE.Group
  content: THREE.Group
} {
  const wrapper = new THREE.Group()
  const pivot = new THREE.Group()
  pivot.name = CENTER_PIVOT_NAME
  pivot.userData.isCenterPivot = true
  const content = new THREE.Group()
  content.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))
  pivot.add(content)
  wrapper.add(pivot)
  return { wrapper, pivot, content }
}

/** 取一个节点的局部坐标；把 `-0` 归一成 `0`（取负产出的负零与 0 数值相等，只是不深等）。 */
function localPos(object: THREE.Object3D): number[] {
  return object.position.toArray().map((value) => value + 0)
}

function boxMesh(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.BoxGeometry(1, 2, 1),
    new THREE.MeshBasicMaterial()
  )
}

/** 几何的包围盒中心——中心位置落在几何上时用它检验模型确实整体挪了。 */
function geometryCenter(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.geometry.computeBoundingBox()
  return mesh.geometry.boundingBox!.getCenter(new THREE.Vector3())
}

describe("中心位置：读写与缺省", () => {
  it("未设置时为 (0,0,0)，且 hasObjectCenter 为假", () => {
    const mesh = boxMesh()
    expect(hasObjectCenter(mesh)).toBe(false)
    expect(getObjectCenter(mesh)).toEqual({ x: 0, y: 0, z: 0 })
  })

  it("设成 (0,0,0) 与「没设过」是两种状态", () => {
    const mesh = boxMesh()
    setObjectCenter(mesh, { x: 0, y: 0, z: 0 })
    expect(hasObjectCenter(mesh)).toBe(true)
  })
})

describe("中心位置：角色（内层专用节点，绝对写入）", () => {
  it("偏移写在 content 上，pivot 与 wrapper 一概不动", () => {
    const { wrapper, pivot, content } = characterLike()
    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })

    expect(localPos(content)).toEqual([0, -0.9, 0])
    expect(localPos(pivot)).toEqual([0, 0, 0])
    // wrapper 的 position 是用户摆的站位、是 gizmo 的落点，中心位置不许碰它。
    expect(localPos(wrapper)).toEqual([0, 0, 0])
  })

  it("pivot 上的派生变换（脚底吸附/根位移/切线朝向）与中心偏移互不覆盖", () => {
    const { wrapper, pivot, content } = characterLike()
    pivot.position.set(0.3, 0.05, -0.2)
    pivot.rotation.y = Math.PI / 2

    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })

    expect(localPos(pivot)).toEqual([0.3, 0.05, -0.2])
    expect(pivot.rotation.y).toBeCloseTo(Math.PI / 2, 10)
    expect(localPos(content)).toEqual([0, -0.9, 0])
  })

  it("切线朝向转起来时中心点仍留在 wrapper 原点", () => {
    const { wrapper, pivot, content } = characterLike()
    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })
    pivot.rotation.y = Math.PI / 3
    wrapper.updateMatrixWorld(true)

    // 模型上原本位于 center 的那一点（content 局部的 (0,0.9,0)）。
    const point = content.localToWorld(new THREE.Vector3(0, 0.9, 0))
    expect(point.x).toBeCloseTo(0, 10)
    expect(point.y).toBeCloseTo(0, 10)
    expect(point.z).toBeCloseTo(0, 10)
  })

  it("反复设置不累加漂移（绝对写入）", () => {
    const { wrapper, content } = characterLike()
    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })
    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })
    setObjectCenter(wrapper, { x: 0, y: 1.2, z: 0.4 })
    expect(localPos(content)).toEqual([0, -1.2, -0.4])
  })

  it("归零后回到原样", () => {
    const { wrapper, content } = characterLike()
    setObjectCenter(wrapper, { x: 0.5, y: 0.9, z: -0.3 })
    setObjectCenter(wrapper, { x: 0, y: 0, z: 0 })
    expect(localPos(content)).toEqual([0, 0, 0])
  })

  // 中心节点不保证从原点起步：模型自己可能带一段内部偏移（导入的资产不保证根节点在原点
  // 上）。直接 set(−center) 会把那一段抹掉，且归零时也回不来——故与脚底吸附的 poseBaseY、
  // 根位移的 rootMotionBase 一样先抄一份基准。
  it("模型自带内部偏移时，中心位置在它之上叠加而不是把它抹掉", () => {
    const { wrapper, content } = characterLike()
    content.position.set(0, 0.2, 0)

    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })
    expect(content.position.y).toBeCloseTo(0.2 - 0.9, 10)

    setObjectCenter(wrapper, { x: 0, y: 0, z: 0 })
    expect(content.position.y).toBeCloseTo(0.2, 10)
  })

  it("占位阶段（还没有内层节点）不落地，网格换入后补一次即到位", () => {
    const wrapper = new THREE.Group()
    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })
    expect(getObjectCenterNode(wrapper)).toBeNull()

    // 网格换入：建起 pivot → content 两层后补落地。
    const pivot = new THREE.Group()
    pivot.userData.isCenterPivot = true
    const content = new THREE.Group()
    pivot.add(content)
    wrapper.add(pivot)
    reapplyObjectCenter(wrapper)

    expect(localPos(content)).toEqual([0, -0.9, 0])
  })
})

describe("中心位置：普通网格（几何增量平移）", () => {
  it("几何整体反向平移，object.position 不动", () => {
    const mesh = boxMesh()
    setObjectCenter(mesh, { x: 0, y: 1, z: 0 })

    expect(geometryCenter(mesh).y).toBeCloseTo(-1, 10)
    expect(localPos(mesh)).toEqual([0, 0, 0])
  })

  it("连续调整按增量走，来回一趟回到原样", () => {
    const mesh = boxMesh()
    setObjectCenter(mesh, { x: 0, y: 1, z: 0 })
    setObjectCenter(mesh, { x: 0.5, y: 1.5, z: 0 })
    expect(geometryCenter(mesh).x).toBeCloseTo(-0.5, 10)
    expect(geometryCenter(mesh).y).toBeCloseTo(-1.5, 10)

    setObjectCenter(mesh, { x: 0, y: 0, z: 0 })
    expect(geometryCenter(mesh).x).toBeCloseTo(0, 10)
    expect(geometryCenter(mesh).y).toBeCloseTo(0, 10)
  })

  it("子节点跟着一起走，不被拆开", () => {
    const mesh = boxMesh()
    const child = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2))
    child.position.set(0, 1, 0)
    mesh.add(child)

    setObjectCenter(mesh, { x: 0, y: 1, z: 0 })

    expect(geometryCenter(mesh).y).toBeCloseTo(-1, 10)
    expect(child.position.y).toBeCloseTo(0, 10)
  })

  it("applyObjectCenter 不写 userData（序列化要靠它临时还原偏移）", () => {
    const mesh = boxMesh()
    const center = { x: 0, y: 1, z: 0 }
    setObjectCenter(mesh, center)

    // 还原 → 记下的中心位置必须原样保留 → 再落地回去。
    applyObjectCenter(mesh, { x: 0, y: 0, z: 0 }, center)
    expect(geometryCenter(mesh).y).toBeCloseTo(0, 10)
    expect(getObjectCenter(mesh)).toEqual(center)

    applyObjectCenter(mesh, center, { x: 0, y: 0, z: 0 })
    expect(geometryCenter(mesh).y).toBeCloseTo(-1, 10)
  })
})

// 中心偏移对普通网格是**烘焙进顶点**的，故几何一旦被两个对象共用（`Object3D.clone()` 正是
// 共用几何与材质引用），调其中一个的中心会把另一个也拖走。今天没有「复制图形」这个入口，
// 不变式天然成立；加上之后就靠这道检查兜住。
describe("中心位置：复制出来的图形共用几何时不能互相拖动", () => {
  /** 极简 editor 替身：只需要 scene（遍历查引用）与 addGeometry（登记克隆出的那份）。 */
  function fakeEditor() {
    const scene = new THREE.Scene()
    const geometries: Record<string, THREE.BufferGeometry> = {}
    return {
      scene,
      addGeometry: (g: THREE.BufferGeometry) => {
        geometries[g.uuid] = g
      },
      geometries
    }
  }

  it("共用几何时先克隆出自己那份，原件纹丝不动", () => {
    const editor = fakeEditor()
    const original = boxMesh()
    // 复制图形的典型形态：clone() 共用同一个 geometry 实例。
    const copy = original.clone()
    editor.scene.add(original, copy)
    expect(copy.geometry).toBe(original.geometry)

    setObjectCenter(copy, { x: 0, y: 1, z: 0 }, editor)

    expect(copy.geometry).not.toBe(original.geometry)
    expect(geometryCenter(copy).y).toBeCloseTo(-1, 10)
    expect(geometryCenter(original).y).toBeCloseTo(0, 10)
    // 克隆出的那份要登记进编辑器，否则它在几何清单里查无此人。
    expect(editor.geometries[copy.geometry.uuid]).toBe(copy.geometry)
  })

  it("反过来改原件也不会拖动副本（标记 owner 答不了这一种，故按引用查）", () => {
    const editor = fakeEditor()
    const original = boxMesh()
    // 先让原件认领几何、调过一次中心，再复制——这正是 owner 标记漏掉的顺序。
    editor.scene.add(original)
    setObjectCenter(original, { x: 0, y: 1, z: 0 }, editor)

    const copy = original.clone()
    editor.scene.add(copy)
    expect(copy.geometry).toBe(original.geometry)

    setObjectCenter(original, { x: 0, y: 2, z: 0 }, editor)

    expect(geometryCenter(original).y).toBeCloseTo(-2, 10)
    expect(geometryCenter(copy).y).toBeCloseTo(-1, 10)
  })

  it("独占的几何不重复克隆——连续步进不该一步一份", () => {
    const editor = fakeEditor()
    const mesh = boxMesh()
    editor.scene.add(mesh)

    setObjectCenter(mesh, { x: 0, y: 1, z: 0 }, editor)
    const first = mesh.geometry
    setObjectCenter(mesh, { x: 0, y: 1.5, z: 0 }, editor)
    setObjectCenter(mesh, { x: 0, y: 2, z: 0 }, editor)

    expect(mesh.geometry).toBe(first)
    expect(geometryCenter(mesh).y).toBeCloseTo(-2, 10)
  })
})

describe("中心位置：容器（群众分组这类只有子节点的对象）", () => {
  it("直接子节点整体平移", () => {
    const group = new THREE.Group()
    const a = new THREE.Group()
    a.position.set(-1, 0, 0)
    const b = new THREE.Group()
    b.position.set(1, 0, 0)
    group.add(a, b)

    setObjectCenter(group, { x: 0, y: 0.9, z: 0 })

    expect(localPos(a)).toEqual([-1, -0.9, 0])
    expect(localPos(b)).toEqual([1, -0.9, 0])
  })
})

// 世界矩阵交给渲染循环（性能：面板步进器一秒几十次提交，不该每次强刷整棵子树），但**局部**
// 矩阵必须当场刷——`Object3D.toJSON()` 直接读 `this.matrix` 且不会自己重算，而序列化是
// 「改完立刻 toJSON」的同步流程，中间插不进一帧渲染。
describe("矩阵刷新：动过的节点局部矩阵当场更新", () => {
  it("角色的中心节点", () => {
    const { wrapper, content } = characterLike()
    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })
    expect(
      new THREE.Vector3().setFromMatrixPosition(content.matrix).y
    ).toBeCloseTo(-0.9, 10)
  })

  it("容器的子节点", () => {
    const group = new THREE.Group()
    const member = new THREE.Group()
    group.add(member)
    setObjectCenter(group, { x: 0, y: 0.9, z: 0 })
    expect(
      new THREE.Vector3().setFromMatrixPosition(member.matrix).y
    ).toBeCloseTo(-0.9, 10)
  })
})

describe("相对位置逻辑的参照点", () => {
  it("没设过中心位置时按包围盒中心推断（与该属性出现之前一致）", () => {
    const mesh = boxMesh() // 高 2、几何中心在原点
    mesh.position.set(0, 3, 0)
    mesh.updateMatrixWorld(true)

    const point = getObjectCenterWorld(mesh, new THREE.Vector3())
    expect(point.y).toBeCloseTo(3, 10)
  })

  it("设过之后就是对象原点——中心位置的语义正是「把这一点搬到原点」", () => {
    const mesh = boxMesh()
    mesh.position.set(0, 3, 0)
    setObjectCenter(mesh, { x: 0, y: 1, z: 0 })
    mesh.updateMatrixWorld(true)

    const point = getObjectCenterWorld(mesh, new THREE.Vector3())
    expect(point.y).toBeCloseTo(3, 10)
    // 模型此刻整体下移了 1，包围盒中心已在 y=2，参照点却仍钉在原点上。
    const box = new THREE.Box3().setFromObject(mesh)
    expect(box.getCenter(new THREE.Vector3()).y).toBeCloseTo(2, 10)
  })

  it("包围盒为空（未换入网格的占位容器）退到对象原点", () => {
    const empty = new THREE.Group()
    empty.position.set(1, 2, 3)
    empty.updateMatrixWorld(true)
    expect(getObjectCenterWorld(empty, new THREE.Vector3()).toArray()).toEqual([
      1, 2, 3
    ])
  })
})

describe("三层装配（root → pivot → content）", () => {
  // 角色一直是这个形状，几何体此前不是——差别导致中心位置走了两条不同的落地路径，而
  // 轨迹切线朝向干脆对几何体不生效。装配统一之后，「支不支持这些派生变换」由装配回答。
  it("createShapeContainer 把模型包成三层，且身份（名字/站位）搬到根上", () => {
    const mesh = boxMesh()
    mesh.name = "立方体"
    mesh.position.set(1, 2, 3)
    mesh.rotation.y = Math.PI / 2
    mesh.scale.setScalar(2)

    const root = createShapeContainer(mesh)

    expect(isShapeContainer(root)).toBe(true)
    expect(root.name).toBe("立方体")
    expect(localPos(root)).toEqual([1, 2, 3])
    expect(root.scale.x).toBe(2)
    expect(root.rotation.y).toBeCloseTo(Math.PI / 2, 10)
    // 内容只剩「模型长什么样」：变换归零，站位是根的事。
    expect(localPos(mesh)).toEqual([0, 0, 0])
    expect(mesh.scale.x).toBe(1)
    // 中间那层正是承载中心偏移/切线朝向的 pivot。
    expect(getObjectCenterPivot(root)?.userData.isCenterPivot).toBe(true)
    expect(getObjectCenterNode(root)).toBe(mesh)
  })

  // uuid 是时间轴轨道、锁定态、机位跟随寻址对象的钥匙：迁移时换掉它，旧场景打开后
  // 动画会整份与对象脱钩。
  it("ensureShapeContainer 迁移存量裸网格：uuid 与 userData 跟着搬到新根上", () => {
    const mesh = boxMesh()
    mesh.name = "球体"
    mesh.userData.center = { x: 0, y: 1, z: 0 }
    const uuid = mesh.uuid

    const root = ensureShapeContainer(mesh)

    expect(root).not.toBe(mesh)
    expect(root.uuid).toBe(uuid)
    expect(mesh.uuid).not.toBe(uuid)
    expect(getObjectCenter(root)).toEqual({ x: 0, y: 1, z: 0 })
    expect(hasObjectCenter(mesh)).toBe(false)
    expect(getObjectCenterNode(root)).toBe(mesh)
  })

  // 两层都留着 false 的话，用户在属性面板上把它打开，画面上仍旧什么也没有。
  it("隐藏着的对象迁移后，可见性归根管、内层放开", () => {
    const mesh = boxMesh()
    mesh.visible = false
    const root = ensureShapeContainer(mesh)

    expect(root.visible).toBe(false)
    expect(mesh.visible).toBe(true)
    root.visible = true
    expect(getObjectCenterNode(root).visible).toBe(true)
  })

  it("ensureShapeContainer 对已经是三层的对象原样返回（重复恢复不叠层）", () => {
    const root = createShapeContainer(boxMesh())
    expect(ensureShapeContainer(root)).toBe(root)
    // 角色（有 pivot 但没有 isShapeContainer 标记）同样不该被再包一层。
    const { wrapper } = characterLike()
    expect(ensureShapeContainer(wrapper)).toBe(wrapper)
  })

  // 迁移后中心位置走的是 pivot 那条「绝对写入内容节点」的路，不再烘焙进顶点。存下来的
  // 数据是「没有偏移」的形态，故迁移 → 落地一次的结果必须与老路径看到的一样。
  it("迁移后的对象按 userData 落地中心位置，落在内容节点的 position 上", () => {
    const mesh = boxMesh()
    mesh.userData.center = { x: 0, y: 1, z: 0 }
    const root = ensureShapeContainer(mesh)

    reapplyObjectCenter(root)

    expect(localPos(mesh)).toEqual([0, -1, 0])
    // 顶点没有被动过——它此后只归模型自己管。
    expect(geometryCenter(mesh).y).toBeCloseTo(0, 10)
    root.updateMatrixWorld(true)
    expect(getObjectCenterWorld(root, new THREE.Vector3()).toArray()).toEqual([
      0, 0, 0
    ])
  })
})

describe("中心基准（底部 / 中心）", () => {
  /**
   * 「脚底在原点、身子在上面」的模型——角色的装配就是这样。基准要回答的正是「模型的哪一处
   * 压在对象原点上」，而那决定了沿轨迹走时看着在不在线上。
   */
  function standing(): { root: THREE.Group; mesh: THREE.Mesh } {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 2, 0.4).translate(0, 1, 0),
      new THREE.MeshBasicMaterial()
    )
    return { root: createShapeContainer(mesh), mesh }
  }

  it("底部即包围盒底面中心，中心即包围盒中心", () => {
    const { root } = standing()
    expect(resolveObjectCenterAnchor(root, "bottom")).toEqual({
      x: 0,
      y: 0,
      z: 0
    })
    expect(resolveObjectCenterAnchor(root, "center")).toEqual({
      x: 0,
      y: 1,
      z: 0
    })
  })

  // 这条就是需求的落点：选「中心」之后，模型的中间压在对象原点上，而原点正是贴着轨迹走
  // 的那一点，于是身子压在线上、转身也绕着身子中间发生。
  it("选「中心」后模型中间落在对象原点上", () => {
    const { root } = standing()
    setObjectCenter(root, resolveObjectCenterAnchor(root, "center")!)
    root.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(root)
    expect(box.getCenter(new THREE.Vector3()).toArray()).toEqual([0, 0, 0])
    // 原点没有被这次内部调整挪动——它是内外两套坐标系的交接点。
    expect(localPos(root)).toEqual([0, 0, 0])
  })

  it("选「底部」后模型底面落在对象原点上（= 角色的既有观感）", () => {
    const { root } = standing()
    setObjectCenter(root, resolveObjectCenterAnchor(root, "center")!)
    setObjectCenter(root, resolveObjectCenterAnchor(root, "bottom")!)
    root.updateMatrixWorld(true)

    expect(new THREE.Box3().setFromObject(root).min.y).toBeCloseTo(0, 10)
  })

  // 面板据此高亮当前是哪个基准；手调过 xyz 就落回「自定义」（同手型预设的判定口径）。
  it("回读当前落在哪个基准上，都对不上即 null", () => {
    const { root } = standing()
    expect(matchObjectCenterAnchor(root)).toBe("bottom")

    setObjectCenter(root, resolveObjectCenterAnchor(root, "center")!)
    expect(matchObjectCenterAnchor(root)).toBe("center")

    setObjectCenter(root, { x: 0, y: 0.37, z: 0 })
    expect(matchObjectCenterAnchor(root)).toBeNull()
  })

  // 反复在两个基准之间切换必须收敛到同样两个取值：换算要么读模型自己的坐标（有内容节点），
  // 要么把已应用的那一份加回去（偏移烘焙在内容里），错一处就会每切一次远一点。
  it("来回切换不漂移", () => {
    const { root } = standing()
    for (let i = 0; i < 4; i++) {
      setObjectCenter(root, resolveObjectCenterAnchor(root, "center")!)
      expect(getObjectCenter(root)).toEqual({ x: 0, y: 1, z: 0 })
      setObjectCenter(root, resolveObjectCenterAnchor(root, "bottom")!)
      expect(getObjectCenter(root)).toEqual({ x: 0, y: 0, z: 0 })
    }
  })

  // 偏移烘焙在几何里的形态（没有内容节点的存量对象、群众分组）走的是另一条换算。
  it("没有内容节点时同样收敛（偏移烘焙在几何里）", () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 2, 0.4).translate(0, 1, 0),
      new THREE.MeshBasicMaterial()
    )
    expect(resolveObjectCenterAnchor(mesh, "center")).toEqual({
      x: 0,
      y: 1,
      z: 0
    })

    setObjectCenter(mesh, resolveObjectCenterAnchor(mesh, "center")!)
    expect(matchObjectCenterAnchor(mesh)).toBe("center")
    setObjectCenter(mesh, resolveObjectCenterAnchor(mesh, "bottom")!)
    expect(getObjectCenter(mesh)).toEqual({ x: 0, y: 0, z: 0 })
  })

  /**
   * 角色的真实形态：内容节点上带着 FBX 的 0.01 单位缩放（applyFBXUnitScale），故它自己的
   * 局部坐标是**厘米**。中心位置写的是 `content.position`，活在 pivot 那一层（米），两者
   * 差 100 倍——量错空间的表现就是「一选中心基准，模型直接飞到几十米外」。
   */
  it("内容节点带单位缩放时，基准仍以对象所在的那一层（米）给出", () => {
    const wrapper = new THREE.Group()
    const pivot = createCenterPivot()
    const content = new THREE.Group()
    // 200 单位高的模型 × 0.01 = 2m，脚底在原点。
    content.add(
      new THREE.Mesh(new THREE.BoxGeometry(40, 200, 40).translate(0, 100, 0))
    )
    content.scale.setScalar(0.01)
    pivot.add(content)
    wrapper.add(pivot)

    expect(resolveObjectCenterAnchor(wrapper, "center")).toEqual({
      x: 0,
      y: 1,
      z: 0
    })
    expect(resolveObjectCenterAnchor(wrapper, "bottom")).toEqual({
      x: 0,
      y: 0,
      z: 0
    })

    // 落地之后模型确实居中，且原点没动。
    setObjectCenter(wrapper, resolveObjectCenterAnchor(wrapper, "center")!)
    wrapper.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(wrapper)
    expect(box.getCenter(new THREE.Vector3()).y).toBeCloseTo(0, 10)
    expect(localPos(wrapper)).toEqual([0, 0, 0])
    expect(matchObjectCenterAnchor(wrapper)).toBe("center")
  })

  // 承载层上还压着脚底吸附/动作根位移/切线朝向那些派生变换：它们不该掺进基准的换算。
  it("承载层的派生变换不影响量出来的基准", () => {
    const wrapper = new THREE.Group()
    const pivot = createCenterPivot()
    const content = new THREE.Group()
    content.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.4, 2, 0.4).translate(0, 1, 0))
    )
    pivot.add(content)
    wrapper.add(pivot)
    // 脚底吸附的竖向补偿 + 切线朝向转过的角度。
    pivot.position.set(0.2, 0.05, -0.3)
    pivot.rotation.y = Math.PI / 3

    // 转过的角度会让世界包围盒往返一次带上浮点噪声，故按分量给容差。
    const resolved = resolveObjectCenterAnchor(wrapper, "center")!
    expect(resolved.x).toBeCloseTo(0, 9)
    expect(resolved.y).toBeCloseTo(1, 9)
    expect(resolved.z).toBeCloseTo(0, 9)
  })

  // 需求原话：「即使物体旋转了，也应该以旋转中心」。基准量的是**模型自己的形状**，与对象
  // 在世界里转成什么姿态无关——躺下、侧身都不该改变「哪一处压在原点上」这个答案。
  it("基准不随对象的旋转变化（横竖都一样）", () => {
    const { root } = standing()
    const upright = {
      bottom: resolveObjectCenterAnchor(root, "bottom")!,
      center: resolveObjectCenterAnchor(root, "center")!
    }

    for (const euler of [
      [Math.PI / 2, 0, 0],
      [0, Math.PI / 4, 0],
      [0, 0, Math.PI / 2],
      [0.7, 1.1, -0.4]
    ]) {
      root.rotation.set(euler[0]!, euler[1]!, euler[2]!)
      root.updateMatrixWorld(true)
      for (const anchor of ["bottom", "center"] as const) {
        const value = resolveObjectCenterAnchor(root, anchor)!
        expect(value.x).toBeCloseTo(upright[anchor].x, 9)
        expect(value.y).toBeCloseTo(upright[anchor].y, 9)
        expect(value.z).toBeCloseTo(upright[anchor].z, 9)
      }
    }
  })

  /**
   * 换基准时那次「让模型看着不动」的补偿，要落在 **authored** 位置上，故转它的旋转也必须
   * 是 authored 的那一份。
   *
   * 拿节点上的合成值转，等于把**那一帧**的切线角永久烙进一个静态的补偿量里：开着朝向对齐
   * 的角色，若换基准时播放头正停在轨迹片段内，片段之外它会被平移 (R_切线 − I)·S·Δ。
   * 而「片段之外仍是对的」正是这条补偿写在注释里的承诺（片段之内本就补了也白补）。
   */
  it("换基准的补偿按 authored 朝向算，不受轨迹切线角影响", () => {
    const build = () => {
      const root = new THREE.Group()
      const pivot = createCenterPivot()
      const content = new THREE.Group()
      // 模型**偏在一侧**：中心基准的位移因此带水平分量。纯竖直的位移绕 Y 转不变，
      // 拿它来验这条会得到一个恒真的用例。
      content.add(
        new THREE.Mesh(new THREE.BoxGeometry(0.4, 2, 0.4).translate(0.5, 1, 0))
      )
      pivot.add(content)
      root.add(pivot)
      // 用户把角色摆成朝 +X（authored 朝向）。
      root.rotation.y = Math.PI / 2
      root.updateMatrixWorld(true)
      return root
    }

    const plain = build()
    const oriented = build()
    // 这一具身上压着一份轨迹切线朝向（求值层的 offset，逐帧都在变）。
    setEvaluated(
      oriented,
      "motionTangent",
      "quaternion",
      new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0, Math.PI / 2, 0))
        .toArray()
    )

    // 补偿只在**用户编辑**那一路发生（与几何独占同一道 editor 闸门），故必须递 editor
    // ——不递的话这条用例根本走不到 compensateCenterShift，会恒真。
    const editor = { scene: new THREE.Scene(), addGeometry: () => {} }
    const center = resolveObjectCenterAnchor(plain, "center")!
    setObjectCenter(plain, center, editor)
    setObjectCenter(oriented, center, editor)

    // 两具的 authored 位置必须逐分量相同：切线角是派生量，不该改变这次补偿。
    const a = readAuthored(plain, "position")
    const b = readAuthored(oriented, "position")
    expect(b[0]).toBeCloseTo(a[0]!, 9)
    expect(b[1]).toBeCloseTo(a[1]!, 9)
    expect(b[2]).toBeCloseTo(a[2]!, 9)

    setEvaluated(oriented, "motionTangent", "quaternion", null)
  })

  it("量不出尺寸（网格尚未换入）时给不出基准", () => {
    expect(resolveObjectCenterAnchor(new THREE.Group(), "center")).toBeNull()
    expect(matchObjectCenterAnchor(new THREE.Group())).toBeNull()
  })
})

describe("骨骼模型的锚点 —— 从骨架取，不从包围盒取", () => {
  /**
   * 角色的最小骨架：content → Hips(0.9) → Foot(相对 Hips −0.85，即脚在 0.05)。
   * 网格照常挂着，用来验证「有骨架时不看包围盒」。
   */
  async function skinned() {
    const wrapper = new THREE.Group()
    const pivot = createCenterPivot()
    const content = new THREE.Group()
    const hips = new THREE.Bone()
    hips.position.set(0, 0.9, 0)
    const foot = new THREE.Bone()
    foot.position.set(0, -0.85, 0)
    hips.add(foot)
    // 包围盒会把这个网格算进去；有骨架时它不该影响锚点。
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1).translate(0, 5, 0)
    )
    content.add(hips, mesh)
    pivot.add(content)
    wrapper.add(pivot)
    wrapper.updateMatrixWorld(true)
    await snapshotBindPose(wrapper)
    return { wrapper, hips, foot }
  }

  it("中心取根骨骼、底部取最低骨骼（包围盒不参与）", async () => {
    const { wrapper } = await skinned()
    expect(resolveObjectCenterAnchor(wrapper, "center")).toEqual({
      x: 0,
      y: 0.9,
      z: 0
    })
    const bottom = resolveObjectCenterAnchor(wrapper, "bottom")!
    expect(bottom.y).toBeCloseTo(0.05, 10)
  })

  // 本轮要修的那个现象：调完姿势，中心和底部都偏了。姿势只旋转骨骼，锚点按绑定姿态算，
  // 故两个基准都必须纹丝不动。
  it("调整姿势后两个基准都不变", async () => {
    const { wrapper, hips, foot } = await skinned()
    const before = {
      bottom: resolveObjectCenterAnchor(wrapper, "bottom")!,
      center: resolveObjectCenterAnchor(wrapper, "center")!
    }

    // 躺下（转髋）+ 抬腿（转脚）：按当前姿势量的话，最低骨骼会被抬到 0.9 附近。
    hips.quaternion.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
    foot.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 3, 0, 0))
    wrapper.updateMatrixWorld(true)

    for (const anchor of ["bottom", "center"] as const) {
      const after = resolveObjectCenterAnchor(wrapper, anchor)!
      expect(after.x).toBeCloseTo(before[anchor].x, 10)
      expect(after.y).toBeCloseTo(before[anchor].y, 10)
      expect(after.z).toBeCloseTo(before[anchor].z, 10)
    }
  })

  // 承载层上压着脚底吸附的竖向补偿：它把整具网格上下推，但不该改变「原点该对应骨架上
  // 哪一点」这个答案。
  it("脚底吸附的补偿不影响锚点", async () => {
    const { wrapper } = await skinned()
    const before = resolveObjectCenterAnchor(wrapper, "center")!

    getObjectCenterPivot(wrapper)!.position.set(0, 0.13, 0)
    wrapper.updateMatrixWorld(true)

    expect(resolveObjectCenterAnchor(wrapper, "center")!.y).toBeCloseTo(
      before.y,
      10
    )
  })

  it("没有骨骼的刚体仍走包围盒", () => {
    const root = createShapeContainer(
      new THREE.Mesh(new THREE.BoxGeometry(0.4, 2, 0.4).translate(0, 1, 0))
    )
    expect(resolveObjectCenterAnchor(root, "center")).toEqual({
      x: 0,
      y: 1,
      z: 0
    })
  })
})
