import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const uploadAsset = vi.fn()
const captureVideoPoster = vi.fn()
const toastError = vi.fn()

vi.mock("@/lib/asset-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-upload")>()),
  uploadFlowAsset: (...args: unknown[]) => uploadAsset(...args)
}))
vi.mock("@/lib/video-poster", () => ({ captureVideoPoster: (...args: unknown[]) => captureVideoPoster(...args) }))
vi.mock("vue-sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const { addNodesFromFiles, fileNodeKind, fileNodeLabel, TEXT_FILE_MAX_BYTES } = await import(
  "@/components/flow/file-nodes"
)
const { nodeUploadOf } = await import("@/components/flow/node-upload")

function makeEditor() {
  let n = 0
  const addNode = vi.fn(async () => `n${++n}`)
  const attachAsset = vi.fn()
  const editor = { canvas: { addNode }, store: { attachAsset }, flowId: ref("f1") }
  return { editor: editor as never, addNode, attachAsset }
}

/** 节点 body 读登记表用的是 `NodePartContext`，这里只给它要的两样 */
function uploadingOf(nodeId: string) {
  return nodeUploadOf({ id: nodeId, editor: { flowId: ref("f1") } } as never)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  uploadAsset.mockReset()
  captureVideoPoster.mockReset()
  toastError.mockReset()
})

describe("fileNodeKind / fileNodeLabel", () => {
  it("按 MIME 认图片 / 视频 / 文本，MIME 为空时按扩展名认文本，别的不收", () => {
    expect(fileNodeKind({ name: "a.png", type: "image/png" })).toBe("image")
    expect(fileNodeKind({ name: "a.mp4", type: "video/mp4" })).toBe("video")
    expect(fileNodeKind({ name: "a.txt", type: "text/plain" })).toBe("text")
    expect(fileNodeKind({ name: "a.json", type: "application/json" })).toBe("text")
    expect(fileNodeKind({ name: "README.md", type: "" })).toBe("text")
    expect(fileNodeKind({ name: "a.pdf", type: "application/pdf" })).toBeNull()
    expect(fileNodeKind({ name: "md", type: "" })).toBeNull()
  })

  it("节点名是去掉扩展名的文件名；只有扩展名的保留原名", () => {
    expect(fileNodeLabel("photo.final.png")).toBe("photo.final")
    expect(fileNodeLabel(".env")).toBe(".env")
    expect(fileNodeLabel("notes")).toBe("notes")
  })
})

describe("addNodesFromFiles", () => {
  it("图片：先在右键那一点建图片节点、立刻登记上传中，传完经 attachAsset 挂 src", async () => {
    const { editor, addNode, attachAsset } = makeEditor()
    let finish!: (value: { url: string }) => void
    uploadAsset.mockReturnValue(new Promise((resolve) => (finish = resolve)))

    await addNodesFromFiles(editor, [new File(["x"], "cat.png", { type: "image/png" })], { x: 100, y: 200 })

    expect(addNode).toHaveBeenCalledWith("image", { point: { x: 100, y: 200 }, label: "cat" })
    expect(uploadAsset).toHaveBeenCalledWith("f1", expect.any(File), expect.anything())
    expect(uploadingOf("n1")).toBeTruthy()

    finish({ url: "https://s3/cat.png" })
    await flush()
    expect(attachAsset).toHaveBeenCalledWith("n1", { src: "https://s3/cat.png" }, "上传图片")
    expect(uploadingOf("n1")).toBeUndefined()
  })

  it("视频：建视频节点，视频和截出的预览图一起传，一次挂 src / poster", async () => {
    const { editor, addNode, attachAsset } = makeEditor()
    captureVideoPoster.mockResolvedValue(new Blob(["p"]))
    uploadAsset.mockImplementation(async (_flow: string, _file: Blob, io: { filename?: string }) => ({
      url: io.filename === "poster.jpg" ? "https://s3/poster.jpg" : "https://s3/v.mp4"
    }))

    await addNodesFromFiles(editor, [new File(["v"], "v.mp4", { type: "video/mp4" })], { x: 0, y: 0 })
    await flush()

    expect(addNode).toHaveBeenCalledWith("video", { point: { x: 0, y: 0 }, label: "v" })
    expect(attachAsset).toHaveBeenCalledWith("n1", { src: "https://s3/v.mp4", poster: "https://s3/poster.jpg" }, "上传视频")
  })

  it("文本：读出内容当正文，和建节点一起写，不上传对象存储", async () => {
    const { editor, addNode } = makeEditor()

    await addNodesFromFiles(editor, [new File(["你好"], "note.md", { type: "" })], { x: 5, y: 6 })

    expect(addNode).toHaveBeenCalledWith("text", { point: { x: 5, y: 6 }, label: "note", data: { text: "你好" } })
    expect(uploadAsset).not.toHaveBeenCalled()
  })

  it("不支持的类型、超限的文本：提示、不建节点；多个文件只给建出来的依次错开", async () => {
    const { editor, addNode } = makeEditor()
    uploadAsset.mockResolvedValue({ url: "u" })
    const big = new File(["x".repeat(TEXT_FILE_MAX_BYTES + 1)], "big.txt", { type: "text/plain" })

    await addNodesFromFiles(
      editor,
      [
        new File(["a"], "a.pdf", { type: "application/pdf" }),
        big,
        new File(["1"], "one.txt", { type: "text/plain" }),
        new File(["2"], "two.png", { type: "image/png" })
      ],
      { x: 0, y: 0 }
    )

    expect(toastError).toHaveBeenCalledTimes(2)
    expect(addNode.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { point: { x: 0, y: 0 }, label: "one", data: { text: "1" } },
      { point: { x: 32, y: 32 }, label: "two" }
    ])
  })

  it("上传失败：toast 原因，节点留着；取消不提示", async () => {
    const { editor, attachAsset } = makeEditor()
    uploadAsset.mockRejectedValueOnce(new Error("网络断了"))
    uploadAsset.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))

    await addNodesFromFiles(
      editor,
      [new File(["x"], "a.png", { type: "image/png" }), new File(["y"], "b.png", { type: "image/png" })],
      { x: 0, y: 0 }
    )
    await flush()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith("网络断了")
    expect(attachAsset).not.toHaveBeenCalled()
  })
})
