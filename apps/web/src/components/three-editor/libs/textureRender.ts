import * as THREE from "three"
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js"

let renderer: THREE.WebGLRenderer | undefined
let fsQuad: FullScreenQuad | undefined

export function renderToCanvas(texture: THREE.Texture) {
  if (renderer === undefined) {
    renderer = new THREE.WebGLRenderer()
  }

  if (fsQuad === undefined) {
    fsQuad = new FullScreenQuad(new THREE.MeshBasicMaterial())
  }

  const image = texture.image as { width: number; height: number }

  renderer.setSize(image.width, image.height, false)
  ;(fsQuad.material as THREE.MeshBasicMaterial).map = texture
  fsQuad.render(renderer)

  return renderer.domElement
}
