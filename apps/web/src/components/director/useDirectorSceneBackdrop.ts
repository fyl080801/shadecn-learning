import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import * as THREE from "three"

import { toast } from "vue-sonner"
import {
  PANORAMA_SPHERE_NAME,
  currentGroundHeight,
  resetDirectorSceneSession
} from "./directorSceneProperties"
import {
  resolveActivePanoramaSource,
  uploadedPanoramaUrl
} from "./directorState"

// ————————————————————————————————————————————————————————————————
// 导演台的背景运行时：全景球、全景纹理、环境光照、地面网格跟随、天空颜色对账。
//
// 这些**不是**面板控件，只是恰好由「场景设置」那几个控件驱动：它们必须在整个导演台
// 生命周期内活着（背景要显示、纹理要加载完），而属性面板会随选中对象换成图形/机位面板。
// 原先靠「场景面板常驻挂载 + v-show 隐藏」维持，属性面板统一成一个实现后那个位置不再
// 存在，故把这层运行时抽出来由 DirectorConsoleModal 常驻挂载，面板那边只剩声明式字段
// （见 properties/scenePanelFields.ts）。
//
// 两个独立图层，故意不互相绑定：
//
// - 天空颜色是场景实际的背景填充——作为平面 THREE.Color 的 `scene.background`，
//   通过共享的 sceneBackgroundChanged 信号分发（与完整 three-editor 的「Color」
//   背景类型机制相同）。平面颜色无朝向/深度，因此无需视差/缩放处理——它始终在一切之后。
//
// - 全景纹理是 editor.backdrop 中一个真实的大型球体——既非原生的 `scene.background`
//   等距矩形纹理，也非 `scene` 的子节点。未加载纹理时它不可见，因此无背景图时仅天空
//   颜色独自显示。
//
//   Three.js 把等距矩形 scene.background 渲染在无限远处（其盒子网格每帧重新对中相机，
//   仅读取相机的*旋转*），因此它不会从相机平移中获得任何视差：平移/缩放视口时它明显
//   冻结而其他一切都在移动。真实网格则无此特例——普通相机投影自动为其提供正确的
//   视差/缩放，与网格一致。
//
//   它故意不是 `scene` 的子节点：全景代表固定的地平线，并非物理微缩舞台的一部分，
//   因此必须不受「场景缩放/平移/旋转」控件影响（那几个控件把网格 + 角色/机位当作
//   「舞台」整体缩放/移动）。editor.backdrop 是一个同级的 THREE.Scene，以相同相机在
//   自身通道中渲染（Viewport.ts 的 render()），故保持正确视差的同时不受 `scene` 变换影响。
//
//   它在 `scene` 之后、`grid`/`sceneHelpers` 之前渲染（而非在 `scene` 之前：
//   scene.background 是平面 Color，Three.js 渲染带 Color 背景的场景时无论 autoClear
//   如何都会强制清除缓冲区，因此先于 `scene` 绘制的任何内容都会在 `scene` 渲染瞬间
//   被擦除）。正是该顺序使地面平面的半透明填充能与全景的真实像素混合：地面绘制时全景
//   已存在于颜色缓冲区中，故降低地面透明度会显露实际背景而非平面颜色。把球体放在最后
//   渲染会导致合成顺序颠倒——地面要么被球体完全覆盖，要么只能与它之前绘制的内容混合。
//   作为独立场景而非 sceneHelpers 子节点还使其免于点击拾取（Selector.ts 仅遍历
//   sceneHelpers），也不出现在 DirectorScenePanel 的列表中（该列表只读 scene.children）。
//
// scene.environment（环境光照/反射）是独立的、合理地与相机无关的概念，因此仍由共享的
// sceneEnvironmentChanged 信号驱动。
// ————————————————————————————————————————————————————————————————

/** 天空颜色默认值：挂载时推一次，使 scene.background 始终是由它驱动的平面 Color。 */
const DEFAULT_SKY_COLOR = "#000303"
/**
 * 全景球默认半径。地面网格/平面为固定的 30×30（Viewport.ts 的 GridHelper/PlaneGeometry），
 * 100% 场景缩放下球体横截面直径应为该边长的两倍，即 r = 30·2/2 = 30。
 */
export const DEFAULT_PANORAMA_RADIUS = 30
/** 地面填充默认透明度。 */
const DEFAULT_GROUND_OPACITY = 0.25
/**
 * 影棚环境的强度——**导演台整体亮度的唯一旋钮**（`scene.environment` 是唯一光源，没有
 * 任何灯光对象）。RoomEnvironment 本身按「中性」标定，1 意味着白色表面渲染出来就是白色，
 * 而舞台上的图形常用偏深的颜色，按 1 看着仍旧闷；略微推高一档使深色也能读出体积。
 * 再往上会把浅色图形推到过曝、连带丢掉明暗过渡。
 */
const DEFAULT_ENV_INTENSITY = 1.5

export function useDirectorSceneBackdrop(editor: any) {
  const signals = editor.signals
  const scene = editor.scene

  function requestRender() {
    signals.sceneGraphChanged.dispatch()
  }

  // ----- 全景球 -----

  let sphere: THREE.Mesh | null = null

  function ensureSphere(): THREE.Mesh {
    if (sphere) return sphere

    const material = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      depthWrite: false
    })
    sphere = new THREE.Mesh(
      new THREE.SphereGeometry(DEFAULT_PANORAMA_RADIUS, 48, 32),
      material
    )
    // directorSceneProperties 的 handler 按此名字在 editor.backdrop 中查找球体
    sphere.name = PANORAMA_SPHERE_NAME
    sphere.renderOrder = -1
    sphere.visible = false

    editor.backdrop.add(sphere)
    return sphere
  }

  // ----- 全景纹理 -----
  //
  // 背景变更入口有三处（属性面板的上传/资产选择、DirectorToolbar 的 icon-quanjingtu
  // 菜单、画布 720 全景节点连线），都通过共享的 activeBackgroundUrl 汇聚到此处唯一的
  // 纹理解码点——上传进度条只覆盖 OSS 上传阶段，真正的加载延迟在这之后的
  // TextureLoader 解码，此前完全没有反馈。用全局 toast 填补这段空白；切换过快时先
  // 移除上一个尚未完成的 toast，避免堆叠。

  const panoramaTexture = ref<THREE.Texture | null>(null)
  let textureLoader: THREE.TextureLoader | null = null
  let loadingToastId: string | number | null = null
  /**
   * 本次解码的编号 + 组件还在不在。
   *
   * `TextureLoader.load` 的回调既不认「我已经不是最新那一次了」也不认「组件已经卸载」，
   * 而全景图是十几兆的大图、解码要好几秒，这两件事都会真的发生：
   *   · 先选 A 再选 B，B 先解码完，A 随后到达 —— 它会把 B **dispose 掉**并把视口换回旧的 A
   *     （还连带把环境光照也换成 A，见 applyEnvironmentLighting）；
   *   · 解码途中关掉导演台，onBeforeUnmount 那一句 dispose 的是还没被赋值的 null，
   *     随后到达的那张贴图写进一个 watcher 已经停掉的模块级 ref，每开关一次泄漏一整张。
   * 故按编号认结果（同 DirectorClipPresetPicker 的 requestSeq），过期与卸载后一律就地 dispose。
   */
  let loadSeq = 0
  let unmounted = false

  /**
   * 当前生效的全景背景原图 URL：画布连线来源优先，回退到本地上传/资产选择。
   * 二者互斥——建立连线时 StudioCanvas 已清空 uploadedPanoramaUrl。
   */
  const activeBackgroundUrl = computed(
    () =>
      resolveActivePanoramaSource()?.url ?? uploadedPanoramaUrl.value ?? null
  )

  function dismissLoadingToast() {
    if (!loadingToastId) return
    toast.dismiss(loadingToastId)
    loadingToastId = null
  }

  function loadTexture(url: string) {
    if (!textureLoader) {
      textureLoader = new THREE.TextureLoader()
      textureLoader.crossOrigin = "anonymous"
    }
    dismissLoadingToast()
    loadingToastId = toast.loading("正在加载场景图中...")
    const seq = ++loadSeq
    const stale = () => unmounted || seq !== loadSeq
    textureLoader.load(
      url,
      (tex) => {
        // 过期/已卸载的那一张就地销毁：它谁也不该顶替，留着就是一整张全景图的泄漏。
        if (stale()) {
          tex.dispose()
          return
        }
        tex.colorSpace = THREE.SRGBColorSpace
        const previous = panoramaTexture.value
        panoramaTexture.value = tex
        previous?.dispose()
        dismissLoadingToast()
      },
      undefined,
      () => {
        // 过期的失败同样不出声：那条 toast 是**这一次**加载的，替它收掉就等于让用户
        // 看着一次早已被取消的加载报错、而正在跑的那一次没了进度提示。
        if (stale()) return
        dismissLoadingToast()
        toast.error("场景图加载失败，请重试")
      }
    )
  }

  watch(
    activeBackgroundUrl,
    (url) => {
      if (url) {
        loadTexture(url)
        return
      }
      // 取消背景同样要作废在途的那一次，否则它随后到达时会把背景又装回去。
      loadSeq += 1
      dismissLoadingToast()
      const previous = panoramaTexture.value
      panoramaTexture.value = null
      previous?.dispose()
    },
    { immediate: true }
  )

  /**
   * 场景光照。导演台**没有任何灯光对象**，画面里的一切明暗全部来自 `scene.environment`
   * ——「viewport 里那片背景就是光源」这个猜测基本成立，本函数就是那唯一的开关。
   *
   * 有全景图时它就是光源（同时也是背景），这与真实布景一致；**没有全景图时不要退回
   * `'Default'`**：那一档的含义是「拿 scene.background 当光源」，而导演台的背景恒为一支
   * 近黑的天空色（DEFAULT_SKY_COLOR），于是环境被烘成一个均匀且几乎为零的色球——
   * 均匀意味着任何法线拿到的辐照度都相同（没有明暗过渡、没有高光，物体渲染成一整块
   * 纯色），近黑意味着整体压暗。两件事叠在一起就是「偏暗的大色块」。
   * 故改用与背景无关的中性影棚环境（Viewport.ts 的 'Room'），天空色只管背景填充。
   */
  function desiredEnvironmentType(): "Equirectangular" | "Room" {
    return panoramaTexture.value ? "Equirectangular" : "Room"
  }

  function applyEnvironmentLighting() {
    if (panoramaTexture.value) {
      // 全景图是实拍/生成的完整环境，按原样当光源用；再乘系数会把它的明暗关系整体
      // 推亮，与它自己作为背景的观感对不上。
      scene.environmentIntensity = 1
      signals.sceneEnvironmentChanged.dispatch(
        "Equirectangular",
        panoramaTexture.value
      )
    } else {
      scene.environmentIntensity = DEFAULT_ENV_INTENSITY
      signals.sceneEnvironmentChanged.dispatch("Room", null)
    }
  }

  /**
   * 光照对账。恢复路径会把环境按自己的口径重置——`hydrateDirectorScene` 与
   * 「空节点」分支此前各自派发过一次 `'Default'`，旧全量格式还会经 `Editor.fromJSON`
   * 把 `environmentType` 覆写回 json 里的值。它们都发生在本 composable 挂载之后，
   * 于是挂载时断言的影棚环境被静默换回「天空色 PMREM」，画面照旧是一整块暗色。
   *
   * 故照 syncSkyColor 的同一套办法在 sceneGraphChanged 里对账（恢复路径最终都会分发
   * 它）：档位与当前期望不符就重新断言。判等短路使这里不会每次场景增删都白派发一次
   * ——`sceneEnvironmentChanged` 上挂着自动保存。
   */
  function syncEnvironment() {
    if (editor.environmentType === desiredEnvironmentType()) return
    applyEnvironmentLighting()
  }

  watch(panoramaTexture, (texture) => {
    const mesh = ensureSphere()
    const material = mesh.material as THREE.MeshBasicMaterial
    material.map = texture ?? null
    material.needsUpdate = true
    mesh.visible = Boolean(texture)
    applyEnvironmentLighting()
    requestRender()
  })

  // ----- 天空颜色 / 地面网格跟随 -----

  function applyBackgroundColor(hex: string) {
    signals.sceneBackgroundChanged.dispatch(
      "Color",
      hex,
      null,
      null,
      THREE.NoColorSpace,
      0,
      1,
      0
    )
  }

  /**
   * 场景恢复发生在挂载之后，且旧全量格式经 Editor.setScene() 恢复 scene.background
   * 时完全绕过 sceneBackgroundChanged。恢复路径最终都会分发 sceneGraphChanged，故在
   * 该信号里对账：背景已是 Color 就保持不动（面板的色板从它回读），否则重新断言默认色
   * ——本构建的不变式是 scene.background 始终为一个平面 Color，不能让它静默回退到
   * 渲染器默认灰色清除色（Viewport.ts 的 setClearColor(0xaaaaaa)）。
   */
  function syncSkyColor() {
    const background = scene.background as THREE.Color | null
    if (background && (background as any).isColor) return
    applyBackgroundColor(DEFAULT_SKY_COLOR)
  }

  /**
   * 地面网格（editor.grid，由 Viewport.ts 作为独立通道渲染、不是 scene 的子节点）
   * 跟随场景变换。地面高度是叠加在场景 y 之上的偏移，取 directorSceneProperties 的
   * 会话单点源而不是从 grid/scene 反推。
   *
   * 场景恢复（hydrateDirectorScene）直接改写 scene 变换、不经任何命令，故 grid 必须
   * 在这里显式对齐；撤销/重做路径中 handler 已联动 grid，重复应用同值无副作用。
   */
  function syncGridFromScene() {
    editor.grid.scale.copy(scene.scale)
    editor.grid.rotation.copy(scene.rotation)
    editor.grid.position.set(
      scene.position.x,
      scene.position.y + currentGroundHeight(),
      scene.position.z
    )
  }

  function syncFromScene() {
    syncSkyColor()
    syncEnvironment()
    syncGridFromScene()
  }

  onMounted(() => {
    // 每次导演台挂载都是全新 Editor 实例，模块级的地面高度单点源须随之复位
    // （见 .claude/rules/three-editor.md §3）。
    resetDirectorSceneSession()

    ensureSphere()
    applyBackgroundColor(DEFAULT_SKY_COLOR)
    // 没有全景图时 panoramaTexture 一直是 null，上面那个 watch 不会触发，故光照要在
    // 这里显式断言一次——否则环境停在 Editor 的出厂值 'Default'（= 拿近黑的天空色
    // 当光源），场景全程处在那片几乎为零的均匀环境里。
    applyEnvironmentLighting()
    syncGridFromScene()

    const material = editor.groundPlane.material as THREE.Material
    material.opacity = DEFAULT_GROUND_OPACITY
    material.needsUpdate = true
    // 导演台专属：地面颜色填充扩展为覆盖全景球赤道切面的圆形，半径随全景球半径
    // （three-editor 默认保持与网格等大的方形填充）。
    editor.setGroundExtent(DEFAULT_PANORAMA_RADIUS)

    signals.sceneGraphChanged.add(syncFromScene)
  })

  onBeforeUnmount(() => {
    // 先立旗：在途的解码随后到达时按 stale() 自行销毁，不再往这个已经收过尾的 ref 里写。
    // **不**顺手把 ref 置空——那会触发上面 watch(panoramaTexture) 里的球体材质改写与
    // applyEnvironmentLighting，在卸载途中对一个正在拆的场景派发环境变更。
    unmounted = true
    signals.sceneGraphChanged.remove(syncFromScene)
    dismissLoadingToast()
    panoramaTexture.value?.dispose()
  })
}
