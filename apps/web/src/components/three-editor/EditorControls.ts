import * as THREE from "three"

// 轨道导航的三件事——绕哪儿转、拖多快、朝哪儿推——**共用同一个参考深度**：
// 指针下方那个东西所在的深度。这是本控制器唯一的手感基准，别再各算各的。
//
// 单点源是 `center`（轨道中心，恒在视线轴上，见下方不变式）：
//   · 左键旋转 → 绕它转（`rotate`）；
//   · 右键平移 → 按它的深度做屏幕像素 1:1 映射（`pan`）；
//   · 滚轮缩放 → 朝指针下方那一点推拉，推完把它按同一倍率留在轴上（`zoom`）。
// 手势起手时（pointerdown / wheel）先经 `pickPoint` 把指针下方的世界点解析出来，
// 把 `center` 的**深度**对到那一点上，三件事于是自动一致。
//
// **不变式：`center` 始终落在相机视线轴上**（= 相机永远正对着它）。`rotate` 末尾的
// `object.lookAt(center)`、`Editor.setCameraType` 的取景换算、导航罗盘的绕轴动画
// （DirectorViewHelper 与它共享同一个 center 引用）都依赖这一条。故 `zoom` 把相机
// 朝离轴的光标点推过去之后，必须把 center 重新投影回新的视线轴上——**不要**改成
// 「直接把 center 设成命中点」，那样第一次旋转会把画面猛地扭向那个点。
//
// 历史：此前 center 只有右键平移与双击聚焦会改，滚轮与点选都不动它，于是它长期停在
// 世界原点。派生出两个现象：①左键旋转绕的是一个与画面内容无关的固定点；②右键平移
// 速度按「到原点的距离」标定，而滚轮沿视线推近改变的是「到原点的距离」而非「到你正
// 看着那个东西的距离」，两者比值随缩放漂移，于是缩放前后平移手感对不上（原点离得远
// 时还会出现「怎么滚都推不到模型跟前」——滚轮朝 center 逼近，被 minDistance 卡住）。
class EditorControls extends THREE.EventDispatcher<Record<string, any>> {
  enabled: boolean
  center: THREE.Vector3
  panSpeed: number
  zoomSpeed: number
  rotationSpeed: number
  minDistance: number
  maxDistance: number
  minZoom: number
  maxZoom: number

  /**
   * 把屏幕坐标解析成场景里的一个世界点（射线命中），由消费方注入——本控制器不认识
   * 场景，也不该认识（Viewport 才持有 selector/地面/视口相机，见其 `controls.pickPoint`
   * 赋值处）。返回 null 表示指针下方什么也没有，此时各手势退回当前轨道中心的深度，
   * 即注入之前的原有行为。
   */
  pickPoint: ((clientX: number, clientY: number) => THREE.Vector3 | null) | null

  setCamera: (camera: any) => void
  focus: (target: any) => void
  pan: (delta: THREE.Vector3) => void
  zoom: (delta: THREE.Vector3, focusPoint?: THREE.Vector3 | null) => void
  rotate: (delta: THREE.Vector3) => void
  connect: (element: any) => void
  disconnect: () => void

  constructor(object: any) {
    super()

    // API

    this.enabled = true
    this.center = new THREE.Vector3()
    this.panSpeed = 0.002
    this.zoomSpeed = 0.1
    this.rotationSpeed = 0.005

    // 滚轮/触摸缩放的距离（透视相机）与 zoom 值（正交相机）范围，
    // 默认不限制；消费方（如 director）按场景尺度设置合适范围。
    this.minDistance = 0
    this.maxDistance = Infinity
    this.minZoom = 0.0001
    this.maxZoom = Infinity

    this.pickPoint = null

    // 内部实现

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- scope 被大量嵌套的 function 声明（事件处理等）闭包使用，且部分作为 DOM 回调需要自身 this，无法统一改为箭头函数
    const scope = this
    const vector = new THREE.Vector3()
    const delta = new THREE.Vector3()
    const box = new THREE.Box3()

    // 轨道中心的最小深度：贴到相机上时视线方向无从谈起，旋转也退化成原地打转。
    const MIN_CENTER_DEPTH = 0.001

    const _forward = new THREE.Vector3()
    const _offset = new THREE.Vector3()
    const _focus = new THREE.Vector3()

    const STATE = { NONE: -1, ROTATE: 0, ZOOM: 1, PAN: 2 }
    let state = STATE.NONE

    const center = this.center
    const normalMatrix = new THREE.Matrix3()
    const pointer = new THREE.Vector2()
    const pointerOld = new THREE.Vector2()
    const spherical = new THREE.Spherical()
    const sphere = new THREE.Sphere()

    const pointers: any[] = []
    const pointerPositions: Record<string, any> = {}

    let domElement: any = null

    // 事件

    const changeEvent = { type: "change" }

    // 相机视线前方单位向量（本地 -Z 经四元数变换）。
    function cameraForward(): THREE.Vector3 {
      return _forward.set(0, 0, -1).applyQuaternion(object.quaternion)
    }

    // 世界点的**视线深度**：它在视线方向上的投影距离（= 它所在的那个与视线垂直的
    // 平面离相机多远）。屏幕像素 1:1 映射要的正是这个量，而不是到该点的直线距离
    // ——光标在画面边缘时两者能差出十几个百分点。
    function viewDepth(point: THREE.Vector3): number {
      return cameraForward().dot(_offset.copy(point).sub(object.position))
    }

    // 把轨道中心挪到视线轴上的指定深度处（方向不变，故相机仍正对着它，见类注释的不变式）。
    function setCenterDepth(depth: number) {
      center
        .copy(object.position)
        .addScaledVector(cameraForward(), Math.max(depth, MIN_CENTER_DEPTH))
    }

    // 指针下方那一点（重复解析的缓存收在注入方，见 Viewport 的 pickViewportPoint）。
    function pickAt(clientX: number, clientY: number): THREE.Vector3 | null {
      return scope.pickPoint ? scope.pickPoint(clientX, clientY) : null
    }

    // 手势起手：把轨道中心的深度对到指针下方那个东西上，于是本次旋转绕它转、
    // 本次平移也按它的深度做 1:1 映射。指针下方什么也没有时保持原样。
    function focusCenterAt(clientX: number, clientY: number) {
      const point = pickAt(clientX, clientY)
      if (point === null) return

      const depth = viewDepth(point)
      if (depth > MIN_CENTER_DEPTH) setCenterDepth(depth)
    }

    this.setCamera = function (camera: any) {
      object = camera
    }

    this.focus = function (target: any) {
      let distance

      box.setFromObject(target)

      if (box.isEmpty() === false) {
        box.getCenter(center)
        distance = box.getBoundingSphere(sphere).radius
      } else {
        // 聚焦于 Group、AmbientLight 等

        center.setFromMatrixPosition(target.matrixWorld)
        distance = 0.1
      }

      delta.set(0, 0, 1)
      delta.applyQuaternion(object.quaternion)
      delta.multiplyScalar(distance * 4)

      object.position.copy(center).add(delta)

      if (object.isOrthographicCamera) {
        object.zoom = (object.top - object.bottom) / (distance * 2)
        object.updateProjectionMatrix()
      }

      scope.dispatchEvent(changeEvent)
    }

    this.pan = function (delta: THREE.Vector3) {
      const elementHeight = domElement ? domElement.clientHeight : 0

      let panSpeed
      if (!elementHeight) {
        // 未连接到元素时的回退处理
        const distance = object.isOrthographicCamera
          ? (object.top - object.bottom) / object.zoom
          : object.position.distanceTo(center)
        panSpeed = distance * scope.panSpeed
      } else if (object.isOrthographicCamera) {
        panSpeed = (object.top - object.bottom) / object.zoom / elementHeight
      } else {
        // 将屏幕像素 1:1 映射到目标距离处的世界单位，使光标下的点在平移时始终
        // 保持在光标下。该距离取轨道中心的深度，而它在手势起手时已被对到指针
        // 下方那个东西上（见 focusCenterAt）——**不要**改回某个与画面内容无关
        // 的固定距离，那正是「缩放前后平移速度对不上」的来源。
        const targetDistance =
          object.position.distanceTo(center) *
          Math.tan(((object.fov / 2) * Math.PI) / 180)
        panSpeed = (2 * targetDistance) / elementHeight
      }

      delta.multiplyScalar(panSpeed)
      delta.applyMatrix3(normalMatrix.getNormalMatrix(object.matrix))

      object.position.add(delta)
      center.add(delta)

      scope.dispatchEvent(changeEvent)
    }

    /**
     * 缩放。`delta.z > 0` 为拉远，倍率 `e^(delta.z · zoomSpeed)`。
     *
     * 指数而非「距离 ± 10%」：后者进出不互逆（0.9 与 1.1 不是倒数），滚进去再滚
     * 回来同样格数回不到原处，而平移速度按距离标定，于是「缩放前后手感不一致」。
     *
     * `focusPoint` 是本次缩放的焦点（滚轮传指针下方那一点）。相机沿「相机 → 焦点」
     * 这条直线推拉，故该点在屏幕上的像素位置保持不动，即「朝光标缩放」；不传则退回
     * 沿视线推拉（焦点取轨道中心，等同于此前的行为）。
     */
    this.zoom = function (
      delta: THREE.Vector3,
      focusPoint: THREE.Vector3 | null = null
    ) {
      const factor = Math.exp(delta.z * scope.zoomSpeed)
      if (factor === 1) return

      const forward = cameraForward()
      // center 恒在视线轴上，故其深度即到它的距离（见类注释的不变式）。
      const centerDepth = Math.max(
        forward.dot(_offset.copy(center).sub(object.position)),
        MIN_CENTER_DEPTH
      )

      if (object.isOrthographicCamera) {
        const targetZoom = THREE.MathUtils.clamp(
          object.zoom / factor,
          scope.minZoom,
          scope.maxZoom
        )
        // 顶到上下限时实际生效的倍率不等于 factor，横向让位要按生效的那个算。
        const applied = targetZoom / object.zoom
        if (applied === 1) return

        object.zoom = targetZoom
        object.updateProjectionMatrix()

        if (focusPoint !== null) {
          // 正交没有「推近」，朝光标缩放靠相机在自身像平面内平移实现：
          // 焦点相对相机的横向偏移按同一倍率缩小，它就钉在原像素上。
          _offset.copy(focusPoint).sub(object.position)
          _offset.addScaledVector(forward, -forward.dot(_offset))
          object.position.addScaledVector(_offset, 1 - 1 / applied)
          setCenterDepth(centerDepth)
        }
      } else {
        _focus.copy(focusPoint ?? center)
        const distance = object.position.distanceTo(_focus)
        if (distance < MIN_CENTER_DEPTH) return

        // 上下限是**推不过去的墙**，不是「越界就拽回来」：焦点是指针下方那个东西
        // （不再是轨道中心），起手就可能落在限外——掠过地面的射线交点能有几百米
        // 远。夹成绝对值的话，那时按一下「拉远」反而会把相机猛地吸到 maxDistance
        // 处。故只在**本次移动的方向上**设限，另一个方向永远放行。
        const target = distance * factor
        const clamped =
          factor < 1
            ? Math.min(distance, Math.max(target, scope.minDistance))
            : Math.max(distance, Math.min(target, scope.maxDistance))

        const k = clamped / distance
        if (k === 1) return

        // 先量出「焦点 → 相机」的偏移再写回，不要写成
        // `position.copy(_focus).addScaledVector(_offset.copy(position)…)`：
        // 链式调用的接收者先求值，参数里读到的 position 已经被改成焦点了。
        _offset.copy(object.position).sub(_focus).multiplyScalar(k)
        object.position.copy(_focus).add(_offset)

        // 相机沿「→ 焦点」的直线走，视线方向不变，故轨道中心的深度也按同一倍率
        // 缩放即保持它在画面上的相对位置。焦点落在轴上（未传 focusPoint）时，
        // 这一步的结果就是 center 原地不动。
        setCenterDepth(centerDepth * k)
      }

      scope.dispatchEvent(changeEvent)
    }

    this.rotate = function (delta: THREE.Vector3) {
      vector.copy(object.position).sub(center)

      spherical.setFromVector3(vector)

      spherical.theta += delta.x * scope.rotationSpeed
      spherical.phi += delta.y * scope.rotationSpeed

      spherical.makeSafe()

      vector.setFromSpherical(spherical)

      object.position.copy(center).add(vector)

      object.lookAt(center)

      scope.dispatchEvent(changeEvent)
    }

    //

    function onPointerDown(event: any) {
      if (scope.enabled === false) return

      if (pointers.length === 0) {
        domElement.setPointerCapture(event.pointerId)

        domElement.ownerDocument.addEventListener("pointermove", onPointerMove)
        domElement.ownerDocument.addEventListener("pointerup", onPointerUp)
      }

      //

      if (isTrackingPointer(event)) return

      //

      addPointer(event)

      if (event.pointerType === "touch") {
        onTouchStart(event)
      } else {
        onMouseDown(event)
      }
    }

    function onPointerMove(event: any) {
      if (scope.enabled === false) return

      if (event.pointerType === "touch") {
        onTouchMove(event)
      } else {
        onMouseMove(event)
      }
    }

    function onPointerUp(event: any) {
      removePointer(event)

      switch (pointers.length) {
        case 0:
          // 手势结束必须复位：此前只有 dblclick 绑的 onMouseUp 会复位 state，
          // 抬手之后它仍停在 ROTATE/PAN 上。
          state = STATE.NONE

          domElement.releasePointerCapture(event.pointerId)

          domElement.ownerDocument.removeEventListener(
            "pointermove",
            onPointerMove
          )
          domElement.ownerDocument.removeEventListener("pointerup", onPointerUp)

          break

        case 1: {
          const pointerId = pointers[0]
          const position = pointerPositions[pointerId]

          // 最小占位事件——允许在指针释放时修正状态
          onTouchStart({
            pointerId: pointerId,
            pageX: position.x,
            pageY: position.y
          })

          break
        }
      }
    }

    // 鼠标

    // 当前按着的键决定手势。按 `buttons` 位图判定而不是 `event.button`：一个键按着
    // 再按另一个键时，浏览器（按 Pointer Events 的 chorded buttons 规则）派发的是
    // pointermove 而不是第二个 pointerdown，只认 pointerdown 的话手势永远换不过去。
    function stateFromButtons(buttons: number) {
      if (buttons & 1) return STATE.ROTATE
      if (buttons & 4) return STATE.ZOOM
      if (buttons & 2) return STATE.PAN
      return STATE.NONE
    }

    // 中键推拉的焦点：**起手时定一次**，整段拖动都朝它推。跟着指针逐帧重解析的话，
    // 焦点会随光标扫过的表面来回跳，推拉方向跟着一起飘。
    let dragZoomFocus: THREE.Vector3 | null = null

    // 手势起手：把轨道中心的深度对到指针下方那个东西上（旋转绕它转、平移按它标定
    // 速度）。
    function beginMouseGesture(event: any) {
      pointerOld.set(event.clientX, event.clientY)
      dragZoomFocus = null

      if (state === STATE.ROTATE || state === STATE.PAN) {
        focusCenterAt(event.clientX, event.clientY)
      } else if (state === STATE.ZOOM) {
        dragZoomFocus = pickAt(event.clientX, event.clientY)
      }
    }

    function onMouseDown(event: any) {
      state = stateFromButtons(event.buttons)
      beginMouseGesture(event)
    }

    function onMouseMove(event: any) {
      const next = stateFromButtons(event.buttons)
      if (next !== state) {
        // 中途换键：重新起手，本帧不产生位移（否则会把换键前后的坐标差一次性吃掉）。
        state = next
        beginMouseGesture(event)
        return
      }

      pointer.set(event.clientX, event.clientY)

      const movementX = pointer.x - pointerOld.x
      const movementY = pointer.y - pointerOld.y

      if (state === STATE.ROTATE) {
        scope.rotate(delta.set(-movementX, -movementY, 0))
      } else if (state === STATE.ZOOM) {
        scope.zoom(delta.set(0, 0, movementY), dragZoomFocus)
      } else if (state === STATE.PAN) {
        scope.pan(delta.set(-movementX, movementY, 0))
      }

      pointerOld.set(event.clientX, event.clientY)
    }

    function onMouseUp() {
      state = STATE.NONE
    }

    function onMouseWheel(event: any) {
      if (scope.enabled === false) return

      event.preventDefault()

      // 归一化 deltaY，原因见 https://bugzilla.mozilla.org/show_bug.cgi?id=1392460
      // 焦点取指针下方那一点：朝光标缩放，且缩放前后平移速度自动跟着对上。
      scope.zoom(
        delta.set(0, 0, event.deltaY > 0 ? 1 : -1),
        pickAt(event.clientX, event.clientY)
      )
    }

    function contextmenu(event: any) {
      event.preventDefault()
    }

    this.connect = function (element: any) {
      if (domElement !== null) this.disconnect()

      domElement = element

      domElement.addEventListener("contextmenu", contextmenu)
      domElement.addEventListener("dblclick", onMouseUp)
      domElement.addEventListener("wheel", onMouseWheel, { passive: false })

      domElement.addEventListener("pointerdown", onPointerDown)
    }

    this.disconnect = function () {
      domElement.removeEventListener("contextmenu", contextmenu)
      domElement.removeEventListener("dblclick", onMouseUp)
      domElement.removeEventListener("wheel", onMouseWheel)

      domElement.removeEventListener("pointerdown", onPointerDown)

      domElement = null
    }

    // 触摸

    const touches: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3()
    ]
    const prevTouches: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3()
    ]

    /**
     * 双指间距，**这就是喂给 zoom 的那个量纲**。
     *
     * 那个「除以 10」抵消的是固有的过度敏感（three.js#32442），而它必须由
     * touchstart（播种）与 touchmove（每帧）共用同一份实现：两处各写各的时，
     * 每次捏合的第一帧算出来的是 `原始间距 − 间距/10 ≈ 0.9 × 指间像素距`，
     * 而 zoom 是 `e^(delta.z · zoomSpeed)` ——两指相距 200px 就是 e^18 ≈ 6.6e7，
     * 相机当场被甩到无穷远、整个场景消失。
     *
     * 从前有一道 `delta.length() > distance 就返回` 的守卫一直在吞掉这个错误的
     * 首帧，指数化缩放去掉那道守卫之后它才显形——**根因在这里，不在守卫**。
     */
    function pinchDistance(a: THREE.Vector3, b: THREE.Vector3): number {
      return a.distanceTo(b) / 10
    }

    let prevDistance: number | null = null

    function onTouchStart(event: any) {
      trackPointer(event)

      switch (pointers.length) {
        case 1:
          touches[0]
            .set(event.pageX, event.pageY, 0)
            .divideScalar(window.devicePixelRatio)
          touches[1]
            .set(event.pageX, event.pageY, 0)
            .divideScalar(window.devicePixelRatio)
          // 单指旋转同样以指下那个东西为中心（onPointerUp 会合成一个只带
          // pageX/pageY 的占位事件调进来，故先确认拿得到视口坐标）。
          if (typeof event.clientX === "number") {
            focusCenterAt(event.clientX, event.clientY)
          }
          break

        case 2: {
          const position = getSecondPointerPosition(event)

          touches[0]
            .set(event.pageX, event.pageY, 0)
            .divideScalar(window.devicePixelRatio)
          touches[1]
            .set(position.x, position.y, 0)
            .divideScalar(window.devicePixelRatio)
          prevDistance = pinchDistance(touches[0], touches[1])
          break
        }
      }

      prevTouches[0].copy(touches[0])
      prevTouches[1].copy(touches[1])
    }

    function onTouchMove(event: any) {
      trackPointer(event)

      function getClosest(touch: THREE.Vector3, touches: THREE.Vector3[]) {
        let closest = touches[0]!

        for (const touch2 of touches) {
          if (closest.distanceTo(touch) > touch2.distanceTo(touch))
            closest = touch2
        }

        return closest
      }

      switch (pointers.length) {
        case 1:
          touches[0]
            .set(event.pageX, event.pageY, 0)
            .divideScalar(window.devicePixelRatio)
          touches[1]
            .set(event.pageX, event.pageY, 0)
            .divideScalar(window.devicePixelRatio)
          scope.rotate(
            touches[0]
              .sub(getClosest(touches[0], prevTouches))
              .multiplyScalar(-1)
          )
          break

        case 2: {
          const position = getSecondPointerPosition(event)

          touches[0]
            .set(event.pageX, event.pageY, 0)
            .divideScalar(window.devicePixelRatio)
          touches[1]
            .set(position.x, position.y, 0)
            .divideScalar(window.devicePixelRatio)
          const distance = pinchDistance(touches[0], touches[1])
          // 第一帧之前没播过种时按「没缩放」算，而不是拿 0 当上一次的间距
          // （那等于把整个指间距当成一次缩放量，见 pinchDistance）。
          scope.zoom(delta.set(0, 0, (prevDistance ?? distance) - distance))
          prevDistance = distance

          const offset0 = touches[0]
            .clone()
            .sub(getClosest(touches[0], prevTouches))
          const offset1 = touches[1]
            .clone()
            .sub(getClosest(touches[1], prevTouches))
          offset0.x = -offset0.x
          offset1.x = -offset1.x

          scope.pan(offset0.add(offset1))

          break
        }
      }

      prevTouches[0].copy(touches[0])
      prevTouches[1].copy(touches[1])
    }

    function addPointer(event: any) {
      pointers.push(event.pointerId)
    }

    function removePointer(event: any) {
      delete pointerPositions[event.pointerId]

      for (let i = 0; i < pointers.length; i++) {
        if (pointers[i] == event.pointerId) {
          pointers.splice(i, 1)
          return
        }
      }
    }

    function isTrackingPointer(event: any) {
      for (const p of pointers) {
        if (p == event.pointerId) return true
      }

      return false
    }

    function trackPointer(event: any) {
      let position = pointerPositions[event.pointerId]

      if (position === undefined) {
        position = new THREE.Vector2()
        pointerPositions[event.pointerId] = position
      }

      position.set(event.pageX, event.pageY)
    }

    function getSecondPointerPosition(event: any) {
      const pointerId =
        event.pointerId === pointers[0] ? pointers[1] : pointers[0]

      return pointerPositions[pointerId]
    }
  }

  fromJSON(json: any) {
    if (json.center !== undefined) this.center.fromArray(json.center)
  }

  toJSON() {
    return {
      center: this.center.toArray()
    }
  }
}

export { EditorControls }
