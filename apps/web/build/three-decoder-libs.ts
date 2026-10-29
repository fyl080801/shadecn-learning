import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/**
 * three 的 wasm 解码器：运行时按 URL 下载，不进 JS bundle。
 *
 * `components/three-editor/Loader.ts` 里 DRACOLoader / KTX2Loader / Rhino3dmLoader 用
 * `setDecoderPath` 等指向 `/three-editor/libs/...`，loader 会在 Web Worker 里 fetch
 * 这些文件 —— 路径上没有文件时拿到的是 SPA 兜底 HTML，压缩模型就加载失败。
 *
 * 文件直接取自 `node_modules/three/examples/jsm/libs/`，不拷进 `public/`：仓库里不放
 * 二进制，升级 three 时解码器自动跟着同一个版本走（解码器与 loader 版本不配会解析出错）。
 * dev 由中间件按需吐出，build 时作为 asset 写进产物。只挑解码需要的文件，encoder 不带。
 */
const THREE_LIBS_URL = '/three-editor/libs/'
const THREE_LIBS_FILES = [
  'draco/draco_decoder.js',
  'draco/draco_decoder.wasm',
  'draco/draco_wasm_wrapper.js',
  'draco/gltf/draco_decoder.js',
  'draco/gltf/draco_decoder.wasm',
  'draco/gltf/draco_wasm_wrapper.js',
  'basis/basis_transcoder.js',
  'basis/basis_transcoder.wasm',
  'rhino3dm/rhino3dm.js',
  'rhino3dm/rhino3dm.wasm',
]

// apps/web —— 本文件在 apps/web/vite-plugins/ 下，往上一层
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function threeDecoderLibs(): Plugin {
  // three 是本包的 devDependency；它的 exports 不暴露 package.json，故直接走 node_modules 下的链接
  const libsDir = path.join(fs.realpathSync(path.join(webRoot, 'node_modules/three')), 'examples/jsm/libs')
  return {
    name: 'three-decoder-libs',
    configureServer(server) {
      server.middlewares.use(THREE_LIBS_URL, (req, res, next) => {
        const file = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (!THREE_LIBS_FILES.includes(file)) return next()
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        fs.createReadStream(path.join(libsDir, file)).pipe(res)
      })
    },
    generateBundle() {
      for (const file of THREE_LIBS_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: THREE_LIBS_URL.slice(1) + file,
          source: fs.readFileSync(path.join(libsDir, file)),
        })
      }
    },
  }
}
