/**
 * 从本地视频文件截一帧当预览图（JPEG）。
 *
 * 在上传**之前**用本地文件截：读的是 object URL，同源，canvas 不会被污染；
 * 等传到 S3 再截就得那边配 CORS。截不出来（格式浏览器不认、超时）就回 null —— 预览图是锦上添花，
 * 不该挡住视频本身的上传。
 */
export async function captureVideoPoster(file: Blob, { at = 0.1, timeoutMs = 8000 } = {}): Promise<Blob | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement("video")
  video.muted = true
  video.playsInline = true
  video.preload = "auto"

  try {
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      const done = (ok: boolean) => {
        clearTimeout(timer)
        resolve(ok)
      }
      video.addEventListener("error", () => done(false), { once: true })
      video.addEventListener(
        "loadedmetadata",
        () => {
          // 太短的视频跳到 0.1s 也可能越界，夹一下
          video.currentTime = Math.min(at, Math.max(0, (video.duration || 0) - 0.01))
        },
        { once: true }
      )
      video.addEventListener("seeked", () => done(true), { once: true })
    })
    video.src = url
    if (!(await ready) || !video.videoWidth || !video.videoHeight) return null

    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext("2d")
    if (!context) return null
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85))
  } catch {
    return null
  } finally {
    video.removeAttribute("src")
    URL.revokeObjectURL(url)
  }
}
