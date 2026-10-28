import * as THREE from "three"

class EditorControls extends THREE.EventDispatcher<Record<string, any>> {
  enabled: boolean
  center: THREE.Vector3
  panSpeed: number
  zoomSpeed: number
  rotationSpeed: number

  setCamera: (camera: any) => void
  focus: (target: any) => void
  pan: (delta: THREE.Vector3) => void
  zoom: (delta: THREE.Vector3) => void
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

    // 内部实现

    const scope = this
    const vector = new THREE.Vector3()
    const delta = new THREE.Vector3()
    const box = new THREE.Box3()

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
        // 将屏幕像素 1:1 映射到目标距离处的世界单位，
        // 使光标下的点在平移时始终保持在光标下
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

    this.zoom = function (delta: THREE.Vector3) {
      if (object.isOrthographicCamera) {
        object.zoom = Math.max(0.0001, object.zoom * Math.pow(0.95, delta.z))
        object.updateProjectionMatrix()
      } else {
        const distance = object.position.distanceTo(center)

        delta.multiplyScalar(distance * scope.zoomSpeed)

        if (delta.length() > distance) return

        delta.applyMatrix3(normalMatrix.getNormalMatrix(object.matrix))

        object.position.add(delta)
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
          domElement.releasePointerCapture(event.pointerId)

          domElement.ownerDocument.removeEventListener(
            "pointermove",
            onPointerMove
          )
          domElement.ownerDocument.removeEventListener("pointerup", onPointerUp)

          break

        case 1:
          var pointerId = pointers[0]
          var position = pointerPositions[pointerId]

          // 最小占位事件——允许在指针释放时修正状态
          onTouchStart({
            pointerId: pointerId,
            pageX: position.x,
            pageY: position.y
          })

          break
      }
    }

    // 鼠标

    function onMouseDown(event: any) {
      if (event.button === 0) {
        state = STATE.ROTATE
      } else if (event.button === 1) {
        state = STATE.ZOOM
      } else if (event.button === 2) {
        state = STATE.PAN
      }

      pointerOld.set(event.clientX, event.clientY)
    }

    function onMouseMove(event: any) {
      pointer.set(event.clientX, event.clientY)

      const movementX = pointer.x - pointerOld.x
      const movementY = pointer.y - pointerOld.y

      if (state === STATE.ROTATE) {
        scope.rotate(delta.set(-movementX, -movementY, 0))
      } else if (state === STATE.ZOOM) {
        scope.zoom(delta.set(0, 0, movementY))
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
      scope.zoom(delta.set(0, 0, event.deltaY > 0 ? 1 : -1))
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
          break

        case 2:
          var position = getSecondPointerPosition(event)

          touches[0]
            .set(event.pageX, event.pageY, 0)
            .divideScalar(window.devicePixelRatio)
          touches[1]
            .set(position.x, position.y, 0)
            .divideScalar(window.devicePixelRatio)
          prevDistance = touches[0].distanceTo(touches[1])
          break
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

        case 2:
          var position = getSecondPointerPosition(event)

          touches[0]
            .set(event.pageX, event.pageY, 0)
            .divideScalar(window.devicePixelRatio)
          touches[1]
            .set(position.x, position.y, 0)
            .divideScalar(window.devicePixelRatio)
          // 除以 10 以抵消固有的过度敏感（https://github.com/mrdoob/three.js/issues/32442）
          var distance = touches[0].distanceTo(touches[1]) / 10
          scope.zoom(delta.set(0, 0, prevDistance! - distance))
          prevDistance = distance

          var offset0 = touches[0]
            .clone()
            .sub(getClosest(touches[0], prevTouches))
          var offset1 = touches[1]
            .clone()
            .sub(getClosest(touches[1], prevTouches))
          offset0.x = -offset0.x
          offset1.x = -offset1.x

          scope.pan(offset0.add(offset1))

          break
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
      for (let i = 0; i < pointers.length; i++) {
        if (pointers[i] == event.pointerId) return true
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
