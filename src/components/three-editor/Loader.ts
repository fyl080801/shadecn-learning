import * as THREE from "three"

import { TGALoader } from "three/addons"

import { AddObjectCommand } from "./commands/AddObjectCommand"
import { SetSceneCommand } from "./commands/SetSceneCommand"

import { LoaderUtils } from "./LoaderUtils"

import { GLTFImportDialog } from "./GLTFImportDialog"

import { snapshotBindPose } from "./SkeletonBindPose"

// FBXLoader 将文件的 GlobalSettings.UnitScaleFactor（每场景单位的厘米数）
// 存储在 userData 上但从不应用它。许多 FBX 导出（如 Mixamo）使用厘米，
// 因此不做处理的话导入的物体会比以米为单位的场景大 100 倍。
export function applyFBXUnitScale(object: any) {
  const unitScaleFactor = object.userData.unitScaleFactor

  if (typeof unitScaleFactor === "number" && unitScaleFactor !== 100) {
    object.scale.multiplyScalar(unitScaleFactor / 100)
  }
}

import { unzipSync, strFromU8 } from "three/addons/libs/fflate.module.js"
import type { Editor } from "./Editor"

interface Loader {
  texturePath: string
  loadItemList(items: DataTransferItemList): void
  loadFiles(files: FileList | File[], filesMap?: any): void
  loadFile(file: File, manager?: THREE.LoadingManager): void
}

function Loader(this: Loader, editor: Editor) {
  const scope = this

  this.texturePath = ""

  this.loadItemList = function (items: any) {
    LoaderUtils.getFilesFromItemList(
      items,
      function (files: any, filesMap: any) {
        scope.loadFiles(files, filesMap)
      }
    )
  }

  this.loadFiles = function (files: any, filesMap?: any) {
    if (files.length > 0) {
      filesMap = filesMap || LoaderUtils.createFilesMap(files)

      const normalizeLookupPath = function (path: any) {
        let normalized = String(path || "").replace(/\\/g, "/")
        const queryIndex = normalized.indexOf("?")
        if (queryIndex !== -1) normalized = normalized.slice(0, queryIndex)
        const hashIndex = normalized.indexOf("#")
        if (hashIndex !== -1) normalized = normalized.slice(0, hashIndex)

        while (normalized.startsWith("./")) normalized = normalized.slice(2)
        while (normalized.startsWith("../")) normalized = normalized.slice(3)
        while (normalized.startsWith("/")) normalized = normalized.slice(1)

        try {
          normalized = decodeURIComponent(normalized)
        } catch (e) {
          /* 格式错误的 URI — 保持原样 */
        }

        normalized = normalized.normalize("NFC")

        return normalized
      }

      const createFileFinder = function (map: any) {
        const suffixMap: Record<string, any[]> = {}
        const warnedAmbiguous = new Set()

        const addCandidate = function (suffix: any, candidate: any) {
          if (!suffixMap[suffix]) suffixMap[suffix] = []
          suffixMap[suffix]!.push(candidate)
        }

        for (const rawKey in map) {
          const key = normalizeLookupPath(rawKey)
          const file = map[rawKey]
          if (key === "" || !file) continue

          const parts = key.split("/")

          for (let i = 0; i < parts.length; i++) {
            const suffix = parts.slice(i).join("/")
            if (suffix !== "") addCandidate(suffix, { key, file })
          }
        }

        for (const suffix in suffixMap) {
          suffixMap[suffix]!.sort(function (a: any, b: any) {
            if (a.key.length !== b.key.length)
              return a.key.length - b.key.length
            if (a.key < b.key) return -1
            if (a.key > b.key) return 1
            return 0
          })
        }

        return function findFile(url: any) {
          const lookup = normalizeLookupPath(url)
          if (lookup === "") return null

          const candidates = suffixMap[lookup]
          if (!candidates || candidates.length === 0) return null
          if (candidates.length === 1) return candidates[0]

          for (let i = 0; i < candidates.length; i++) {
            if (candidates[i].key === lookup) return candidates[i]
          }

          if (!warnedAmbiguous.has(lookup)) {
            console.warn(
              'Loader: Ambiguous file reference "' +
                lookup +
                '". Using "' +
                candidates[0].key +
                '".'
            )
            warnedAmbiguous.add(lookup)
          }

          return candidates[0]
        }
      }

      const findFile = createFileFinder(filesMap)

      const manager = new THREE.LoadingManager()
      manager.setURLModifier(function (url: string) {
        const resolved = findFile(url)

        if (resolved) {
          console.log("Loading", url)

          return URL.createObjectURL(resolved.file)
        }

        return url
      })

      manager.addHandler(/\.tga$/i, new TGALoader())

      for (let i = 0; i < files.length; i++) {
        scope.loadFile(files[i], manager)
      }
    }
  }

  this.loadFile = function (file: File, manager?: THREE.LoadingManager) {
    const filename = file.name
    const extension = filename.split(".").pop()!.toLowerCase()

    const reader = new FileReader()
    reader.addEventListener("progress", function (event: any) {
      const size =
        "(" + editor.utils.formatNumber(Math.floor(event.total / 1000)) + " KB)"
      const progress = Math.floor((event.loaded / event.total) * 100) + "%"

      console.log("Loading", filename, size, progress)
    })

    switch (extension) {
      case "3dm": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { Rhino3dmLoader } =
              await import("three/addons/loaders/3DMLoader.js")

            const loader: any = new Rhino3dmLoader()
            loader.setLibraryPath("/three-editor/libs/rhino3dm/")
            loader.parse(
              contents,
              function (object: any) {
                object.name = filename

                editor.execute(new AddObjectCommand(editor, object))
              },
              function (error: any) {
                console.error(error)
              }
            )
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "3ds": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const { TDSLoader } =
              await import("three/addons/loaders/TDSLoader.js")

            const loader: any = new TDSLoader()
            const object = loader.parse(event.target.result)

            editor.execute(new AddObjectCommand(editor, object))
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "3mf": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const { ThreeMFLoader } =
              await import("three/addons/loaders/3MFLoader.js")

            const loader: any = new ThreeMFLoader()
            const object = loader.parse(event.target.result)

            editor.execute(new AddObjectCommand(editor, object))
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "amf": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const { AMFLoader } =
              await import("three/addons/loaders/AMFLoader.js")

            const loader: any = new AMFLoader()
            const amfobject = loader.parse(event.target.result)

            editor.execute(new AddObjectCommand(editor, amfobject))
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "dae": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { ColladaLoader } =
              await import("three/addons/loaders/ColladaLoader.js")

            const loader: any = new ColladaLoader(manager)
            const collada = loader.parse(contents)

            collada.scene.name = filename

            await snapshotBindPose(collada.scene)

            editor.execute(new AddObjectCommand(editor, collada.scene))
          },
          false
        )
        reader.readAsText(file)

        break
      }

      case "drc": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { DRACOLoader } =
              await import("three/addons/loaders/DRACOLoader.js")

            const loader = new DRACOLoader()
            loader.setDecoderPath("/three-editor/libs/draco/")
            loader.parse(contents, function (geometry) {
              let object

              if (geometry.index !== null) {
                const material = new THREE.MeshStandardMaterial()

                object = new THREE.Mesh(geometry, material)
                object.name = filename
              } else {
                const material = new THREE.PointsMaterial({ size: 0.01 })
                material.vertexColors = geometry.hasAttribute("color")

                object = new THREE.Points(geometry, material)
                object.name = filename
              }

              loader.dispose()
              editor.execute(new AddObjectCommand(editor, object))
            })
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "fbx": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { FBXLoader } =
              await import("three/addons/loaders/FBXLoader.js")

            const loader: any = new FBXLoader(manager)
            const object = loader.parse(contents)

            applyFBXUnitScale(object)

            await snapshotBindPose(object)

            editor.execute(new AddObjectCommand(editor, object))
            editor.focus(object)
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "glb": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            try {
              const dialog = new GLTFImportDialog(editor.strings)
              const options = await dialog.show()

              const loader = await createGLTFLoader()

              loader.parse(contents, "", async function (result: any) {
                const scene = result.scene
                scene.name = filename

                scene.animations.push(...result.animations)

                await snapshotBindPose(scene)

                if (options.asScene) {
                  editor.execute(new SetSceneCommand(editor, scene))
                } else {
                  editor.execute(new AddObjectCommand(editor, scene))
                }

                loader.dracoLoader.dispose()
                loader.ktx2Loader.dispose()
              })
            } catch (e) {
              // 导入已取消
            }
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "gltf": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            try {
              const dialog = new GLTFImportDialog(editor.strings)
              const options = await dialog.show()

              const loader = await createGLTFLoader(manager)

              loader.parse(contents, "", async function (result: any) {
                const scene = result.scene
                scene.name = filename

                scene.animations.push(...result.animations)

                await snapshotBindPose(scene)

                if (options.asScene) {
                  editor.execute(new SetSceneCommand(editor, scene))
                } else {
                  editor.execute(new AddObjectCommand(editor, scene))
                }

                loader.dracoLoader.dispose()
                loader.ktx2Loader.dispose()
              })
            } catch (e) {
              // 导入已取消
            }
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "js":
      case "json": {
        reader.addEventListener(
          "load",
          function (event: any) {
            const contents = event.target.result

            // >= 3.0

            let data

            try {
              data = JSON.parse(contents)
            } catch (error) {
              alert(error)
              return
            }

            handleJSON(data)
          },
          false
        )
        reader.readAsText(file)

        break
      }

      case "kmz": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const { KMZLoader } =
              await import("three/addons/loaders/KMZLoader.js")

            const loader: any = new KMZLoader()
            const collada = loader.parse(event.target.result)

            collada.scene.name = filename

            await snapshotBindPose(collada.scene)

            editor.execute(new AddObjectCommand(editor, collada.scene))
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "ldr":
      case "mpd": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const { LDrawLoader } =
              await import("three/addons/loaders/LDrawLoader.js")

            const loader: any = new LDrawLoader()
            loader.setPath("../../examples/models/ldraw/officialLibrary/")
            loader.parse(event.target.result, function (group: any) {
              group.name = filename
              // 从 LDraw 坐标系转换：绕 OX 轴旋转 180 度
              group.rotation.x = Math.PI

              editor.execute(new AddObjectCommand(editor, group))
            })
          },
          false
        )
        reader.readAsText(file)

        break
      }

      case "md2": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { MD2Loader } =
              await import("three/addons/loaders/MD2Loader.js")

            const geometry: any = new MD2Loader().parse(contents)
            const material = new THREE.MeshStandardMaterial()

            const mesh: any = new THREE.Mesh(geometry, material)
            mesh.mixer = new THREE.AnimationMixer(mesh)
            mesh.name = filename

            mesh.animations.push(...geometry.animations)
            editor.execute(new AddObjectCommand(editor, mesh))
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "obj": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { OBJLoader } =
              await import("three/addons/loaders/OBJLoader.js")

            const object = new OBJLoader().parse(contents)
            object.name = filename

            editor.execute(new AddObjectCommand(editor, object))
          },
          false
        )
        reader.readAsText(file)

        break
      }

      case "pcd": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { PCDLoader } =
              await import("three/addons/loaders/PCDLoader.js")

            const points = new PCDLoader().parse(contents)
            points.name = filename

            editor.execute(new AddObjectCommand(editor, points))
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "ply": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { PLYLoader } =
              await import("three/addons/loaders/PLYLoader.js")

            const geometry = new PLYLoader().parse(contents)
            let object

            if (geometry.index !== null) {
              const material = new THREE.MeshStandardMaterial()

              object = new THREE.Mesh(geometry, material)
              object.name = filename
            } else {
              const material = new THREE.PointsMaterial({ size: 0.01 })
              material.vertexColors = geometry.hasAttribute("color")

              object = new THREE.Points(geometry, material)
              object.name = filename
            }

            editor.execute(new AddObjectCommand(editor, object))
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "stl": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { STLLoader } =
              await import("three/addons/loaders/STLLoader.js")

            const geometry = new STLLoader().parse(contents)
            const material = new THREE.MeshStandardMaterial()

            const mesh = new THREE.Mesh(geometry, material)
            mesh.name = filename

            editor.execute(new AddObjectCommand(editor, mesh))
          },
          false
        )

        if (reader.readAsBinaryString !== undefined) {
          reader.readAsBinaryString(file)
        } else {
          reader.readAsArrayBuffer(file)
        }

        break
      }

      case "svg": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { SVGLoader } =
              await import("three/addons/loaders/SVGLoader.js")

            const loader: any = new SVGLoader()
            const paths = loader.parse(contents).paths

            //

            const group = new THREE.Group()
            group.name = filename
            group.scale.multiplyScalar(0.1)
            group.scale.y *= -1

            let renderOrder = 0

            for (let i = 0; i < paths.length; i++) {
              const path = paths[i]

              // 填充

              const fillMaterial = (SVGLoader as any).createFillMaterial(path)

              if (fillMaterial) {
                const shapes = path.toShapes()

                for (let j = 0; j < shapes.length; j++) {
                  const shape = shapes[j]

                  const geometry = new THREE.ShapeGeometry(shape)
                  const mesh = new THREE.Mesh(geometry, fillMaterial)
                  mesh.renderOrder = renderOrder++

                  group.add(mesh)
                }
              }

              // 描边

              const strokeMaterial = (SVGLoader as any).createStrokeMaterial(
                path
              )

              if (strokeMaterial) {
                for (const subPath of path.subPaths) {
                  const geometry = SVGLoader.pointsToStroke(
                    subPath.getPoints(),
                    path.userData.style
                  )

                  if (geometry) {
                    const mesh = new THREE.Mesh(geometry, strokeMaterial)
                    mesh.renderOrder = renderOrder++

                    group.add(mesh)
                  }
                }
              }
            }

            editor.execute(new AddObjectCommand(editor, group))
          },
          false
        )
        reader.readAsText(file)

        break
      }

      case "usd":
      case "usda":
      case "usdc":
      case "usdz": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { USDLoader } =
              await import("three/addons/loaders/USDLoader.js")

            const loader: any = new USDLoader(manager)
            loader.parse(contents, "", function (group: any) {
              group.name = filename
              editor.execute(new AddObjectCommand(editor, group))
            })
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "vox": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { VOXLoader } =
              await import("three/addons/loaders/VOXLoader.js")

            const { scene } = new VOXLoader().parse(contents)

            scene.name = filename

            editor.execute(new AddObjectCommand(editor, scene))
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "wrl": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { VRMLLoader } =
              await import("three/addons/loaders/VRMLLoader.js")

            const result = (new VRMLLoader() as any).parse(contents)

            editor.execute(new AddObjectCommand(editor, result))
          },
          false
        )
        reader.readAsText(file)

        break
      }

      case "xyz": {
        reader.addEventListener(
          "load",
          async function (event: any) {
            const contents = event.target.result

            const { XYZLoader } =
              await import("three/addons/loaders/XYZLoader.js")

            const geometry = (new XYZLoader() as any).parse(contents)

            const material = new THREE.PointsMaterial()
            material.vertexColors = geometry.hasAttribute("color")

            const points = new THREE.Points(geometry, material)
            points.name = filename

            editor.execute(new AddObjectCommand(editor, points))
          },
          false
        )
        reader.readAsText(file)

        break
      }

      case "zip": {
        reader.addEventListener(
          "load",
          function (event: any) {
            handleZIP(event.target.result)
          },
          false
        )
        reader.readAsArrayBuffer(file)

        break
      }

      case "bmp":
      case "gif":
      case "jpg":
      case "jpeg":
      case "png":
      case "tga":
        break // 图像文件由其他加载器作为纹理处理

      default:
        console.error("Unsupported file format (" + extension + ").")

        break
    }
  }

  function handleJSON(data: any) {
    if (data.metadata === undefined) {
      // 2.0

      data.metadata = { type: "Geometry" }
    }

    if (data.metadata.type === undefined) {
      // 3.0

      data.metadata.type = "Geometry"
    }

    if (data.metadata.formatVersion !== undefined) {
      data.metadata.version = data.metadata.formatVersion
    }

    switch (data.metadata.type.toLowerCase()) {
      case "buffergeometry": {
        const loader = new THREE.BufferGeometryLoader()
        const result = loader.parse(data)

        const mesh = new THREE.Mesh(result)

        editor.execute(new AddObjectCommand(editor, mesh))

        break
      }

      case "geometry":
        console.error('Loader: "Geometry" is no longer supported.')

        break

      case "object": {
        const loader = new THREE.ObjectLoader()
        loader.setResourcePath(scope.texturePath)

        loader.parse(data, function (result) {
          editor.execute(new AddObjectCommand(editor, result))
        })

        break
      }

      case "app":
        editor.fromJSON(data)

        break
    }
  }

  async function handleZIP(contents: any) {
    const zip = unzipSync(new Uint8Array(contents))

    // 构建一个以 NFC 归一化键的查找表，以处理
    // Unicode 归一化差异（如 NFD 与 NFC）

    const zipLookup: Record<string, any> = {}

    for (const path in zip) {
      zipLookup[path.normalize("NFC")] = zip[path]
    }

    const manager = new THREE.LoadingManager()
    manager.setURLModifier(function (url: string) {
      const normalized = decodeURIComponent(url).normalize("NFC")
      const file = zipLookup[normalized]

      if (file) {
        console.log("Loading", url)

        const blob = new Blob([file.buffer], {
          type: "application/octet-stream"
        })
        return URL.createObjectURL(blob)
      }

      return url
    })

    // Poly

    if (zip["model.obj"] && zip["materials.mtl"]) {
      const { MTLLoader } = await import("three/addons/loaders/MTLLoader.js")
      const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js")

      const materials = (new MTLLoader(manager) as any).parse(
        strFromU8(zip["materials.mtl"]!)
      )
      const object = (new OBJLoader() as any)
        .setMaterials(materials)
        .parse(strFromU8(zip["model.obj"]!))

      editor.execute(new AddObjectCommand(editor, object))
      return
    }

    //

    for (const path in zip) {
      const file = zip[path]!

      const extension = path.split(".").pop()!.toLowerCase()

      switch (extension) {
        case "fbx": {
          const { FBXLoader } =
            await import("three/addons/loaders/FBXLoader.js")

          const loader: any = new FBXLoader(manager)
          const object = loader.parse(file.buffer)

          applyFBXUnitScale(object)

          await snapshotBindPose(object)

          editor.execute(new AddObjectCommand(editor, object))
          editor.focus(object)

          break
        }

        case "glb": {
          try {
            const dialog = new GLTFImportDialog(editor.strings)
            const options = await dialog.show()

            const loader = await createGLTFLoader()

            loader.parse(file.buffer, "", async function (result: any) {
              const scene = result.scene

              scene.animations.push(...result.animations)

              await snapshotBindPose(scene)

              if (options.asScene) {
                editor.execute(new SetSceneCommand(editor, scene))
              } else {
                editor.execute(new AddObjectCommand(editor, scene))
              }

              loader.dracoLoader.dispose()
              loader.ktx2Loader.dispose()
            })
          } catch (e) {
            // 导入已取消
          }

          break
        }

        case "gltf": {
          try {
            const dialog = new GLTFImportDialog(editor.strings)
            const options = await dialog.show()

            const loader = await createGLTFLoader(manager)

            loader.parse(strFromU8(file), "", async function (result: any) {
              const scene = result.scene

              scene.animations.push(...result.animations)

              await snapshotBindPose(scene)

              if (options.asScene) {
                editor.execute(new SetSceneCommand(editor, scene))
              } else {
                editor.execute(new AddObjectCommand(editor, scene))
              }

              loader.dracoLoader.dispose()
              loader.ktx2Loader.dispose()
            })
          } catch (e) {
            // 导入已取消
          }

          break
        }
      }
    }
  }

  async function createGLTFLoader(manager?: THREE.LoadingManager) {
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js")
    const { DRACOLoader } = await import("three/addons/loaders/DRACOLoader.js")
    const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js")
    const { MeshoptDecoder } =
      await import("three/addons/libs/meshopt_decoder.module.js")

    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath("/three-editor/libs/draco/gltf/")

    const ktx2Loader = new KTX2Loader(manager)
    ktx2Loader.setTranscoderPath("/three-editor/libs/basis/")

    editor.signals.rendererDetectKTX2Support.dispatch(ktx2Loader)

    const loader: any = new GLTFLoader(manager)
    loader.setDRACOLoader(dracoLoader)
    loader.setKTX2Loader(ktx2Loader)
    loader.setMeshoptDecoder(MeshoptDecoder)

    return loader
  }
}

export { Loader }
