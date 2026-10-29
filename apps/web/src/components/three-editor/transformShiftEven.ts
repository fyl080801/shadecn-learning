import { Quaternion, Vector3 } from "three"

/**
 * 变换 gizmo 的「按住 Shift 让两个轴等量变化」——单点源。
 *
 * 作用对象是**平面手柄**（XY / YZ / XZ）：拖它本来就同时改两个轴，但两轴各走各的，
 * 移动时拖出来的方向随手一歪就不齐、缩放时两轴倍率不同即把图形拉变形。按住 Shift 即把这
 * 一趟约束成「两轴同量」：
 *
 *   · **移动**——两轴的位移量相等（把位移正交投影到那个平面的 45° 对角线上，象限仍随指针，
 *     故往哪个角上拖就往哪个角上走）。这与上游单轴手柄的做法同构：它把其余分量归零，也就是
 *     把位移正交投影到那根轴上。
 *   · **缩放**——两轴同一个倍率（取平面内两分量的**径向**比值，与 three 自己 `XYZ` 那个等比
 *     手柄同款；负向即镜像，同样照它的口径保留）。
 *
 * 落法只有一件事：**改写平面命中点**。上游每次 `pointerMove` 都拿「射线 ∩ 内部平面」当
 * `pointEnd`，我们在那一步把命中点挪到约束之后该在的位置上，此后整条链路（world/local 空间
 * 换算、`translationSnap`、min/max 夹取、写 position/scale、派发 change/objectChange）**一个
 * 字都不改**，故 Shift 之下的手感与平面手柄逐位同源。
 * **不要**改成「自己算位移/倍率再写 object」：那等于在平面手柄之外再养一套变换数学，两处必然
 * 分叉（上游那一段还含 `_parentScale`、`_quaternionStart` 这些容易漏的换算）。
 * 也**不要**改成「让上游先写一遍、我们再纠正」：上游写完当场就派发 objectChange，自动关键帧、
 * 属性面板回填、群众分组间距预览都会先吃到一份没约束过的值，然后再被纠正一次——一次指针移动
 * 落成两轮扇出，而中间那一轮的值是错的。
 *
 * 另外三条：
 *   · **按下手柄那一刻的锚点不受约束**（`dragging` 为假时整个不插手）：约束是相对起点定义的，
 *     起点自己被挪过就无从谈起。
 *   · 拖动中**按/松随时生效**：按下去当场按当前指针位置重跑一次 `pointerMove`，不必等下一次
 *     指针移动（否则用户按了 Shift 看不到任何反应，会以为没生效）。约束是「相对起点」的纯函数，
 *     故按下即跳到对角线上、松开即回到指针处，两个方向都不残留状态。
 *   · **单轴手柄与 `XYZ`/`E` 一律不插手**：前者只有一个轴、后者本来就是等比。
 */

/** 平面手柄的两个轴（顺序与 axis 串一致）。 */
export type EvenPlaneAxis = "XY" | "YZ" | "XZ"

type Component = "x" | "y" | "z"

const PLANE_COMPONENTS: Record<EvenPlaneAxis, [Component, Component]> = {
  XY: ["x", "y"],
  YZ: ["y", "z"],
  XZ: ["x", "z"]
}

/** 起点与原点重合到这个程度就给不出倍率了（缩放那一支）。 */
const MIN_SCALE_RADIUS = 1e-6

/** axis 串是平面手柄吗（其余一律不插手）。 */
export function readPlaneAxis(
  axis: string | null | undefined
): EvenPlaneAxis | null {
  return axis === "XY" || axis === "YZ" || axis === "XZ" ? axis : null
}

/**
 * 移动：把平面内的位移 (a, b) 约束成两轴同量。
 *
 * 取的是**正交投影到 45° 对角线**（量 = 两者绝对值的平均），而不是「取较大的那一个」：
 * 后者会让对象跑得比指针远——横向拖 100、纵向拖 0 时两轴各走 100，用户按下 Shift 的那一瞬
 * 图形就窜出去一截。投影则与上游单轴手柄同构（它把其余分量归零，也是正交投影）。
 *
 * 象限按各自的符号取，故往哪个角上拖就往哪个角上走（两轴符号相反时走的是另一条对角线）。
 */
export function evenTranslateDelta(a: number, b: number): [number, number] {
  const size = (Math.abs(a) + Math.abs(b)) / 2
  return [a < 0 ? -size : size, b < 0 ? -size : size]
}

/**
 * 缩放：平面内两分量的等比倍率（null = 起点贴着原点，给不出比值）。
 *
 * 口径照搬 three 自己 `XYZ` 等比手柄那一段：取径向长度之比，起终点反向时取负（镜像）。
 */
export function evenScaleRatio(
  startA: number,
  startB: number,
  endA: number,
  endB: number
): number | null {
  const startRadius = Math.hypot(startA, startB)
  if (startRadius < MIN_SCALE_RADIUS) return null
  const ratio = Math.hypot(endA, endB) / startRadius
  return startA * endA + startB * endB < 0 ? -ratio : ratio
}

// ————————————————————————————————————————————————————————
// Shift 与指针位置的共享跟踪
// ————————————————————————————————————————————————————————
//
// 按键事件本身不带坐标，而「按下 Shift 当场重跑一次」要知道指针在哪，故位置由指针事件一路
// 记下来。一份跟踪供全部 gizmo 实例共用（导演台里同时有三四个），只记模块级的几个数、不引用
// 任何 gizmo/Editor，故装上就不再摘——**实例那一侧的订阅反过来只在拖动期间存在**：`Viewport`
// 创建的对象 gizmo 没有任何 teardown 钩子（它只返回容器），订阅若挂满整个实例生命周期，导演台
// 每开关一次就在订阅表里留下一个引用着旧 Editor 的闭包。

let trackingInstalled = false
let shiftHeld = false
let pointerX = 0
let pointerY = 0
let pointerKnown = false

type ShiftListener = (held: boolean) => void
const shiftListeners = new Set<ShiftListener>()

function setShiftHeld(held: boolean): void {
  if (held === shiftHeld) return
  shiftHeld = held
  // 回调里可能改动订阅表（拖动结束顺带退订），故先抄一份。
  for (const listener of [...shiftListeners]) listener(held)
}

function onWindowKey(event: KeyboardEvent): void {
  setShiftHeld(event.shiftKey)
}

function onWindowBlur(): void {
  // 焦点丢了就再也收不到 keyup，按住的状态得当场作废。
  setShiftHeld(false)
}

function onWindowPointer(event: PointerEvent): void {
  pointerX = event.clientX
  pointerY = event.clientY
  pointerKnown = true
  // 指针事件也带 shiftKey：在窗口外按下 Shift 再回来时靠它补上。
  setShiftHeld(event.shiftKey)
}

function installTracking(): void {
  if (trackingInstalled || typeof window === "undefined") return
  trackingInstalled = true
  // 捕获阶段：Shift 是修饰键，不该被沿途某个 stopPropagation 吃掉。
  window.addEventListener("keydown", onWindowKey, true)
  window.addEventListener("keyup", onWindowKey, true)
  window.addEventListener("blur", onWindowBlur)
  window.addEventListener("pointerdown", onWindowPointer, true)
  window.addEventListener("pointermove", onWindowPointer, true)
}

// ————————————————————————————————————————————————————————
// 挂到一个 TransformControls 实例上
// ————————————————————————————————————————————————————————

/** TransformControls 上我们要读的那些字段（带下划线的几个在 three 的类型里是私有的）。 */
interface EvenControls {
  axis: string | null
  mode: "translate" | "rotate" | "scale"
  space: "world" | "local"
  dragging: boolean
  camera: any
  object?: any
  domElement: HTMLElement | null
  worldQuaternion: Quaternion
  worldPositionStart: Vector3
  pointStart: Vector3
  _plane: any
  _worldQuaternionInv: Quaternion
  pointerMove(pointer: { x: number; y: number; button: number } | null): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/**
 * 给一个变换 gizmo 装上「按住 Shift 让平面手柄的两轴等量变化」。返回卸载函数。
 *
 * 挂在**每一个**能移动/缩放的 gizmo 上：对象本体（Viewport）、轨迹路径点与整条轨迹、机位
 * 注视装置的两个手柄。关节 gizmo 只有旋转，装了也是空转，故不装。
 */
export function enableTransformShiftEven(controls: unknown): () => void {
  const tc = controls as EvenControls
  const plane = tc._plane
  const point = new Vector3()
  const start = new Vector3()

  /** 这一刻要不要约束：正拖着一个平面手柄、按着 Shift、且是移动或缩放。 */
  function activePlaneAxis(): EvenPlaneAxis | null {
    if (!shiftHeld || !tc.dragging) return null
    if (tc.mode !== "translate" && tc.mode !== "scale") return null
    return readPlaneAxis(tc.axis)
  }

  /**
   * 把平面命中点挪到约束之后该在的位置上（就地改写）。
   *
   * 换算进的是**手柄所在的那个轴空间**，与上游同一条判断：缩放恒按对象自身的轴
   * （`_worldQuaternionInv`），移动看 space。
   */
  function constrain(hit: Vector3, axis: EvenPlaneAxis): void {
    const local = tc.mode === "scale" || tc.space === "local"

    point.copy(hit).sub(tc.worldPositionStart)
    start.copy(tc.pointStart)
    if (local) {
      point.applyQuaternion(tc._worldQuaternionInv)
      start.applyQuaternion(tc._worldQuaternionInv)
    }

    const [ka, kb] = PLANE_COMPONENTS[axis]
    if (tc.mode === "translate") {
      const [da, db] = evenTranslateDelta(
        point[ka] - start[ka],
        point[kb] - start[kb]
      )
      point[ka] = start[ka] + da
      point[kb] = start[kb] + db
    } else {
      const ratio = evenScaleRatio(start[ka], start[kb], point[ka], point[kb])
      if (ratio === null) return
      point[ka] = start[ka] * ratio
      point[kb] = start[kb] * ratio
    }

    if (local) point.applyQuaternion(tc.worldQuaternion)
    hit.copy(point).add(tc.worldPositionStart)
  }

  const originalRaycast = plane.raycast
  plane.raycast = function (raycaster: any, intersects: any[]): void {
    const before = intersects.length
    originalRaycast.call(this, raycaster, intersects)
    const axis = activePlaneAxis()
    if (!axis) return
    for (let i = before; i < intersects.length; i++)
      constrain(intersects[i].point, axis)
  }

  /** 指针的 NDC 坐标，算法与 TransformControls 的 getPointer 一致。 */
  function pointerNdc(): { x: number; y: number; button: number } | null {
    const dom = tc.domElement
    if (!dom || !pointerKnown) return null
    if (dom.ownerDocument?.pointerLockElement) return { x: 0, y: 0, button: -1 }
    const rect = dom.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return {
      x: ((pointerX - rect.left) / rect.width) * 2 - 1,
      y: -((pointerY - rect.top) / rect.height) * 2 + 1,
      button: -1
    }
  }

  /** 按/松那一下当场重跑一次，不必等下一次指针移动。 */
  function onShiftChanged(): void {
    if (!tc.dragging || !readPlaneAxis(tc.axis)) return
    const pointer = pointerNdc()
    if (!pointer) return
    tc.pointerMove(pointer)
  }

  function onMouseDown(): void {
    // 只有抓着平面手柄的那些拖动才需要听 Shift。
    if (!readPlaneAxis(tc.axis)) return
    shiftListeners.add(onShiftChanged)
  }

  function onMouseUp(): void {
    shiftListeners.delete(onShiftChanged)
  }

  installTracking()
  tc.addEventListener("mouseDown", onMouseDown)
  tc.addEventListener("mouseUp", onMouseUp)

  return () => {
    tc.removeEventListener("mouseDown", onMouseDown)
    tc.removeEventListener("mouseUp", onMouseUp)
    shiftListeners.delete(onShiftChanged)
    plane.raycast = originalRaycast
  }
}
