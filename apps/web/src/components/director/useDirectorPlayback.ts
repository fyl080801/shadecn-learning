import { onScopeDispose, ref, watch, type Ref } from "vue"

/** 帧调度（测试里换成手动推进的） */
export interface FrameScheduler {
  request(callback: (now: number) => void): number
  cancel(handle: number): void
}

const browserScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle)
}

/**
 * 导演台的播放状态（docs/07 §7.2「不进 Y.Doc 的」）：播放头、播放中 / 暂停、循环 —— **都是本地的**，
 * 每个人各自播放，**一个字节都不写 doc**。
 *
 * 播放头一变就调 `onFrame(t)`（调用方拿它去 `objectStateAt` 求值、写投影对象）。
 * 时长 `duration` 由数据定（`dc.duration`）；播放头超出时长时夹回去。
 */
export function useDirectorPlayback(options: {
  /** 时长，毫秒 */
  duration: Readonly<Ref<number>>
  /** 帧率：拖播放头时吸附到帧 */
  fps: Readonly<Ref<number>>
  onFrame: (t: number) => void
  scheduler?: FrameScheduler
}) {
  const scheduler = options.scheduler ?? browserScheduler
  /** 播放头，毫秒 */
  const playhead = ref(0)
  const playing = ref(false)
  /** 默认循环（docs/07 §7.8） */
  const loop = ref(true)

  let handle: number | null = null
  let lastNow: number | null = null

  function tick(now: number) {
    handle = null
    if (!playing.value) return
    const dt = lastNow === null ? 0 : Math.max(0, now - lastNow)
    lastNow = now
    const duration = Math.max(1, options.duration.value)
    let next = playhead.value + dt
    if (next >= duration) {
      if (loop.value) next = next % duration
      else {
        next = duration
        playing.value = false
      }
    }
    playhead.value = next
    if (playing.value) handle = scheduler.request(tick)
  }

  function play() {
    if (playing.value) return
    // 停在末尾时从头播
    if (playhead.value >= options.duration.value) playhead.value = 0
    playing.value = true
    lastNow = null
    handle = scheduler.request(tick)
  }

  function pause() {
    playing.value = false
    if (handle !== null) scheduler.cancel(handle)
    handle = null
    lastNow = null
  }

  function toggle() {
    if (playing.value) pause()
    else play()
  }

  /** 拖播放头：吸附到帧（整毫秒），夹在 [0, 时长] */
  function seek(ms: number) {
    const frame = 1000 / Math.max(1, options.fps.value)
    const snapped = Math.round(Math.round(ms / frame) * frame)
    playhead.value = Math.min(Math.max(0, snapped), options.duration.value)
  }

  // 播放头动了就求值；时长缩短了把播放头夹回去
  watch(playhead, (t) => options.onFrame(t))
  watch(options.duration, (duration) => {
    if (playhead.value > duration) playhead.value = duration
  })

  onScopeDispose(pause)

  return { playhead, playing, loop, play, pause, toggle, seek }
}

export type DirectorPlayback = ReturnType<typeof useDirectorPlayback>
