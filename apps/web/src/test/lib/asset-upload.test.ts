import { beforeEach, describe, expect, it, vi } from "vitest"
import { ASSET_PART_SIZE, type AssetUploadSession } from "@shadecn/shared/canvas"

/**
 * 画布资源上传的编排：不超过一片一次传完；更大的按服务端给的分片大小切片、并发传、失败重试，
 * 按片号交回回执；彻底失败就放弃这次上传并把原错误抛出去。只替换 `flowApi`，`ApiError` 用真的。
 */

const api = {
  uploadAsset: vi.fn(),
  startAssetUpload: vi.fn(),
  uploadAssetPart: vi.fn(),
  completeAssetUpload: vi.fn(),
  abortAssetUpload: vi.fn()
}

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  flowApi: api
}))

const { uploadFlowAsset } = await import("@/lib/asset-upload")
const { ApiError } = await import("@/lib/api")

/** 不真分配几十 MB：size 是假的，slice 只记下起止 */
function fakeFile(size: number, type = "video/mp4") {
  return {
    size,
    type,
    name: "clip.mp4",
    slice: (start: number, end: number) => ({ start, end: Math.min(end, size) })
  } as unknown as Blob
}

const session: AssetUploadSession = { uploadId: "u1", key: "k", partSize: 10, partCount: 3 }

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.abortAssetUpload.mockResolvedValue(undefined)
})

describe("uploadFlowAsset", () => {
  it("不超过一片 → 一次传完，不开分片", async () => {
    api.uploadAsset.mockResolvedValue({ url: "u" })
    const file = new File(["x"], "a.png", { type: "image/png" })
    expect(await uploadFlowAsset("f1", file)).toEqual({ url: "u" })
    expect(api.uploadAsset).toHaveBeenCalledWith("f1", file, "a.png")
    expect(api.startAssetUpload).not.toHaveBeenCalled()
  })

  it("超过一片 → 按服务端的分片大小切片，片号从 1 起，按序交回回执", async () => {
    api.startAssetUpload.mockResolvedValue(session)
    api.uploadAssetPart.mockImplementation(async (_f, _s, partNumber: number) => ({
      partNumber,
      etag: `e${partNumber}`
    }))
    api.completeAssetUpload.mockResolvedValue({ url: "done" })

    const file = fakeFile(ASSET_PART_SIZE + 1)
    expect(await uploadFlowAsset("f1", file)).toEqual({ url: "done" })

    expect(api.startAssetUpload).toHaveBeenCalledWith("f1", {
      filename: "file",
      contentType: "video/mp4",
      size: ASSET_PART_SIZE + 1
    })
    const chunks = api.uploadAssetPart.mock.calls.map(([, , n, chunk]) => [n, chunk])
    expect(chunks).toEqual([
      [1, { start: 0, end: 10 }],
      [2, { start: 10, end: 20 }],
      [3, { start: 20, end: 30 }]
    ])
    expect(api.completeAssetUpload).toHaveBeenCalledWith("f1", session, [
      { partNumber: 1, etag: "e1" },
      { partNumber: 2, etag: "e2" },
      { partNumber: 3, etag: "e3" }
    ])
    expect(api.abortAssetUpload).not.toHaveBeenCalled()
  })

  it("最多 3 片同时在传", async () => {
    api.startAssetUpload.mockResolvedValue({ ...session, partCount: 8 })
    let inFlight = 0
    let peak = 0
    api.uploadAssetPart.mockImplementation(async (_f, _s, partNumber: number) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return { partNumber, etag: "e" }
    })
    api.completeAssetUpload.mockResolvedValue({ url: "done" })

    await uploadFlowAsset("f1", fakeFile(ASSET_PART_SIZE + 1))
    expect(api.uploadAssetPart).toHaveBeenCalledTimes(8)
    expect(peak).toBe(3)
  })

  it("一片网络抖动 → 重试后成功，整体照常完成", async () => {
    vi.useFakeTimers()
    try {
      api.startAssetUpload.mockResolvedValue({ ...session, partCount: 1 })
      api.uploadAssetPart
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ partNumber: 1, etag: "e1" })
      api.completeAssetUpload.mockResolvedValue({ url: "done" })

      const pending = uploadFlowAsset("f1", fakeFile(ASSET_PART_SIZE + 1))
      await vi.runAllTimersAsync()
      expect(await pending).toEqual({ url: "done" })
      expect(api.uploadAssetPart).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("4xx 不重试；失败 → 放弃这次上传，抛出原错误", async () => {
    api.startAssetUpload.mockResolvedValue({ ...session, partCount: 1 })
    const error = new ApiError("key 不属于这张画布", 400, null)
    api.uploadAssetPart.mockRejectedValue(error)

    await expect(uploadFlowAsset("f1", fakeFile(ASSET_PART_SIZE + 1))).rejects.toBe(error)
    expect(api.uploadAssetPart).toHaveBeenCalledTimes(1)
    expect(api.completeAssetUpload).not.toHaveBeenCalled()
    expect(api.abortAssetUpload).toHaveBeenCalledWith("f1", { ...session, partCount: 1 })
  })

  it("放弃本身也失败 → 仍然抛出原来的错误", async () => {
    api.startAssetUpload.mockResolvedValue({ ...session, partCount: 1 })
    const error = new ApiError("坏了", 400, null)
    api.uploadAssetPart.mockRejectedValue(error)
    api.abortAssetUpload.mockRejectedValue(new Error("abort 也挂了"))

    await expect(uploadFlowAsset("f1", fakeFile(ASSET_PART_SIZE + 1))).rejects.toBe(error)
  })
})
