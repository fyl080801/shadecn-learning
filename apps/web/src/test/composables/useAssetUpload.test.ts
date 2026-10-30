import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"

const toastWarning = vi.fn()
vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: (...args: unknown[]) => toastWarning(...args) }
}))

type UploadIo = { signal: AbortSignal; onProgress: (loaded: number, total: number) => void }
const uploadAsset = vi.fn()
vi.mock("@/lib/asset-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-upload")>()),
  uploadFlowAsset: (...args: unknown[]) => uploadAsset(...args)
}))

const { startUpload, useAssetUploadList } = await import("@/composables/useAssetUpload")
const { isUploadCanceled } = await import("@/lib/asset-upload")

/**
 * 上传的有状态那一半（节点和 agent 附件共用）：状态机、进度（分片才有百分比，不分片一直 null）、取消；
 * 以及附件列表的增删、重试、发送时摘走 / 还回、换画布清空、预览地址的回收。
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("startUpload：一次上传的句柄", () => {
  it("进度：没报过就是 null（不分片的一直这样）；报了按百分比取整；成功 → done + result", async () => {
    let io!: UploadIo
    const task = deferred<string>()
    const upload = startUpload((given) => {
      io = given
      return task.promise
    })
    expect(upload.status).toBe("uploading")
    expect(upload.progress).toBeNull()

    io.onProgress(1, 3)
    expect(upload.progress).toBe(33)
    io.onProgress(0, 0)
    expect(upload.progress).toBeNull()

    task.resolve("ok")
    await expect(upload.done).resolves.toBe("ok")
    expect(upload).toMatchObject({ status: "done", result: "ok", error: null })
  })

  it("失败 → error + 给人看的原因；done reject 原错误", async () => {
    const upload = startUpload(async () => {
      throw new Error("只支持图片或视频")
    })
    await expect(upload.done).rejects.toThrow("只支持图片或视频")
    expect(upload).toMatchObject({ status: "error", error: "只支持图片或视频", result: null })
  })

  it("取消 → 断开 signal、状态 canceled（不算失败、没有原因）；结束之后再取消没有效果", async () => {
    let signal!: AbortSignal
    const upload = startUpload(
      (io) =>
        new Promise<string>((_, reject) => {
          signal = io.signal
          io.signal.addEventListener("abort", () => reject(io.signal.reason))
        })
    )
    upload.cancel()
    expect(signal.aborted).toBe(true)
    const error = await upload.done.catch((caught: unknown) => caught)
    expect(isUploadCanceled(error)).toBe(true)
    expect(upload).toMatchObject({ status: "canceled", error: null })

    const finished = startUpload(async () => "ok")
    await finished.done
    finished.cancel()
    expect(finished.status).toBe("done")
  })

  it("传完的那一刻刚好点了取消（任务没理 signal）→ 以取消为准，不给结果", async () => {
    const task = deferred<string>()
    const upload = startUpload(() => task.promise)
    upload.cancel()
    task.resolve("ok")
    await upload.done.catch(() => undefined)
    expect(upload).toMatchObject({ status: "canceled", result: null })
  })

  it("没人 await done 也不会留下未处理的 rejection（vitest 把未处理的 rejection 记为整次运行失败）", async () => {
    const upload = startUpload(async () => {
      throw new Error("x")
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(upload.status).toBe("error")
  })
})

describe("useAssetUploadList：附件列表", () => {
  const pending: { file: File; io: UploadIo; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []

  beforeEach(() => {
    pending.length = 0
    toastWarning.mockReset()
    uploadAsset.mockReset().mockImplementation(
      (_flowId: string, file: File, io: UploadIo) =>
        new Promise((resolve, reject) => {
          pending.push({ file, io, resolve, reject })
          io.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
    )
    URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`)
    URL.revokeObjectURL = vi.fn()
  })

  let scope = effectScope()
  afterEach(() => scope.stop())

  function setup(flowId = ref("f1"), max?: number) {
    scope = effectScope()
    const list = scope.run(() => useAssetUploadList(flowId, max === undefined ? {} : { max }))!
    return { list, flowId }
  }

  const png = (name: string) => new File(["x"], name, { type: "image/png" })
  const asset = (name: string) => ({ key: `k/${name}`, url: `https://s3.test/${name}`, contentType: "image/png", size: 1 })

  it("加文件 → 每个立刻传到这张画布；图片 / 视频有本地预览，其他类型没有；uploading / ready 跟着变", async () => {
    const { list } = setup()
    list.add([png("a.png"), new File(["v"], "b.mp4", { type: "video/mp4" }), new File(["d"], "c.pdf", { type: "application/pdf" })])
    expect(uploadAsset.mock.calls.map((call) => [call[0], (call[1] as File).name])).toEqual([
      ["f1", "a.png"],
      ["f1", "b.mp4"],
      ["f1", "c.pdf"]
    ])
    expect(list.items.map((item) => [item.kind, item.previewUrl])).toEqual([
      ["image", "blob:a.png"],
      ["video", "blob:b.mp4"],
      ["file", null]
    ])
    expect(list.uploading).toBe(true)
    expect(list.ready).toHaveLength(0)

    for (const [index, entry] of pending.entries()) entry.resolve(asset(String(index)))
    await nextTick()
    await Promise.all(list.items.map((item) => item.upload.done))
    expect(list.uploading).toBe(false)
    expect(list.ready.map((item) => item.upload.result?.key)).toEqual(["k/0", "k/1", "k/2"])
  })

  it("超过上限 → 多出的不加、提示一声；满了 remaining 为 0", () => {
    const { list } = setup(ref("f1"), 2)
    list.add([png("a.png"), png("b.png"), png("c.png")])
    expect(list.items.map((item) => item.name)).toEqual(["a.png", "b.png"])
    expect(list.remaining).toBe(0)
    expect(toastWarning).toHaveBeenCalledWith("最多 2 个附件，多出的 1 个没有加上")
  })

  it("删除：上传中的取消请求；预览地址撤销", () => {
    const { list } = setup()
    list.add([png("a.png")])
    list.remove(list.items[0]!.id)
    expect(pending[0]!.io.signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a.png")
    expect(list.items).toHaveLength(0)
  })

  it("失败 → failed；重试换一次新的上传（同一个文件），成功的不重试", async () => {
    const { list } = setup()
    list.add([png("a.png")])
    pending[0]!.reject(new Error("网络错误"))
    await list.items[0]!.upload.done.catch(() => undefined)
    expect(list.failed).toBe(true)
    expect(list.items[0]!.upload.error).toBe("网络错误")

    list.retry(list.items[0]!.id)
    expect(pending).toHaveLength(2)
    expect(pending[1]!.file.name).toBe("a.png")
    expect(list.failed).toBe(false)
    pending[1]!.resolve(asset("a"))
    await list.items[0]!.upload.done
    list.retry(list.items[0]!.id)
    expect(pending).toHaveLength(2)
  })

  it("发送：摘走全部（预览地址不撤销）→ 没发出去还回来排在新加的前面；发出去了 release 才撤销", async () => {
    const { list } = setup()
    list.add([png("a.png")])
    const taken = list.detach()
    expect(list.items).toHaveLength(0)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    list.add([png("b.png")])
    list.restore(taken)
    expect(list.items.map((item) => item.name)).toEqual(["a.png", "b.png"])

    list.release(list.detach())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a.png")
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:b.png")
  })

  it("换画布 → 清空，在传的取消；之后加的传到新画布", async () => {
    const { list, flowId } = setup()
    list.add([png("a.png")])
    flowId.value = "f2"
    await nextTick()
    expect(pending[0]!.io.signal.aborted).toBe(true)
    expect(list.items).toHaveLength(0)

    list.add([png("b.png")])
    expect(uploadAsset.mock.calls[uploadAsset.mock.calls.length - 1]?.[0]).toBe("f2")
  })

  it("作用域销毁（组件卸载）→ 在传的取消、预览地址撤销", () => {
    const { list } = setup()
    list.add([png("a.png")])
    scope.stop()
    expect(pending[0]!.io.signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a.png")
  })
})
