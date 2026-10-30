import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, ref } from "vue"

vi.mock("vue-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

type UploadIo = { signal: AbortSignal; onProgress: (loaded: number, total: number) => void }
const uploadAsset = vi.fn()
vi.mock("@/lib/asset-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-upload")>()),
  uploadFlowAsset: (...args: unknown[]) => uploadAsset(...args)
}))

const { default: AssetUploadList } = await import("@/components/flow/asset-upload/AssetUploadList.vue")
const { useAssetUploadList } = await import("@/composables/useAssetUpload")

/**
 * 附件上传组件（`ui/attachment` 之上）：加号虚线方框选文件（多选）、缩略图小方块、每项状态
 * （不分片只转圈、分片带百分比、失败红色可重试 —— 都不是进度条）、删除、满了不再给加号。
 */

const pending: { io: UploadIo; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []
let wrapper: VueWrapper | null = null

beforeEach(() => {
  pending.length = 0
  uploadAsset.mockReset().mockImplementation(
    (_flowId: string, _file: File, io: UploadIo) =>
      new Promise((resolve, reject) => {
        pending.push({ io, resolve, reject })
        io.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })
  )
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`)
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function mountList(options: { max?: number; disabled?: boolean; addable?: boolean } = {}) {
  let list!: ReturnType<typeof useAssetUploadList>
  const Host = defineComponent({
    setup() {
      list = useAssetUploadList(ref("f1"), options.max === undefined ? {} : { max: options.max })
      return () => h(AssetUploadList, { list, disabled: options.disabled ?? false, addable: options.addable ?? true })
    }
  })
  wrapper = mount(Host, { attachTo: document.body })
  return { wrapper, list: () => list }
}

async function pick(target: VueWrapper, files: File[]) {
  const input = target.get('[data-testid="asset-upload-input"]')
  Object.defineProperty(input.element, "files", { value: files, configurable: true })
  await input.trigger("change")
  await flushPromises()
}

const tiles = (target: VueWrapper) => target.findAll('[data-testid="asset-upload-tile"]')

describe("AssetUploadList", () => {
  it("入口是 idle 态的虚线方框；点它打开文件选择（多选，默认只收图片和视频）", async () => {
    const { wrapper } = mountList()
    const add = wrapper.get('[data-testid="asset-upload-add"]')
    const entry = add.element.closest('[data-slot="attachment"]')!
    expect(entry.getAttribute("data-state")).toBe("idle")
    expect(entry.className).toContain("border-dashed")
    const input = wrapper.get('[data-testid="asset-upload-input"]')
    expect(input.attributes("multiple")).toBeDefined()
    expect(input.attributes("accept")).toBe("image/*,video/*")

    const click = vi.spyOn(input.element as HTMLInputElement, "click")
    await add.trigger("click")
    expect(click).toHaveBeenCalled()
  })

  it("上传中：不分片 processing 只转圈、分片 uploading 带百分比；预览半透明；没有进度条", async () => {
    const { wrapper } = mountList()
    await pick(wrapper, [new File(["x"], "a.png", { type: "image/png" })])
    const tile = tiles(wrapper)[0]!
    expect(tile.attributes("data-state")).toBe("processing")
    expect(tile.find('[role="status"]').exists()).toBe(true)
    expect(tile.find('[data-testid="asset-upload-percent"]').exists()).toBe(false)
    expect(tile.get('[data-slot="attachment-media"]').classes()).toContain("opacity-60")
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)

    pending[0]!.io.onProgress(50, 200)
    await flushPromises()
    expect(tile.attributes("data-state")).toBe("uploading")
    expect(tile.get('[data-testid="asset-upload-percent"]').text()).toBe("25%")

    pending[0]!.resolve({ key: "k", url: "https://s3.test/a.png", contentType: "image/png", size: 1 })
    await flushPromises()
    expect(tile.attributes("data-state")).toBe("done")
    expect(tile.find('[data-testid="asset-upload-pending"]').exists()).toBe(false)
  })

  it("删除按钮（AttachmentAction）收得到点击和 class：上传中删 = 取消；失败的整块点击重试", async () => {
    const { wrapper } = mountList()
    await pick(wrapper, [new File(["x"], "a.png", { type: "image/png" }), new File(["y"], "b.png", { type: "image/png" })])
    const remove = tiles(wrapper)[0]!.get('[data-testid="asset-upload-remove"]')
    expect(remove.attributes("data-slot")).toBe("attachment-action")
    expect(remove.classes()).toContain("rounded-full")
    expect(remove.attributes("aria-label")).toBe("取消上传 a.png")
    await remove.trigger("click")
    await flushPromises()
    expect(pending[0]!.io.signal.aborted).toBe(true)
    expect(tiles(wrapper)).toHaveLength(1)

    pending[1]!.reject(new Error("网络错误"))
    await flushPromises()
    const failed = tiles(wrapper)[0]!
    expect(failed.attributes("data-state")).toBe("error")
    expect(failed.attributes("title")).toBe("网络错误（点击重试）")
    await failed.get('[data-testid="asset-upload-retry"]').trigger("click")
    await flushPromises()
    expect(uploadAsset).toHaveBeenCalledTimes(3)
    expect(tiles(wrapper)[0]!.attributes("data-state")).toBe("processing")
  })

  it("满了不再显示加号方框；disabled 时加号和删除都点不了", async () => {
    const full = mountList({ max: 1 })
    await pick(full.wrapper, [new File(["x"], "a.png", { type: "image/png" })])
    expect(full.wrapper.find('[data-testid="asset-upload-add"]').exists()).toBe(false)
    full.wrapper.unmount()

    const { wrapper: disabled } = mountList({ disabled: true })
    expect(disabled.get('[data-testid="asset-upload-add"]').attributes("disabled")).toBeDefined()
  })

  it("addable 为 false 时不画加号方框，入口交给父组件", () => {
    const { wrapper } = mountList({ addable: false })
    expect(wrapper.find('[data-testid="asset-upload-add"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="asset-upload-input"]').exists()).toBe(false)
  })
})
