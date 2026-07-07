
import * as THREE from "three"

interface Player {
  dom: HTMLDivElement
  canvas: HTMLCanvasElement | null
  width: number
  height: number
  load(json: any): Promise<void>
  setCamera(value: any): void
  setScene(value: any): void
  setPixelRatio(pixelRatio: number): void
  setClearColor(color: any): void
  setSize(width: number, height: number): void
  play(): void
  stop(): void
  render(time: number): void
  dispose(): void
}

const APP = {
  Player: function (this: Player) {
    let renderer: any

    const loader = new THREE.ObjectLoader()
    let camera: any, scene: any

    let events: Record<string, any[]> = {}

    const dom = document.createElement("div")

    this.dom = dom
    this.canvas = null

    this.width = 500
    this.height = 500

    this.load = async function (this: Player, json: any) {
      const project = json.project

      // 根据项目设置创建渲染器

      if (renderer !== undefined) {
        renderer.dispose()
        dom.removeChild(renderer.domElement)
        this.canvas = null
      }

      if (project.renderer === "WebGPURenderer") {
        const { WebGPURenderer } = await import("three/webgpu")
        renderer = new WebGPURenderer({
          antialias: true,
          reversedDepthBuffer: true
        })
        await renderer.init()
      } else {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          reversedDepthBuffer: true
        })
      }

      renderer.setPixelRatio(window.devicePixelRatio)

      if (project.shadows !== undefined)
        renderer.shadowMap.enabled = project.shadows
      if (project.shadowType !== undefined)
        renderer.shadowMap.type = project.shadowType
      if (project.toneMapping !== undefined)
        renderer.toneMapping = project.toneMapping
      if (project.toneMappingExposure !== undefined)
        renderer.toneMappingExposure = project.toneMappingExposure

      dom.appendChild(renderer.domElement)
      this.canvas = renderer.domElement

      this.setScene(loader.parse(json.scene))
      this.setCamera(loader.parse(json.camera))

      events = {
        init: [],
        start: [],
        stop: [],
        keydown: [],
        keyup: [],
        pointerdown: [],
        pointerup: [],
        pointermove: [],
        update: []
      }

      let scriptWrapParams = "player,renderer,scene,camera"
      const scriptWrapResultObj: Record<string, any> = {}

      for (const eventKey in events) {
        scriptWrapParams += "," + eventKey
        scriptWrapResultObj[eventKey] = eventKey
      }

      const scriptWrapResult = JSON.stringify(scriptWrapResultObj).replace(
        /\"/g,
        ""
      )

      for (const uuid in json.scripts) {
        const object = scene.getObjectByProperty("uuid", uuid, true)

        if (object === undefined) {
          console.warn("APP.Player: Script without object.", uuid)
          continue
        }

        const scripts = json.scripts[uuid]

        for (let i = 0; i < scripts.length; i++) {
          const script = scripts[i]

          const functions = new Function(
            scriptWrapParams,
            script.source + "\nreturn " + scriptWrapResult + ";"
          ).bind(object)(this, renderer, scene, camera)

          for (const name in functions) {
            if (functions[name] === undefined) continue

            if (events[name] === undefined) {
              console.warn("APP.Player: Event type not supported (", name, ")")
              continue
            }

            events[name].push(functions[name].bind(object))
          }
        }
      }

      dispatch(events.init, arguments)
    }

    this.setCamera = function (this: Player, value: any) {
      camera = value
      setCameraAspect(camera, this.width / this.height)
    }

    this.setScene = function (value: any) {
      scene = value
    }

    this.setPixelRatio = function (pixelRatio: number) {
      renderer.setPixelRatio(pixelRatio)
    }

    this.setClearColor = function (color: any) {
      renderer.setClearColor(color)
    }

    this.setSize = function (this: Player, width: number, height: number) {
      this.width = width
      this.height = height

      if (camera) {
        setCameraAspect(camera, this.width / this.height)
      }

      if (renderer) {
        renderer.setSize(width, height)
      }
    }

    function setCameraAspect(camera: any, aspect: number) {
      if (camera.isPerspectiveCamera) {
        camera.aspect = aspect
      } else {
        const frustumHeight = camera.top - camera.bottom

        camera.left = (-frustumHeight * aspect) / 2
        camera.right = (frustumHeight * aspect) / 2
      }

      camera.updateProjectionMatrix()
    }

    function dispatch(array: any[] | undefined, event: any) {
      if (!array) return

      for (let i = 0, l = array.length; i < l; i++) {
        array[i](event)
      }
    }

    let time: number, startTime: number, prevTime: number

    function animate() {
      time = performance.now()

      try {
        dispatch(events.update, {
          time: time - startTime,
          delta: time - prevTime
        })
      } catch (e: any) {
        console.error(e.message || e, e.stack || "")
      }

      renderer.render(scene, camera)

      prevTime = time
    }

    this.play = function () {
      startTime = prevTime = performance.now()

      document.addEventListener("keydown", onKeyDown)
      document.addEventListener("keyup", onKeyUp)
      document.addEventListener("pointerdown", onPointerDown)
      document.addEventListener("pointerup", onPointerUp)
      document.addEventListener("pointermove", onPointerMove)

      dispatch(events.start, arguments)

      renderer.setAnimationLoop(animate)
    }

    this.stop = function () {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("keyup", onKeyUp)
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("pointerup", onPointerUp)
      document.removeEventListener("pointermove", onPointerMove)

      dispatch(events.stop, arguments)

      renderer.setAnimationLoop(null)
    }

    this.render = function (time: number) {
      dispatch(events.update, { time: time * 1000, delta: 0 /* TODO */ })

      renderer.render(scene, camera)
    }

    this.dispose = function () {
      if (renderer) {
        renderer.dispose()
      }

      camera = undefined
      scene = undefined
    }

    //

    function onKeyDown(event: any) {
      dispatch(events.keydown, event)
    }

    function onKeyUp(event: any) {
      dispatch(events.keyup, event)
    }

    function onPointerDown(event: any) {
      dispatch(events.pointerdown, event)
    }

    function onPointerUp(event: any) {
      dispatch(events.pointerup, event)
    }

    function onPointerMove(event: any) {
      dispatch(events.pointermove, event)
    }
  }
}

export { APP }
