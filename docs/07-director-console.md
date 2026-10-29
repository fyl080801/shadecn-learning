# REQ-DIRECTOR 3D 导演台（视口）

> 原「3D 导演台」是带角色、时间轴、面板、顶栏、工具栏的完整页面（`/3d-scene`），已**下线**。现在只保留它的**视口渲染与视口内交互**，单独成页 `/3d-viewport`。需求编号保持不变，内容按现状重写；没有迁移的部分列在 §5。

## 1. 目标

在 3D 视口中摆放对象与**机位**、预览机位取景，为内容拍摄前的场景调度与运镜预演提供视口层。底座是 [REQ-3DEDITOR](06-three-editor.md) 的渲染核心（`ThreeEditor` 上下文 + `EditorViewport`），业务叠加层在 `@/components/director`。

页面：`/3d-viewport`（`views/three/Viewport3D.vue`，路由名 `Viewport3D`，标题「3D 视口」，**不进侧栏菜单**，路由清单见 [REQ-SHELL](01-app-shell.md)）。

## 2. 页面

- 整屏只有 3D 视口，没有顶栏、工具栏、面板、时间轴。
- 编辑器实例用 `createEditor("3d-viewport")` 创建，随页面创建、随页面卸载销毁。
- **不做持久化**：每次打开都是同一份默认场景。
- 默认场景：立方体、球体、圆锥各一，以及一个只显示视锥线框的机位（源项目的机位实体模型来自后端资源索引，本仓库没有）。
- 默认画幅 16:9（页面没有工具栏可切换，所以一进来取景框就生效）。

## 3. 功能需求

### 3.1 选择与变换

- 视口内点选对象，选中后显示变换 Gizmo（`DirectorTransformControls` 提供移动 / 旋转 / 缩放切换），Gizmo 形态跟随当前模式。
- 选区与 Gizmo 归属是模块级单例；页面进入时必须复位，否则上一次停留对象的 uuid 会让新场景里的 Gizmo 不出现。
- Delete 键删除选中对象。
- 保留视角小工具（`DirectorViewHelper`：轴向罗盘 + 重置视角）。
- 视口点击空白取消选中。

### 3.2 机位

- 机位是 `userData.isDirectorShot` 的透视相机。
- 选中机位时绘制视锥，并在地面上投出视锥覆盖范围（footprint）。
- 机位支持注视目标 / 注视坐标（`useCameraLookAt`，持续跟随），以及注视装置（`useDirectorCameraRig`）。
- 机位正作为视口相机时，它自己的机位模型必须隐藏（`useCameraModelVisibility`）。
- 视口相机控制（`useDirectorCameraControls`）负责导演视角与机位视角下的操控。

### 3.3 取景框

- 按当前画幅比例（`21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16`，`auto` 表示不显示）在视口中画出取景框，框外区域做模糊 / 压暗。
- 必须是**纯 CSS 叠加层**（`DirectorAspectRatioOverlay`），不参与 Three.js 视口渲染 —— 不进入截图 / 出图结果，也不影响渲染性能。

### 3.4 其它视口行为

- 图形统一使用 `useDirectorShapeMaterial` 的表面材质，保证任意灯光下轮廓清晰。
- 全景背景（天空球）属于 `editor.backdrop` 而非 `editor.scene`（`useDirectorSceneBackdrop`）。

## 4. 验收标准

- [ ] 打开 `/3d-viewport` 看到三个几何体和一个机位视锥线框，16:9 取景框已显示。
- [ ] 点击几何体出现 Gizmo；切换移动 / 旋转 / 缩放后形态跟随；Delete 删除选中对象。
- [ ] 选中机位出现视锥与地面 footprint。
- [ ] 反复进出该页面，不累积 WebGL 上下文，Gizmo 仍能正常出现。
- [ ] 侧栏菜单里没有该页面入口，直接访问 URL 可打开。
- [ ] `apps/web/src/test/components/director/` 与 `three-editor/` 下的测试通过。

## 5. 本期不做（原导演台中未迁移的部分）

- 角色子系统：角色导入、姿势预设与调节、骨骼线框、角色标签（依赖后端 `@/api/director` 资源索引，本仓库没有该接口）。
- 时间轴、关键帧动画、运动轨迹。
- 场景面板、属性面板（场景 / 对象 / 机位）、顶栏视角 Tab、悬浮工具栏。
- 撤销 / 重做界面、复制粘贴、播放、录制。
- 持久化与自动保存。

## 6. 待确认事项

- 是否补回面板与工具栏，让该页面重新具备完整的摆放能力。
- 机位实体模型（`camera.glb`）从哪里来：补后端资源接口，还是随前端静态资源。
