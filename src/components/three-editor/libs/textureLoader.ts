import * as THREE from "three"

// Shared across every TextureField instance, mirroring the single
// module-level cache the old UITexture widget used — loading the same file
// into two different texture slots (e.g. map + bumpMap) reuses the parse.
const cache = new Map<string, THREE.Texture>()

function deliver(hash: string, texture: THREE.Texture) {
  if (!cache.has(hash)) cache.set(hash, texture)

  const cached = cache.get(hash)!
  const clone = cached.clone()
  ;(clone as any).sourceFile = (cached as any).sourceFile

  return clone
}

export function loadTextureFile(
  file: File,
  editor: any
): Promise<THREE.Texture> {
  const extension = file.name.split(".").pop()!.toLowerCase()
  const hash = `${file.lastModified}_${file.size}_${file.name}`

  if (cache.has(hash)) {
    return Promise.resolve(deliver(hash, cache.get(hash)!))
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)

    if (extension === "hdr" || extension === "pic") {
      reader.addEventListener("load", async (event) => {
        // assuming RGBE/Radiance HDR image format
        const { HDRLoader } = await import("three/addons/loaders/HDRLoader.js")

        const loader = new HDRLoader()
        loader.load(event.target!.result as string, function (hdrTexture) {
          ;(hdrTexture as any).sourceFile = file.name
          resolve(deliver(hash, hdrTexture))
        })
      })

      reader.readAsDataURL(file)
    } else if (extension === "tga") {
      reader.addEventListener("load", async (event) => {
        const { TGALoader } = await import("three/addons/loaders/TGALoader.js")

        const loader = new TGALoader()
        loader.load(event.target!.result as string, function (texture) {
          texture.colorSpace = THREE.SRGBColorSpace
          ;(texture as any).sourceFile = file.name

          resolve(deliver(hash, texture))
        })
      })

      reader.readAsDataURL(file)
    } else if (extension === "ktx2") {
      reader.addEventListener("load", async (event) => {
        const { KTX2Loader } =
          await import("three/addons/loaders/KTX2Loader.js")

        const arrayBuffer = event.target!.result as ArrayBuffer
        const blobURL = URL.createObjectURL(new Blob([arrayBuffer]))
        const ktx2Loader = new KTX2Loader()
        ktx2Loader.setTranscoderPath("../../examples/jsm/libs/basis/")
        editor.signals.rendererDetectKTX2Support.dispatch(ktx2Loader)

        ktx2Loader.load(blobURL, function (texture) {
          texture.colorSpace = THREE.SRGBColorSpace
          ;(texture as any).sourceFile = file.name
          texture.needsUpdate = true

          resolve(deliver(hash, texture))
          ktx2Loader.dispose()
        })
      })

      reader.readAsArrayBuffer(file)
    } else if (extension === "exr") {
      reader.addEventListener("load", async (event) => {
        const { EXRLoader } = await import("three/addons/loaders/EXRLoader.js")

        const arrayBuffer = event.target!.result as ArrayBuffer
        const blobURL = URL.createObjectURL(new Blob([arrayBuffer]))
        const exrLoader = new EXRLoader()

        exrLoader.load(blobURL, function (texture) {
          ;(texture as any).sourceFile = file.name
          texture.needsUpdate = true

          resolve(deliver(hash, texture))
        })
      })

      reader.readAsArrayBuffer(file)
    } else if (file.type.match("image.*")) {
      reader.addEventListener("load", (event) => {
        const image = document.createElement("img")
        image.addEventListener("load", function () {
          const texture = new THREE.Texture(image)
          ;(texture as any).sourceFile = file.name
          texture.needsUpdate = true

          resolve(deliver(hash, texture))
        })

        image.src = event.target!.result as string
      })

      reader.readAsDataURL(file)
    } else {
      reject(new Error(`Unsupported texture file: ${file.name}`))
    }
  })
}
