# REQ-3DEDITOR Three.js 场景编辑器

## 1. 目标

把 Three.js 官方 editor（`three/editor`，原生 JS + 自绘 UI）移植成一套 **Vue 3 + TypeScript + shadcn-vue 组件**，验证两件事：

1. 一个体量不小的命令式编辑器能否在保持功能不变的前提下迁到 Vue 组件体系；
2. 迁完之后，能不能把它当作**可组合的组件库**，在其上快速搭出垂直业务界面（这就是 [REQ-DIRECTOR](07-director-console.md) 的前提）。

演示页：`/three-editor`。

## 2. 移植原则

- **功能对齐优先**：以官方 editor 的能力为基线，不主动裁剪、不主动加功能。
- **UI 换壳**：原生 DOM 控件替换为 shadcn-vue 组件（Menubar、Sidebar、Resizable、Dialog 等），交互语义保持一致。
- **核心逻辑保留**：`Editor` / `History` / `Command` / `Viewport` / `Loader` / `Storage` / `Config` / `Strings` 等保留原有职责与命名，改写为 TypeScript。
- **完整类型**：不允许用 `any` 糊过去；构造签名等 TS 边界问题用显式类型解决。
- **信号机制**：沿用 `signals` 做编辑器内部事件总线，不改成 Vue 的响应式，以免与原有逻辑语义冲突。
- **多语言**：沿用官方的 `Strings` 字典机制（按 `config.language` 取值），不引入 i18n 框架。

## 3. 功能需求

### 3.1 组件化边界

`@/components/three-editor` 对外导出的都是**可独立摆放**的组件，宿主页面自己决定布局：

| 导出 | 职责 |
|---|---|
| `createEditor(name?)` | 创建编辑器实例（可传存储名以区分不同用途的自动保存） |
| `ThreeEditor` | 上下文提供者，包裹所有子组件；默认插槽即页面内容 |
| `EditorMenubar` | 顶部菜单栏 |
| `EditorSidebar` | 右侧属性侧栏 |
| `EditorToolbar` | 视口内悬浮工具栏 |
| `EditorViewport` | 3D 渲染视口 |
| `EditorViewportControls` | 视口右上角的渲染 / 显示控制 |
| `EditorViewportInfo` | 视口左下角的场景统计信息 |
| `EditorPlayer` | 播放（运行场景脚本）覆盖层 |
| `EditorScript` | 脚本编辑器覆盖层 |
| `EditorAnimation` | 动画时间轴面板 |

宿主只挂需要的部分即可 —— 导演台就只用了 `ThreeEditor` + `EditorViewport`。

### 3.2 `/three-editor` 页面布局

- 顶部：`EditorMenubar`。
- 主体：可拖拽调节的分栏（`ResizablePanelGroup`）
  - 左侧纵向分栏：上方视口（默认 80%，最小 30%），下方动画面板（默认 20%，10%~50%）；
  - 右侧属性侧栏（默认 18%，最小 18%）。
- 视口内叠加：`EditorViewportControls`（右上）、`EditorToolbar`（底部居中）、`EditorViewportInfo`（左下）、`EditorPlayer` 与 `EditorScript`（全覆盖）。

### 3.3 侧栏

三个页签，切换时**不销毁**另外两个（`v-show`）：

| 页签 | 内容 |
|---|---|
| Scene | 上半场景树（`SidebarScene`），下半选中对象属性（`SidebarProperties`） |
| Project | 项目设置（渲染器、材质、着色等） |
| Settings | 编辑器设置（语言、快捷键、历史等） |

`SidebarProperties` 内部再分 Object / Geometry / Material / Script / Skeleton 等子面板。

### 3.4 编辑能力（与官方 editor 对齐）

- 新建 / 打开 / 保存项目，导入示例工程，导入 / 导出模型（glTF、OBJ、FBX 等由 `Loader` 支持的格式）。
- 添加内置几何体、灯光、相机、组等对象；场景树中拖拽调整父子关系。
- 变换控制器：移动 / 旋转 / 缩放，支持吸附（snap）与局部 / 世界坐标系切换。
- 几何体参数面板按几何体类型动态切换（Box / Sphere / Lathe / Extrude / Tube / Text / Shape…）。
- 材质编辑，包括贴图槽位与贴图参数对话框。
- 骨骼与绑定姿势查看。
- 每个对象可挂脚本，用 CodeMirror 编辑（JavaScript / JSON，One Dark 主题）。
- 播放模式运行脚本；停止后恢复编辑态。
- 动画剪辑的时间轴播放。
- 渲染出图 / 出视频（`RenderImageDialog` / `RenderVideoDialog`，视频经 mp4 mux 输出）。
- Pathtracer 渲染模式（`three-gpu-pathtracer`）与 XR 预览。

### 3.5 撤销 / 重做

- 所有会改变场景的操作都必须走 `Command` 对象，经 `History` 执行。
- 支持撤销 / 重做，可选把历史持久化到会话之间（在 Settings 中开关）。
- **播放态禁用撤销 / 重做**。

### 3.6 持久化

| 内容 | 存储 |
|---|---|
| 场景 / 项目自动保存 | IndexedDB（`Storage`），按 `createEditor(name)` 的 name 分库 |
| 编辑器偏好（语言、显示开关、历史设置等） | localStorage（`Config`） |

自动保存需防抖，避免每次改动都写库。

### 3.7 交互约定

- 支持把模型文件拖拽到视口直接导入。
- 窗口尺寸变化时视口自适应。
- 编辑器自身的样式通过运行时注入的样式表隔离，不污染宿主页面。

## 4. 验收标准

- [ ] 打开 `/three-editor` 能加载官方示例工程（Arkanoid / Camera / Particles / Pong / Shaders）并正常播放。
- [ ] 添加、变换、删除对象后，撤销 / 重做能准确回退与前进。
- [ ] 刷新页面后场景从 IndexedDB 恢复；切换语言后刷新仍生效。
- [ ] 拖拽 glTF / FBX 文件到视口能正确导入并出现在场景树中。
- [ ] 导出图片与视频能拿到可用文件。
- [ ] 分栏拖拽调整后视口不变形、渲染尺寸正确。
- [ ] `pnpm build` 通过 `vue-tsc` 类型检查，无 `any` 兜底。
- [ ] 三个侧栏页签切换后，各自的滚动位置和局部状态不丢。

## 5. 本期不做

- 在官方 editor 基础上新增功能（新增能力一律放到基于它构建的业务页面里，例如导演台）。
- 云端项目存储、多人协同编辑。
- 移动端 / 触屏适配。
- 编辑器界面的中文化。

## 6. 待确认事项

- 是否把 `three-editor` 抽成独立 npm 包（当前和业务代码同仓，靠 `index.ts` 划边界）。
- 上游 three.js editor 更新后的跟进策略：是否需要定期 diff 同步。
