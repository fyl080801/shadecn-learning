import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as THREE from "three"
import { defineComponent, h, nextTick } from "vue"
import { mount } from "@vue/test-utils"

import { useDirectorSceneBackdrop } from "@/components/director/useDirectorSceneBackdrop"
import { uploadedPanoramaUrl } from "@/components/director/directorState"

vi.mock("vue-sonner", () => ({
  toast: { loading: () => "toast-id", dismiss: () => {}, error: () => {} }
}))

/**
 * 全景图解码是「十几兆、要好几秒」的异步过程，而 `TextureLoader.load` 的回调既不认
 * 「我已经不是最新那一次了」也不认「组件已经卸载」。两件事都会真的发生，且后果不同：
 *   · 先选 A 再选 B、A 后到 —— 它会把 B **dispose 掉**并把画面换回旧的 A；
 *   · 解码途中关掉导演台 —— 那张贴图写进一个已经收过尾的 ref，每开关一次泄漏一整张。
 */

function createSignal() {
  const listeners: ((...args: any[]) => void)[] = []
  return {
    add: (fn: any) => listeners.push(fn),
    remove: (fn: any) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    dispatch: (...args: any[]) => listeners.slice().forEach((fn) => fn(...args))
  }
}

function stubEditor() {
  const scene = new THREE.Scene()
  return {
    scene,
    backdrop: new THREE.Group(),
    grid: new THREE.Group(),
    groundPlane: new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial()
    ),
    environmentType: "Default",
    setGroundExtent: () => {},
    signals: {
      sceneGraphChanged: createSignal(),
      sceneBackgroundChanged: createSignal(),
      sceneEnvironmentChanged: createSignal()
    }
  } as any
}

/** 把每一次 load 的回调收下来，由用例决定谁先解码完。 */
type Pending = {
  url: string
  done: (tex: THREE.Texture) => void
  fail: () => void
}

describe("useDirectorSceneBackdrop —— 全景解码的过期与卸载", () => {
  let pending: Pending[] = []
  let loadSpy: ReturnType<typeof vi.spyOn>
  // 用例失败时也要收干净：这个 composable 读的是模块级的 uploadedPanoramaUrl，留一个
  // 没卸载的实例在后台，下一条用例设一次 url 就会看到两次 load。
  const mountedWrappers: ReturnType<typeof mount>[] = []

  beforeEach(() => {
    pending = []
    uploadedPanoramaUrl.value = null
    loadSpy = vi
      .spyOn(THREE.TextureLoader.prototype, "load")
      .mockImplementation((url: any, onLoad: any, _p: any, onError: any) => {
        pending.push({ url, done: onLoad, fail: onError })
        return new THREE.Texture()
      })
  })

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
    loadSpy.mockRestore()
    uploadedPanoramaUrl.value = null
  })

  function mountBackdrop() {
    const editor = stubEditor()
    const wrapper = mount(
      defineComponent({
        setup() {
          useDirectorSceneBackdrop(editor)
          return () => h("div")
        }
      })
    )
    mountedWrappers.push(wrapper)
    return { editor, wrapper }
  }

  /**
   * 全景球此刻挂着哪一张的 **uuid**。
   *
   * 认 uuid 而不是对象本身：贴图存在 `ref` 里，Vue 会把它包成响应式 Proxy，故球上那一份
   * 与用例手里的原对象**不是同一个引用**（`toBe` 会以「看不出差别却不相等」失败）。
   */
  function currentMapId(editor: any): string | null {
    const sphere = editor.backdrop.children.find((c: any) => c.isMesh)
    return (sphere?.material as THREE.MeshBasicMaterial)?.map?.uuid ?? null
  }

  it("后选的先解码完时，先选的那张到货后不许顶替它", async () => {
    const { editor } = mountBackdrop()

    uploadedPanoramaUrl.value = "https://cdn/a.jpg"
    await nextTick()
    uploadedPanoramaUrl.value = "https://cdn/b.jpg"
    await nextTick()
    expect(pending.map((p) => p.url)).toEqual([
      "https://cdn/a.jpg",
      "https://cdn/b.jpg"
    ])

    // B 先解码完 —— 它是用户此刻选的那一张。
    const textureB = new THREE.Texture()
    pending[1]!.done(textureB)
    await nextTick()
    expect(currentMapId(editor)).toBe(textureB.uuid)

    // A 姗姗来迟：既不能顶替 B，也不能把 B dispose 掉，自己要就地销毁。
    const textureA = new THREE.Texture()
    const disposeA = vi.spyOn(textureA, "dispose")
    const disposeB = vi.spyOn(textureB, "dispose")
    pending[0]!.done(textureA)
    await nextTick()

    expect(currentMapId(editor)).toBe(textureB.uuid)
    expect(disposeA).toHaveBeenCalled()
    expect(disposeB).not.toHaveBeenCalled()
  })

  it("解码途中卸载：迟到的那张就地销毁，不泄漏", async () => {
    const { wrapper } = mountBackdrop()

    uploadedPanoramaUrl.value = "https://cdn/a.jpg"
    await nextTick()
    expect(pending).toHaveLength(1)

    wrapper.unmount()

    const texture = new THREE.Texture()
    const dispose = vi.spyOn(texture, "dispose")
    pending[0]!.done(texture)

    expect(dispose).toHaveBeenCalled()
  })

  it("取消背景之后，在途的那一张不会把背景又装回去", async () => {
    const { editor } = mountBackdrop()

    uploadedPanoramaUrl.value = "https://cdn/a.jpg"
    await nextTick()
    uploadedPanoramaUrl.value = null
    await nextTick()

    const texture = new THREE.Texture()
    pending[0]!.done(texture)
    await nextTick()

    expect(currentMapId(editor)).toBeNull()
  })
})
