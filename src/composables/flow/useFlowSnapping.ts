import { ref, shallowRef } from "vue"
import { useVueFlow, type GraphNode } from "@vue-flow/core"
import { boundingRect, computeSnap, type SnapGuide, type SnapRect } from "@/lib/flow-snap"

/**
 * 网格大小。`FlowCanvas` 的 `<Background>` 也用这个值 —— 吸附的格子和看得见的
 * 点阵必须是同一套，否则「吸到网格上」在画面上对不齐任何东西。
 */
export const FLOW_GRID_SIZE = 4

export const FLOW_GRID_GAP = 16

/**
 * 辅助线的吸附半径，单位是**屏幕像素**：实际判定前会除以缩放，
 * 所以放大到 4 倍时手感和 1 倍时一样，而不是变成一个巨大的磁力范围。
 */
const GUIDE_THRESHOLD_PX = 4

/**
 * 拖动时的吸附：网格 + 辅助线，两者都**始终生效，没有开关**。
 *
 * 不给开关是有意的：格子就是背景那圈点阵，辅助线只在真的对齐时才出现、平时完全不干预 ——
 * 两者都是「默认就该有的手感」，一枚开关只会让人多点一下才拿到它，还得替两种状态各解释一遍。
 * 于是也没有任何要持久化的东西：不进 Y.Doc，也不占浏览器本地存储。
 *
 * **只作用在拖动上**，不碰已有节点的位置：打开一张画布，画布长什么样就是什么样，
 * 不会有一堆节点被悄悄挪到格子上 —— 那种挪动只发生在本地视图里、不进文档，
 * 别人看到的又是另一套，纯粹是制造分歧。
 *
 * 因此没有用 Vue Flow 自带的 `:snap-to-grid`：它除了拖动，还会在**节点挂载时**
 * （`NodeWrapper` 的 `clampPosition`）把位置对到格子上，正好就是上面那种分歧；
 * 而且它先于我们的对齐判定发生，两套吸附各改各的更难说清最终位置是怎么来的。
 * 这里把两种吸附收在同一个函数里算，结果只有一个位移。
 */
export function useFlowSnapping() {
  const { getNodes, viewport } = useVueFlow()

  /** 当前要画的辅助线；只在拖动期间非空 */
  const guides = ref<SnapGuide[]>([])

  /**
   * 参照物在**按下的那一刻**量一次就够了：拖动期间它们不动，
   * 每帧重新遍历一遍所有节点纯属浪费（画布上限是 2000 个节点）。
   */
  const targets = shallowRef<SnapRect[]>([])

  function rectOf(node: GraphNode): SnapRect {
    // 这里一律用 `position` 而不是 `computedPosition`：拖动过程中后者由一个
    // post-flush 的 watcher 维护，`onNodeDrag` 跑的时候它还是上一帧的值。
    // （本编辑器没有父子节点，两者对顶层节点本来就相等。）
    return {
      x: node.position.x,
      y: node.position.y,
      width: node.dimensions.width,
      height: node.dimensions.height
    }
  }

  /** 拖动开始：记下参照物 */
  function begin(dragged: readonly GraphNode[]) {
    guides.value = []

    const moving = new Set(dragged.map((node) => node.id))
    targets.value = getNodes.value
      .filter(
        (node) =>
          !moving.has(node.id) &&
          !node.hidden &&
          // 还没量出尺寸的节点参与对齐只会得到一条错位的线
          node.dimensions.width > 0 &&
          node.dimensions.height > 0
      )
      .map(rectOf)
  }

  /**
   * 拖动过程中修正位置。
   *
   * 直接改 `node.position` 是有意的：Vue Flow 每次拖动事件都从**指针位置**重新
   * 算一遍节点位置，我们这一下改完不会被累加到下一帧 —— 手离开对齐线时吸附自然松开。
   * 而且它发生在 Vue Flow 写完位置、渲染之前，中间那个未吸附的位置不会被画出来。
   */
  function apply(dragged: readonly GraphNode[]) {
    // 多选拖动按外接矩形算，位移原样发给每一个，相对位置才不会被拆散
    const box = boundingRect(dragged.map(rectOf))
    if (!box) return

    const { delta, guides: next } = computeSnap(box, targets.value, {
      grid: FLOW_GRID_SIZE,
      // 容差按屏幕像素折算：放大时磁力范围不该跟着一起放大
      threshold: GUIDE_THRESHOLD_PX / (viewport.value.zoom || 1)
    })

    if (delta.x !== 0 || delta.y !== 0) {
      for (const node of dragged) {
        // 换新对象而不是就地改 x/y：这个 `position` 对象和 store 投影里的那份
        // 是同一个引用（Vue Flow 的 parseNode 是 Object.assign 浅拷贝）
        node.position = { x: node.position.x + delta.x, y: node.position.y + delta.y }
      }
    }

    guides.value = next
  }

  /** 拖动结束：线收掉，参照物丢掉 */
  function end() {
    guides.value = []
    targets.value = []
  }

  return {
    guides,
    begin,
    apply,
    end
  }
}

export type FlowSnapping = ReturnType<typeof useFlowSnapping>
