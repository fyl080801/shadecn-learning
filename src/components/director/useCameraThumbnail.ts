import * as THREE from "three"
import {
  onBeforeUnmount,
  ref,
  watch,
  type Ref,
  type ShallowRef
} from "vue"

const THUMB_WIDTH = 256
const THUMB_HEIGHT = 144

// 将编辑器场景以指定相机的视角渲染成缩略图 data URL。
// 渲染流程对齐 Viewport.ts 机位视角下的 render()：scene → backdrop（机位
// 视角下重定位到相机处）→ grid，使缩略图与机位画面一致；编辑器辅助器
// （相机视锥、灯光辅助等）不进入缩略图。
export function useCameraThumbnail(
  editor: any,
  camera: ShallowRef<any> | Ref<any>,
  version: Ref<number>
) {
  const thumbnail = ref("")

  let renderer: any = null
  let renderTarget: THREE.WebGLRenderTarget | null = null
  let readBuffer: Uint8Array | null = null
  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let rafId = 0
  let scheduled = false

  const _backdropVec = new THREE.Vector3()
  const _backdropPrevPos = new THREE.Vector3()
  const _backdropPrevScale = new THREE.Vector3()

  function ensureBuffers() {
    if (!renderer) return false
    if (!renderTarget) {
      renderTarget = new THREE.WebGLRenderTarget(THUMB_WIDTH, THUMB_HEIGHT, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      })
    }
    if (!readBuffer) {
      readBuffer = new Uint8Array(THUMB_WIDTH * THUMB_HEIGHT * 4)
    }
    if (!canvas) {
      canvas = document.createElement("canvas")
      canvas.width = THUMB_WIDTH
      canvas.height = THUMB_HEIGHT
      ctx = canvas.getContext("2d")
    }
    return true
  }

  function dispose() {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    scheduled = false
    if (renderTarget) renderTarget.dispose()
    renderTarget = null
    readBuffer = null
    canvas = null
    ctx = null
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    rafId = requestAnimationFrame(() => {
      scheduled = false
      rafId = 0
      renderNow()
    })
  }

  function renderNow() {
    const cam = camera.value
    if (!renderer || !cam || !ensureBuffers()) return

    const scene = editor.scene
    const backdrop = editor.backdrop

    // 缩略图采用 16:9 宽高比，临时改写相机 aspect，渲染后还原，
    // 不影响视口相机本身。与 Viewport 的 updateAspectRatio 同理。
    const prevAspect = cam.aspect
    cam.aspect = THUMB_WIDTH / THUMB_HEIGHT
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()

    const prevRenderTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    const prevClearColor = new THREE.Color()
    renderer.getClearColor(prevClearColor)
    const prevClearAlpha = renderer.getClearAlpha()

    renderer.setRenderTarget(renderTarget!)
    renderer.setClearColor(editor.viewportColor ?? new THREE.Color(0x000000), 1)
    renderer.clear()

    // scene 先渲染（同 Viewport.render：颜色背景会强制清除缓冲）。
    renderer.render(scene, cam)

    // backdrop 在机位相机下重定位到相机处并缩放进视锥，渲染后还原。
    renderer.autoClear = false
    let panoramaRadius = 0
    backdrop.traverse((child: any) => {
      if (child.isMesh && child.visible && child.geometry) {
        if (!child.geometry.boundingSphere) child.geometry.computeBoundingSphere()
        const r = child.geometry.boundingSphere?.radius ?? 0
        if (r > panoramaRadius) panoramaRadius = r
      }
    })
    if (panoramaRadius > 0 && cam.far > cam.near) {
      cam.getWorldPosition(_backdropVec)
      _backdropPrevPos.copy(backdrop.position)
      _backdropPrevScale.copy(backdrop.scale)
      backdrop.position.copy(_backdropVec)
      backdrop.scale.setScalar((cam.far * 0.9) / panoramaRadius)
      renderer.render(backdrop, cam)
      backdrop.position.copy(_backdropPrevPos)
      backdrop.scale.copy(_backdropPrevScale)
    } else {
      renderer.render(backdrop, cam)
    }

    renderer.autoClear = true

    // 回读像素 → canvas（纵向翻转 WebGL 原点）→ data URL。
    renderer.readRenderTargetPixels(
      renderTarget!,
      0,
      0,
      THUMB_WIDTH,
      THUMB_HEIGHT,
      readBuffer!
    )
    const imageData = ctx!.createImageData(THUMB_WIDTH, THUMB_HEIGHT)
    const data = imageData.data
    const rowBytes = THUMB_WIDTH * 4
    for (let y = 0; y < THUMB_HEIGHT; y++) {
      const src = (THUMB_HEIGHT - 1 - y) * rowBytes
      const dst = y * rowBytes
      data.set(readBuffer!.subarray(src, src + rowBytes), dst)
    }
    ctx!.putImageData(imageData, 0, 0)
    thumbnail.value = canvas!.toDataURL("image/jpeg", 0.8)

    // 还原渲染器状态与相机参数。
    renderer.setRenderTarget(prevRenderTarget)
    renderer.autoClear = prevAutoClear
    renderer.setClearColor(prevClearColor, prevClearAlpha)
    cam.aspect = prevAspect
    cam.updateProjectionMatrix()
  }

  function onRendererCreated(newRenderer: any) {
    renderer = newRenderer
    schedule()
  }

  // 渲染器可能晚于面板挂载创建（见 useDirectorRenderer），通过信号接入。
  editor.signals.rendererCreated.add(onRendererCreated)

  // 相机切换或版本号变化时重新渲染（rAF 合并多次变更为一帧一次）。
  watch([camera, version], schedule, { immediate: true })

  onBeforeUnmount(() => {
    editor.signals.rendererCreated.remove(onRendererCreated)
    dispose()
  })

  return { thumbnail, refresh: schedule }
}
