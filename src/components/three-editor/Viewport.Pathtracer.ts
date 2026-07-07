
import { WebGLPathTracer } from "three-gpu-pathtracer"

interface ViewportPathtracerApi {
  init(scene: any, camera: any): void
  setSize(): void
  setBackground(): void
  setEnvironment(): void
  updateMaterials(): void
  update(): void
  reset(): void
  getSamples(): number | undefined
}

function ViewportPathtracer(renderer: any): ViewportPathtracerApi {
  let pathTracer: any = null

  function init(scene: any, camera: any) {
    if (pathTracer === null) {
      pathTracer = new WebGLPathTracer(renderer)
      pathTracer.filterGlossyFactor = 0.5
    }

    pathTracer.setScene(scene, camera)
  }

  function setSize(/* width, height */) {
    if (pathTracer === null) return

    // 路径追踪器尺寸根据画布自动更新
    pathTracer.updateCamera()
  }

  function setBackground(/* background, blurriness */) {
    if (pathTracer === null) return

    // 根据已初始化的场景字段更新环境设置
    pathTracer.updateEnvironment()
  }

  function updateMaterials() {
    if (pathTracer === null) return

    pathTracer.updateMaterials()
  }

  function setEnvironment(/* environment */) {
    if (pathTracer === null) return

    pathTracer.updateEnvironment()
  }

  function update() {
    if (pathTracer === null) return

    pathTracer.renderSample()
  }

  function reset() {
    if (pathTracer === null) return

    pathTracer.updateCamera()
  }

  function getSamples() {
    if (pathTracer === null) return

    return pathTracer.samples
  }

  return {
    init: init,
    setSize: setSize,
    setBackground: setBackground,
    setEnvironment: setEnvironment,
    updateMaterials: updateMaterials,
    update: update,
    reset: reset,
    getSamples: getSamples
  }
}

export { ViewportPathtracer }
