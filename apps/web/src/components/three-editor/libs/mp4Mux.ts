// 简单的 H.264 编码分片 MP4 封装器

interface EncodedChunk {
  data: Uint8Array
  timestamp: number
  type: string
}

export function createMP4(
  chunks: EncodedChunk[],
  avcC: Uint8Array,
  width: number,
  height: number,
  fps: number
) {
  const timescale = 90000
  const frameDuration = timescale / fps

  function u32(value: number) {
    return new Uint8Array([
      (value >> 24) & 0xff,
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff
    ])
  }

  function u16(value: number) {
    return new Uint8Array([(value >> 8) & 0xff, value & 0xff])
  }

  function str(s: string) {
    return new TextEncoder().encode(s)
  }

  function concat(...arrays: Uint8Array[]) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const arr of arrays) {
      result.set(arr, offset)
      offset += arr.length
    }

    return result
  }

  function box(type: string, ...contents: Uint8Array[]) {
    const data = concat(...contents)
    const size = data.length + 8
    return concat(u32(size), str(type), data)
  }

  function fullBox(
    type: string,
    version: number,
    flags: number,
    ...contents: Uint8Array[]
  ) {
    return box(
      type,
      new Uint8Array([
        version,
        (flags >> 16) & 0xff,
        (flags >> 8) & 0xff,
        flags & 0xff
      ]),
      ...contents
    )
  }

  // ftyp（文件类型盒）
  const ftyp = box(
    "ftyp",
    str("isom"),
    u32(512),
    str("isom"),
    str("iso2"),
    str("avc1"),
    str("mp41")
  )

  // 收集采样信息
  const sampleSizes: number[] = []
  const syncSamples: number[] = []

  chunks.forEach((chunk, i) => {
    sampleSizes.push(chunk.data.length)
    if (chunk.type === "key") syncSamples.push(i + 1)
  })

  // mdat（媒体数据盒）
  let mdatSize = 8
  for (const chunk of chunks) mdatSize += chunk.data.length

  // stsd - 采样描述
  const avc1 = box(
    "avc1",
    new Uint8Array(6), // 保留
    u16(1), // 数据引用索引
    new Uint8Array(16), // 预定义 + 保留
    u16(width),
    u16(height),
    u32(0x00480000), // 水平分辨率 72 dpi
    u32(0x00480000), // 垂直分辨率 72 dpi
    u32(0), // 保留
    u16(1), // 帧数
    new Uint8Array(32), // 压缩器名称
    u16(0x0018), // 深度
    new Uint8Array([0xff, 0xff]), // 预定义
    box("avcC", avcC)
  )

  const stsd = fullBox("stsd", 0, 0, u32(1), avc1)

  // stts - 时间到采样
  const stts = fullBox(
    "stts",
    0,
    0,
    u32(1),
    u32(chunks.length),
    u32(frameDuration)
  )

  // stsc - 采样到分块
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(chunks.length), u32(1))

  // stsz - 采样大小
  const stszData = [u32(0), u32(chunks.length)]
  for (const size of sampleSizes) stszData.push(u32(size))
  const stsz = fullBox("stsz", 0, 0, ...stszData)

  // stco - 分块偏移（占位，稍后更新）
  const stco = fullBox("stco", 0, 0, u32(1), u32(0))

  // stss - 同步采样
  const stssData = [u32(syncSamples.length)]
  for (const sync of syncSamples) stssData.push(u32(sync))
  const stss = fullBox("stss", 0, 0, ...stssData)

  // stbl（采样表盒）
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco, stss)

  // dinf（数据信息盒）
  const dref = fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))
  const dinf = box("dinf", dref)

  // vmhd（视频媒体头盒）
  const vmhd = fullBox("vmhd", 0, 1, new Uint8Array(8))

  // minf（媒体信息盒）
  const minf = box("minf", vmhd, dinf, stbl)

  // hdlr（处理器引用盒）
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0), // 预定义
    str("vide"),
    new Uint8Array(12), // 保留
    str("VideoHandler"),
    new Uint8Array(1)
  )

  // mdhd（媒体头盒）
  const durationInTimescale = chunks.length * frameDuration
  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0), // 创建时间
    u32(0), // 修改时间
    u32(timescale),
    u32(durationInTimescale),
    u16(0x55c4), // 语言（und）
    u16(0) // 质量
  )

  // mdia（媒体盒）
  const mdia = box("mdia", mdhd, hdlr, minf)

  // tkhd（轨道头盒）
  const tkhd = fullBox(
    "tkhd",
    0,
    3,
    u32(0), // 创建时间
    u32(0), // 修改时间
    u32(1), // 轨道 ID
    u32(0), // 保留
    u32(durationInTimescale),
    new Uint8Array(8), // 保留
    u16(0), // 层
    u16(0), // 备用组
    u16(0), // 音量
    u16(0), // 保留
    // 矩阵
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
    u32(width << 16), // 宽度（16.16 定点数）
    u32(height << 16) // 高度（16.16 定点数）
  )

  // trak（轨道盒）
  const trak = box("trak", tkhd, mdia)

  // mvhd（影片头盒）
  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0), // 创建时间
    u32(0), // 修改时间
    u32(timescale),
    u32(durationInTimescale),
    u32(0x00010000), // 速率（1.0）
    u16(0x0100), // 音量（1.0）
    new Uint8Array(10), // 保留
    // 矩阵
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
    new Uint8Array(24), // 预定义
    u32(2) // 下一个轨道 ID
  )

  // moov（影片盒）
  const moov = box("moov", mvhd, trak)

  // 计算实际的 mdat 偏移并更新 stco
  const mdatOffset = ftyp.length + moov.length
  const moovArray = new Uint8Array(moov)
  // 查找并更新 stco 偏移（在 moov 中搜索 'stco'）
  for (let i = 0; i < moovArray.length - 16; i++) {
    if (
      moovArray[i] === 0x73 &&
      moovArray[i + 1] === 0x74 &&
      moovArray[i + 2] === 0x63 &&
      moovArray[i + 3] === 0x6f
    ) {
      // 找到 'stco'，偏移值位于 i + 12
      const offset = mdatOffset + 8
      moovArray[i + 12] = (offset >> 24) & 0xff
      moovArray[i + 13] = (offset >> 16) & 0xff
      moovArray[i + 14] = (offset >> 8) & 0xff
      moovArray[i + 15] = offset & 0xff
      break
    }
  }

  // 更新 mdat 大小
  const mdatSizeBytes = u32(mdatSize)

  // 合并所有部分
  const result = new Uint8Array(ftyp.length + moovArray.length + mdatSize)
  let offset = 0
  result.set(ftyp, offset)
  offset += ftyp.length
  result.set(moovArray, offset)
  offset += moovArray.length
  result.set(mdatSizeBytes, offset)
  result.set(str("mdat"), offset + 4)
  offset += 8

  for (const chunk of chunks) {
    result.set(chunk.data, offset)
    offset += chunk.data.length
  }

  return result
}

export function formatFileSize(sizeB: number, K = 1024) {
  if (sizeB === 0) return "0B"

  const sizes = [sizeB, sizeB / K, sizeB / K / K].reverse()
  const units = ["B", "KB", "MB"].reverse()
  const index = sizes.findIndex((size) => size >= 1)

  return (
    new Intl.NumberFormat("en-us", {
      useGrouping: true,
      maximumFractionDigits: 1
    }).format(sizes[index]!) + units[index]!
  )
}
