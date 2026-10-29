# REQ-3DEDITOR Three.js 编辑器渲染核心

> 本文原先描述的是把 three.js 官方 editor 完整移植成 Vue 组件（含菜单栏、侧栏、脚本、动画、播放器等）。那套界面和对应页面 `/three-editor` 已**下线**；`@/components/three-editor` 现在只保留非 UI 的渲染核心，供 [REQ-DIRECTOR](07-director-console.md) 的 3D 视口使用。需求编号保持不变，内容按现状重写。

## 1. 目标

把 three.js 编辑器的**命令式内核**（场景、选择、变换、命令与历史、模型加载、渲染）放进 Vue 3 + TypeScript 组件体系，作为可组合的底座：宿主页面只需挂上下文和视口，就得到一个可交互的 3D 视口，业务界面（见 REQ-DIRECTOR）自己决定要叠什么。

不再提供独立的场景编辑器页面。

## 2. 原则

- **核心逻辑保留**：`Editor` / `History` / `Command` / `Viewport` / `Loader` / `Storage` / `Config` / `Strings` 保留原有职责与命名，TypeScript 书写，不用 `any` 糊类型。
- **信号机制**：编辑器内部事件总线沿用 `signals`，不改成 Vue 响应式。
- **只留非 UI 部分**：任何面板、菜单、对话框都不属于这个目录；需要的界面由宿主页面或 `@/components/director` 这类业务目录提供。

## 3. 功能需求

### 3.1 组件化边界

`@/components/three-editor` 的 `index.ts` 只导出三项：

| 导出 | 职责 |
|---|---|
| `createEditor(name?)` | 创建编辑器实例（`name` 是 `Config` 写 localStorage 时的命名空间，用来区分不同宿主） |
| `ThreeEditor` | 上下文提供者，包裹子组件；默认插槽即页面内容 |
| `EditorViewport` | 3D 渲染视口 |

### 3.2 内核能力

- 场景对象的增删、选择（`Selector`）、变换控制（`EditorControls`）。
- 所有改变场景的操作走 `Command` 对象，经 `History` 执行，可撤销 / 重做。
- 模型加载（`Loader` / `LoaderUtils`）：glTF / FBX / OBJ 等。**glTF 导入不弹选项框，固定按「作为对象加入当前场景」处理。**
- 骨骼绑定姿势快照（`SkeletonBindPose`）。
- Pathtracer 渲染模式（`three-gpu-pathtracer`）与 XR 预览。
- 窗口尺寸变化时视口自适应。

### 3.3 持久化

内核仍带 `Storage`（IndexedDB）与 `Config`（localStorage，编辑器偏好），按 `createEditor(name)` 的 name 分库 / 分键。**是否真正使用由宿主决定**：`/3d-viewport` 不做场景持久化。

## 4. 验收标准

- [ ] `createEditor` + `ThreeEditor` + `EditorViewport` 可以在任意宿主页面里单独渲染出一个可交互视口。
- [ ] 经 `Command` 执行的操作能被 `History` 准确撤销 / 重做（`apps/web/src/test/components/three-editor/commands/` 有覆盖）。
- [ ] 视口卸载时渲染器被 dispose，反复进出页面不累积 WebGL 上下文。
- [ ] `pnpm build` 通过 `vue-tsc` 类型检查。

## 5. 本期不做

- 官方 editor 的整套界面：菜单栏、侧栏（场景树 / 项目 / 设置）、工具栏、动画时间轴、脚本编辑与播放器、各类对话框、渲染出图 / 出视频。
- 云端项目存储、多人协同编辑。
- 移动端 / 触屏适配。

## 6. 待确认事项

- 是否把 `three-editor` 抽成独立 npm 包（当前和业务代码同仓，靠 `index.ts` 划边界）。
- 上游 three.js editor 更新后的跟进策略。
