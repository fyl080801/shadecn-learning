<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue"
import * as THREE from "three"

import { AddObjectCommand } from "./commands/AddObjectCommand"
import { MultiCmdsCommand } from "./commands/MultiCmdsCommand"
import { RemoveObjectCommand } from "./commands/RemoveObjectCommand"
import { SetPositionCommand } from "./commands/SetPositionCommand"
import { useEditor } from "./composables/useEditorContext"
import { mountClosableDialog } from "./libs/mountDialog"
import RenderImageDialogView from "./RenderImageDialog.vue"
import RenderVideoDialogView from "./RenderVideoDialog.vue"

import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger
} from "@/components/ui/menubar"

const editor = useEditor()
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const openProjectInputRef = ref<HTMLInputElement | null>(null)
const importInputRef = ref<HTMLInputElement | null>(null)

const newProjectExamples = [
  { title: "menubar/file/new/Arkanoid", file: "arkanoid.app.json" },
  { title: "menubar/file/new/Camera", file: "camera.app.json" },
  { title: "menubar/file/new/Particles", file: "particles.app.json" },
  { title: "menubar/file/new/Pong", file: "pong.app.json" },
  { title: "menubar/file/new/Shaders", file: "shaders.app.json" }
]

function newEmptyProject() {
  if (confirm(t("prompt/file/open"))) {
    editor.clear()
  }
}

function newExampleProject(file: string) {
  if (confirm(t("prompt/file/open"))) {
    const loader = new THREE.FileLoader()
    loader.load("examples/" + file, function (text: string | ArrayBuffer) {
      editor.clear()
      editor.fromJSON(JSON.parse(text as string))
    })
  }
}

function openProject() {
  if (confirm(t("prompt/file/open"))) {
    openProjectInputRef.value?.click()
  }
}

async function onOpenProjectChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""

  if (file === undefined) return

  try {
    const json = JSON.parse(await file.text())

    async function onEditorCleared() {
      await editor.fromJSON(json)
      editor.signals.editorCleared.remove(onEditorCleared)
    }

    editor.signals.editorCleared.add(onEditorCleared)

    editor.clear()
  } catch (e) {
    alert(t("prompt/file/failedToOpenProject"))
    console.error(e)
  }
}

function saveProject() {
  const json = editor.toJSON()
  const blob = new Blob([JSON.stringify(json)], {
    type: "application/json"
  })
  editor.utils.save(blob, "project.json")
}

function importFiles() {
  importInputRef.value?.click()
}

function onImportChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files) editor.loader.loadFiles(input.files)
  input.value = ""
}

function getAnimations(scene: THREE.Object3D) {
  const animations: THREE.AnimationClip[] = []
  scene.traverse(function (object: any) {
    animations.push(...object.animations)
  })
  return animations
}

function needsUniqueNames(scene: THREE.Object3D) {
  const usedNames = new Set<string>()
  let duplicate = false
  let animated = false

  scene.traverse(function (object: any) {
    if (object.animations.length > 0) animated = true
    if (object.name === "") return
    if (usedNames.has(object.name)) duplicate = true
    usedNames.add(object.name)
  })

  return duplicate && animated
}

// 为每个对象赋予唯一名称，并保持按名称引用它们的动画轨道同步。
// 重命名后的场景与 glTF 往返的结果一致，加载器也会将所有名称设为唯一。
function ensureUniqueNames(scene: THREE.Object3D) {
  const trackBindings: { track: any; target: any; nodeName: string }[] = []

  scene.traverse(function (owner: any) {
    for (const clip of owner.animations) {
      for (const track of clip.tracks) {
        const nodeName = THREE.PropertyBinding.parseTrackName(
          track.name
        ).nodeName
        const target = THREE.PropertyBinding.findNode(owner, nodeName)

        // 按 UUID 的引用仍然有效，因此只跟踪基于名称的引用。
        if (target !== null && (target as any).name === nodeName) {
          trackBindings.push({ track, target, nodeName })
        }
      }
    }
  })

  let changed = false
  const usedNames = new Set<string>()

  scene.traverse(function (object: any) {
    if (object.name === "") return

    if (usedNames.has(object.name)) {
      let suffix = 1
      let name
      do {
        name = object.name + "_" + suffix++
      } while (usedNames.has(name))

      object.name = name
      changed = true
    }

    usedNames.add(object.name)
  })

  if (changed === false) return

  for (const { track, target, nodeName } of trackBindings) {
    if (target.name !== nodeName) {
      track.name = target.name + track.name.slice(nodeName.length)
    }
  }

  editor.signals.sceneGraphChanged.dispatch()
}

async function exportDRC() {
  const object: any = editor.selected

  if (object === null || object.isMesh === undefined) {
    alert(t("prompt/file/export/noMeshSelected"))
    return
  }

  const { DRACOExporter } =
    await import("three/addons/exporters/DRACOExporter.js")

  const exporter: any = new DRACOExporter()

  const options = {
    decodeSpeed: 5,
    encodeSpeed: 5,
    encoderMethod: (DRACOExporter as any).MESH_EDGEBREAKER_ENCODING,
    quantization: [16, 8, 8, 8, 8],
    exportUvs: true,
    exportNormals: true,
    exportColor: object.geometry.hasAttribute("color")
  }

  const result = await exporter.parseAsync(object, options)
  editor.utils.saveArrayBuffer(result, "model.drc")
}

async function exportGLB() {
  const scene = editor.scene

  if (needsUniqueNames(scene)) {
    // 见 #25179
    if (confirm(t("prompt/file/export/duplicateNames")) === false) return
    ensureUniqueNames(scene)
  }

  const animations = getAnimations(scene)
  const optimizedAnimations = animations.map((animation: any) =>
    animation.clone().optimize()
  )

  const { GLTFExporter } =
    await import("three/addons/exporters/GLTFExporter.js")

  const exporter = new GLTFExporter()

  exporter.parse(
    scene,
    function (result: any) {
      editor.utils.saveArrayBuffer(result, "scene.glb")
    },
    function () {},
    { binary: true, animations: optimizedAnimations }
  )
}

async function exportGLTF() {
  const scene = editor.scene

  if (needsUniqueNames(scene)) {
    if (confirm(t("prompt/file/export/duplicateNames")) === false) return
    ensureUniqueNames(scene)
  }

  const animations = getAnimations(scene)
  const optimizedAnimations = animations.map((animation: any) =>
    animation.clone().optimize()
  )

  const { GLTFExporter } =
    await import("three/addons/exporters/GLTFExporter.js")

  const exporter = new GLTFExporter()

  exporter.parse(
    scene,
    function (result: any) {
      editor.utils.saveString(JSON.stringify(result, null, 2), "scene.gltf")
    },
    function () {},
    { animations: optimizedAnimations }
  )
}

async function exportOBJ() {
  const object = editor.selected

  if (object === null) {
    alert(t("prompt/file/export/noObjectSelected"))
    return
  }

  const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js")

  const exporter = new OBJExporter()

  editor.utils.saveString(exporter.parse(object), "model.obj")
}

async function exportPLY() {
  const { PLYExporter } = await import("three/addons/exporters/PLYExporter.js")

  const exporter = new PLYExporter()

  exporter.parse(editor.scene, function (result: any) {
    editor.utils.saveArrayBuffer(result, "model.ply")
  })
}

async function exportPLYBinary() {
  const { PLYExporter } = await import("three/addons/exporters/PLYExporter.js")

  const exporter = new PLYExporter()

  exporter.parse(
    editor.scene,
    function (result: any) {
      editor.utils.saveArrayBuffer(result, "model-binary.ply")
    },
    { binary: true }
  )
}

async function exportSTL() {
  const { STLExporter } = await import("three/addons/exporters/STLExporter.js")

  const exporter = new STLExporter()

  editor.utils.saveString(exporter.parse(editor.scene), "model.stl")
}

async function exportSTLBinary() {
  const { STLExporter } = await import("three/addons/exporters/STLExporter.js")

  const exporter = new STLExporter()

  editor.utils.saveArrayBuffer(
    exporter.parse(editor.scene, { binary: true }),
    "model-binary.stl"
  )
}

async function exportUSDZ() {
  const { USDZExporter } =
    await import("three/addons/exporters/USDZExporter.js")

  const exporter = new USDZExporter()

  editor.utils.saveArrayBuffer(
    await exporter.parseAsync(editor.scene),
    "model.usdz"
  )
}

// 编辑菜单

const historyState = reactive({ canUndo: false, canRedo: false })

function onHistoryChanged() {
  const history = editor.history
  historyState.canUndo = history.undos.length > 0
  historyState.canRedo = history.redos.length > 0
}

function undo() {
  editor.undo()
}

function redo() {
  editor.redo()
}

function center() {
  const object = editor.selected

  if (object === null || object.parent === null) return // 避免居中相机或场景

  const aabb = new THREE.Box3().setFromObject(object)
  const center = aabb.getCenter(new THREE.Vector3())
  const newPosition = new THREE.Vector3()

  newPosition.x = object.position.x - center.x
  newPosition.y = object.position.y - center.y
  newPosition.z = object.position.z - center.z

  editor.execute(new SetPositionCommand(editor, object, newPosition))
}

async function cloneSelected() {
  let object = editor.selected

  if (object === null || object.parent === null) return // 避免克隆相机或场景

  const { clone } = await import("three/addons/utils/SkeletonUtils.js")
  object = clone(object)

  editor.execute(new AddObjectCommand(editor, object))
}

function deleteSelected() {
  const object = editor.selected

  if (object === null || object.parent === null) return

  if (object.isSpotLight || object.isDirectionalLight) {
    editor.execute(
      new MultiCmdsCommand(editor, [
        new RemoveObjectCommand(editor, object),
        new RemoveObjectCommand(editor, object.target)
      ])
    )
  } else {
    editor.execute(new RemoveObjectCommand(editor, object))
  }
}

// 添加菜单

function addObject(object: THREE.Object3D) {
  editor.execute(new AddObjectCommand(editor, object))
}

function addGroup() {
  const mesh = new THREE.Group()
  mesh.name = "Group"
  addObject(mesh)
}

function addMesh(name: string, geometry: THREE.BufferGeometry, options?: any) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial(options))
  mesh.name = name
  addObject(mesh)
}

function addBox() {
  addMesh("Box", new THREE.BoxGeometry(1, 1, 1, 1, 1, 1))
}

function addCapsule() {
  addMesh("Capsule", new THREE.CapsuleGeometry(1, 1, 4, 8, 1))
}

function addCircle() {
  addMesh("Circle", new THREE.CircleGeometry(1, 32, 0, Math.PI * 2))
}

function addCylinder() {
  addMesh(
    "Cylinder",
    new THREE.CylinderGeometry(1, 1, 1, 32, 1, false, 0, Math.PI * 2)
  )
}

function addDodecahedron() {
  addMesh("Dodecahedron", new THREE.DodecahedronGeometry(1, 0))
}

function addIcosahedron() {
  addMesh("Icosahedron", new THREE.IcosahedronGeometry(1, 0))
}

function addLathe() {
  addMesh("Lathe", new THREE.LatheGeometry(), { side: THREE.DoubleSide })
}

function addOctahedron() {
  addMesh("Octahedron", new THREE.OctahedronGeometry(1, 0))
}

function addPlane() {
  addMesh("Plane", new THREE.PlaneGeometry(1, 1, 1, 1))
}

function addRing() {
  addMesh("Ring", new THREE.RingGeometry(0.5, 1, 32, 1, 0, Math.PI * 2))
}

function addSphere() {
  addMesh(
    "Sphere",
    new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI)
  )
}

function addSprite() {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial())
  sprite.name = "Sprite"
  addObject(sprite)
}

function addTetrahedron() {
  addMesh("Tetrahedron", new THREE.TetrahedronGeometry(1, 0))
}

async function addText() {
  const { FontLoader } = await import("three/addons/loaders/FontLoader.js")
  const { TextGeometry } =
    await import("three/addons/geometries/TextGeometry.js")

  const loader = new FontLoader()
  loader.load(
    "../examples/fonts/helvetiker_bold.typefaceon",
    function (font: any) {
      const text = "THREE"

      const geometry = new TextGeometry(text, {
        font,
        size: 1,
        depth: 0.5,
        curveSegments: 4,

        bevelEnabled: false,
        bevelThickness: 0.1,
        bevelSize: 0.01,
        bevelOffset: 0,
        bevelSegments: 3
      })

      addMesh("Text", geometry)
    }
  )
}

function addTorus() {
  addMesh("Torus", new THREE.TorusGeometry(1, 0.4, 12, 48, Math.PI * 2))
}

function addTorusKnot() {
  addMesh("TorusKnot", new THREE.TorusKnotGeometry(1, 0.4, 64, 8, 2, 3))
}

function addTube() {
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(2, 2, -2),
    new THREE.Vector3(2, -2, -0.6666666666666667),
    new THREE.Vector3(-2, -2, 0.6666666666666667),
    new THREE.Vector3(-2, 2, 2)
  ])

  addMesh("Tube", new THREE.TubeGeometry(path, 64, 1, 8, false))
}

function addAmbientLight() {
  const light = new THREE.AmbientLight(0x222222)
  light.name = "AmbientLight"
  addObject(light)
}

function addDirectionalLight() {
  const light = new THREE.DirectionalLight(0xffffff, 1)
  light.name = "DirectionalLight"
  light.target.name = "DirectionalLight Target"
  light.position.set(5, 10, 7.5)

  editor.execute(
    new MultiCmdsCommand(editor, [
      new AddObjectCommand(editor, light.target),
      new AddObjectCommand(editor, light)
    ])
  )
}

function addHemisphereLight() {
  const light = new THREE.HemisphereLight(0x00aaff, 0xffaa00, 1)
  light.name = "HemisphereLight"
  light.position.set(0, 10, 0)
  addObject(light)
}

function addPointLight() {
  const light = new THREE.PointLight(0xffffff, 1, 0)
  light.name = "PointLight"
  addObject(light)
}

function addSpotLight() {
  const light = new THREE.SpotLight(0xffffff, 1, 0, Math.PI * 0.1, 0)
  light.name = "SpotLight"
  light.target.name = "SpotLight Target"
  light.position.set(5, 10, 7.5)

  editor.execute(
    new MultiCmdsCommand(editor, [
      new AddObjectCommand(editor, light.target),
      new AddObjectCommand(editor, light)
    ])
  )
}

function addOrthographicCamera() {
  const aspect = editor.camera.isPerspectiveCamera
    ? editor.camera.aspect
    : (editor.camera.right - editor.camera.left) /
      (editor.camera.top - editor.camera.bottom)
  const camera = new THREE.OrthographicCamera(-aspect, aspect)
  camera.name = "OrthographicCamera"
  addObject(camera)
}

function addPerspectiveCamera() {
  const camera = new THREE.PerspectiveCamera()
  camera.name = "PerspectiveCamera"
  addObject(camera)
}

// 视图菜单

const viewHelpers = reactive({
  gridHelper: true,
  cameraHelpers: true,
  lightHelpers: true,
  skeletonHelpers: true
})

function onHelpersChanged() {
  editor.signals.showHelpersChanged.dispatch(viewHelpers)
}

function onHelperAdded() {
  editor.signals.showHelpersChanged.dispatch(viewHelpers)
}

function toggleFullscreen() {
  if (document.fullscreenElement === null) {
    document.documentElement.requestFullscreen()
  } else if (document.exitFullscreen) {
    document.exitFullscreen()
  }

  // Safari
  if ((document as any).webkitFullscreenElement === null) {
    ;(document.documentElement as any).webkitRequestFullscreen()
  } else if ((document as any).webkitExitFullscreen) {
    ;(document as any).webkitExitFullscreen()
  }
}

// 渲染菜单

const hasVideoEncoder = "VideoEncoder" in window

function showImageDialog() {
  mountClosableDialog(RenderImageDialogView, { editor, strings })
}

function showVideoDialog() {
  mountClosableDialog(RenderVideoDialogView, { editor, strings })
}

// 状态

const autosave = ref(editor.config.getKey("autosave") !== false)
const saving = ref(false)

function onAutosaveChange(value: boolean) {
  editor.config.setKey("autosave", value)

  if (value === true) {
    editor.signals.sceneGraphChanged.dispatch()
  }
}

function onAutosaveInputChange(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  autosave.value = checked
  onAutosaveChange(checked)
}

function onSavingStarted() {
  saving.value = true
}

function onSavingFinished() {
  saving.value = false
}

onMounted(() => {
  editor.signals.historyChanged.add(onHistoryChanged)
  onHistoryChanged()

  editor.signals.helperAdded.add(onHelperAdded)
  editor.signals.savingStarted.add(onSavingStarted)
  editor.signals.savingFinished.add(onSavingFinished)
})

onBeforeUnmount(() => {
  editor.signals.historyChanged.remove(onHistoryChanged)
  editor.signals.helperAdded.remove(onHelperAdded)
  editor.signals.savingStarted.remove(onSavingStarted)
  editor.signals.savingFinished.remove(onSavingFinished)
})
</script>

<template>
  <div
    class="te-menubar bg-background relative z-10 flex h-9 shrink-0 items-center justify-between border-b px-2"
  >
    <Menubar class="h-8 gap-0 rounded-none border-none p-0 shadow-none">
      <MenubarMenu>
        <MenubarTrigger>{{ t("menubar/file") }}</MenubarTrigger>
        <MenubarContent>
          <MenubarSub>
            <MenubarSubTrigger>{{ t("menubar/file/new") }}</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem @select="newEmptyProject">
                {{ t("menubar/file/new/empty") }}
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem
                v-for="example in newProjectExamples"
                :key="example.file"
                @select="newExampleProject(example.file)"
              >
                {{ t(example.title) }}
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem @select="openProject">{{
            t("menubar/file/open")
          }}</MenubarItem>
          <MenubarItem @select="saveProject">{{
            t("menubar/file/save")
          }}</MenubarItem>
          <MenubarSeparator />
          <MenubarItem @select="importFiles">{{
            t("menubar/file/import")
          }}</MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger>{{
              t("menubar/file/export")
            }}</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem @select="exportDRC">DRC</MenubarItem>
              <MenubarItem @select="exportGLB">GLB</MenubarItem>
              <MenubarItem @select="exportGLTF">GLTF</MenubarItem>
              <MenubarItem @select="exportOBJ">OBJ</MenubarItem>
              <MenubarItem @select="exportPLY">PLY</MenubarItem>
              <MenubarItem @select="exportPLYBinary">PLY (BINARY)</MenubarItem>
              <MenubarItem @select="exportSTL">STL</MenubarItem>
              <MenubarItem @select="exportSTLBinary">STL (BINARY)</MenubarItem>
              <MenubarItem @select="exportUSDZ">USDZ</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>{{ t("menubar/edit") }}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem :disabled="!historyState.canUndo" @select="undo">
            {{ t("menubar/edit/undo") }}
            <MenubarShortcut>CTRL+Z</MenubarShortcut>
          </MenubarItem>
          <MenubarItem :disabled="!historyState.canRedo" @select="redo">
            {{ t("menubar/edit/redo") }}
            <MenubarShortcut>CTRL+SHIFT+Z</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem @select="center">{{
            t("menubar/edit/center")
          }}</MenubarItem>
          <MenubarItem @select="cloneSelected">{{
            t("menubar/edit/clone")
          }}</MenubarItem>
          <MenubarItem @select="deleteSelected">
            {{ t("menubar/edit/delete") }}
            <MenubarShortcut>DEL</MenubarShortcut>
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>{{ t("menubar/add") }}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem @select="addGroup">{{
            t("menubar/add/group")
          }}</MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger>{{ t("menubar/add/mesh") }}</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem @select="addBox">{{
                t("menubar/add/mesh/box")
              }}</MenubarItem>
              <MenubarItem @select="addCapsule">{{
                t("menubar/add/mesh/capsule")
              }}</MenubarItem>
              <MenubarItem @select="addCircle">{{
                t("menubar/add/mesh/circle")
              }}</MenubarItem>
              <MenubarItem @select="addCylinder">{{
                t("menubar/add/mesh/cylinder")
              }}</MenubarItem>
              <MenubarItem @select="addDodecahedron">{{
                t("menubar/add/mesh/dodecahedron")
              }}</MenubarItem>
              <MenubarItem @select="addIcosahedron">{{
                t("menubar/add/mesh/icosahedron")
              }}</MenubarItem>
              <MenubarItem @select="addLathe">{{
                t("menubar/add/mesh/lathe")
              }}</MenubarItem>
              <MenubarItem @select="addOctahedron">{{
                t("menubar/add/mesh/octahedron")
              }}</MenubarItem>
              <MenubarItem @select="addPlane">{{
                t("menubar/add/mesh/plane")
              }}</MenubarItem>
              <MenubarItem @select="addRing">{{
                t("menubar/add/mesh/ring")
              }}</MenubarItem>
              <MenubarItem @select="addSphere">{{
                t("menubar/add/mesh/sphere")
              }}</MenubarItem>
              <MenubarItem @select="addSprite">{{
                t("menubar/add/mesh/sprite")
              }}</MenubarItem>
              <MenubarItem @select="addTetrahedron">{{
                t("menubar/add/mesh/tetrahedron")
              }}</MenubarItem>
              <MenubarItem @select="addText">{{
                t("menubar/add/text")
              }}</MenubarItem>
              <MenubarItem @select="addTorus">{{
                t("menubar/add/mesh/torus")
              }}</MenubarItem>
              <MenubarItem @select="addTorusKnot">{{
                t("menubar/add/mesh/torusknot")
              }}</MenubarItem>
              <MenubarItem @select="addTube">{{
                t("menubar/add/mesh/tube")
              }}</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger>{{ t("menubar/add/light") }}</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem @select="addAmbientLight">{{
                t("menubar/add/light/ambient")
              }}</MenubarItem>
              <MenubarItem @select="addDirectionalLight">{{
                t("menubar/add/light/directional")
              }}</MenubarItem>
              <MenubarItem @select="addHemisphereLight">{{
                t("menubar/add/light/hemisphere")
              }}</MenubarItem>
              <MenubarItem @select="addPointLight">{{
                t("menubar/add/light/point")
              }}</MenubarItem>
              <MenubarItem @select="addSpotLight">{{
                t("menubar/add/light/spot")
              }}</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger>{{ t("menubar/add/camera") }}</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem @select="addOrthographicCamera">{{
                t("menubar/add/camera/orthographic")
              }}</MenubarItem>
              <MenubarItem @select="addPerspectiveCamera">{{
                t("menubar/add/camera/perspective")
              }}</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>{{ t("menubar/view") }}</MenubarTrigger>
        <MenubarContent>
          <MenubarCheckboxItem
            v-model="viewHelpers.gridHelper"
            @update:model-value="onHelpersChanged"
          >
            {{ t("menubar/view/gridHelper") }}
          </MenubarCheckboxItem>
          <MenubarCheckboxItem
            v-model="viewHelpers.cameraHelpers"
            @update:model-value="onHelpersChanged"
          >
            {{ t("menubar/view/cameraHelpers") }}
          </MenubarCheckboxItem>
          <MenubarCheckboxItem
            v-model="viewHelpers.lightHelpers"
            @update:model-value="onHelpersChanged"
          >
            {{ t("menubar/view/lightHelpers") }}
          </MenubarCheckboxItem>
          <MenubarCheckboxItem
            v-model="viewHelpers.skeletonHelpers"
            @update:model-value="onHelpersChanged"
          >
            {{ t("menubar/view/skeletonHelpers") }}
          </MenubarCheckboxItem>
          <MenubarSeparator />
          <MenubarItem @select="toggleFullscreen">{{
            t("menubar/view/fullscreen")
          }}</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>{{ t("menubar/render") }}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem @select="showImageDialog">{{
            t("menubar/render/image")
          }}</MenubarItem>
          <MenubarItem v-if="hasVideoEncoder" @select="showVideoDialog">{{
            t("menubar/render/video")
          }}</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>

    <div class="flex items-center gap-2 text-xs">
      <label
        class="text-muted-foreground flex cursor-pointer items-center gap-1"
        :class="{ underline: saving }"
      >
        <input
          :checked="autosave"
          type="checkbox"
          class="size-3"
          @change="onAutosaveInputChange"
        />
        {{ t("menubar/status/autosave") }}
      </label>
      <span class="text-muted-foreground/50">r{{ THREE.REVISION }}</span>
    </div>

    <input
      ref="openProjectInputRef"
      type="file"
      accept=".json"
      class="hidden"
      @change="onOpenProjectChange"
    />
    <input
      ref="importInputRef"
      type="file"
      multiple
      class="hidden"
      @change="onImportChange"
    />
  </div>
</template>
