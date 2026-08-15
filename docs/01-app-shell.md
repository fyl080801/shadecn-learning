# REQ-SHELL 应用外壳：布局、导航、路由

## 1. 目标

给所有验证页面提供一致的容器：一套侧栏导航、一套路由规则、一套登录态展示。页面作者只需要写页面本身，不必关心导航、鉴权跳转和布局。

## 2. 功能需求

### 2.1 整体布局

- 应用占满视口高度（`h-screen`），左侧固定侧栏 + 右侧 `<RouterView>`。
- 所有 SPA 路由都套侧栏：登录页由服务端模板渲染（见 [REQ-AUTH](02-auth-keycloak.md) 3.1.1），不进 SPA，因此外壳里不再有「无侧栏」分支。
  > 这一条会被 [REQ-CANVAS](13-flow-canvas-management.md) 打破：画布编辑器 `/flows/:id` 要独占整屏，需要引入 `meta.layout = 'bare'` 与之对应的无侧栏分支。落地时本节与 2.4 的「不需要 `meta.layout`」一并修订。
- 右侧内容区自己管理滚动，`body` 不应出现滚动条。

### 2.2 侧栏导航

- 侧栏顶部是品牌区（Logo + 应用名 + 版本徽标），点击回首页。
- 中部是导航列表，每项包含图标 + 名称，当前路由对应项高亮。
- 底部依次是「当前用户区」和「折叠开关」。
- **桌面端**（宽度 > 768px）：
  - 可折叠。展开宽度 240px，折叠宽度 64px，宽度变化有过渡动画。
  - 折叠态只显示图标，隐藏文字与用户信息文本。
- **窄屏**（≤ 768px）：
  - 默认收起，侧栏移出视口外；左上角显示一个悬浮菜单按钮用于唤出。
  - 展开时覆盖内容区并显示半透明遮罩，点击遮罩或点击任一导航项后自动收起。

### 2.3 用户区

- 仅当后端启用了鉴权（`authEnabled`）时才渲染这一块。
- 已登录：显示头像（无头像时用占位图标）、显示名、邮箱，以及一个「退出登录」按钮。
- 未登录：显示「登录」按钮，点击后带上当前 `fullPath` 作为回跳目标发起登录。

### 2.4 路由

- 使用 vue-router 5，history 模式（无 hash）。
- 路由表在 `src/router/index.ts` 中平铺声明，一个视图 = 一条路由。
- 路由表里**只有需要登录的页面**：`/login` 不是 SPA 路由，未登录的浏览器根本拿不到这份 bundle，所以不需要 `meta.public` 这类字段。`meta.layout = 'bare'` 是例外，用来标记不套侧栏的整屏页面（见 2.1 与 [REQ-CANVAS](13-flow-canvas-management.md)）。
- 体量大的页面（编辑器、导演台、流程图等）必须用动态 `import()` 懒加载；轻量页面可以静态导入。

#### 2.4.1 标签页标题

- 统一格式：**`区域` 或 `区域 - 具体名`**，例如「画布项目」「画布 - 下单主流程」。
- 每条路由在 `meta.title` 里声明区域名，`router.afterEach` 负责写进 `document.title`；挂在 `afterEach` 而不是 `beforeEach`，是为了让被守卫拦下的导航不改标题。
- 名字要等数据加载才知道的页面（项目主页、画布编辑器、邀请页）再用 `usePageTitle(区域, () => 名字)` 覆盖成两段式 —— 数据没到时先只显示区域名，到了自动补上，改名也会实时跟着变。

#### 2.4.2 视图目录

**路由表平铺，视图文件按功能分目录** —— `src/router/index.ts` 是唯一 import `src/views/` 的地方，所以挪动视图只会牵动这一个文件。

| 目录 | 装什么 |
|---|---|
| `views/` 根 | `Home.vue` / `About.vue` —— 不属于任何功能的外壳页 |
| `views/canvas/` | [REQ-CANVAS](13-flow-canvas-management.md)：`Projects` / `ProjectHome` / `InviteAccept` / `FlowEditor` |
| `views/three/` | 3D 相关：`ThreeEditor`（[REQ-3DEDITOR](06-three-editor.md)）、`3DScene`（[REQ-DIRECTOR](07-director-console.md)）、`Canvas3D` / `LightScene` 占位页、`Emu3DView` |
| `views/games/` | 小游戏：`Demo3` / `SnakeGame` / `Game2048` |
| `views/demos/` | 单页能力验证：`FlowChart`（[REQ-FLOW](09-flow-chart.md)）、`RichEditor`（[REQ-PROMPT](08-prompt-input.md)）、`HiC`、`Example` |

新增页面先想清楚归哪一格；哪一格都不像，说明它可能该是个独立需求。

### 2.5 登录守卫

登录与否的**判定在服务端**（Node 中间件，见 [REQ-AUTH](02-auth-keycloak.md) 3.1.1）。前端守卫只是兜底，处理「用着用着会话过期」：

1. 调用 `fetchSession()` 拿登录态（内部缓存，整个会话只请求一次 `/api/auth/me`）。
2. 后端未启用鉴权，或已登录 → 放行。
3. 否则 `location.replace('/login?redirect=<目标 fullPath>')` 并中断这次导航 —— 登录页是服务端渲染的整页，SPA 内部跳不过去。

### 2.6 当前路由表

| 路径 | 名称 | 说明 | 加载方式 |
|---|---|---|---|
| `/` | Home | 首页 / 计数器演示 | 静态 |
| `/about` | About | 项目介绍 | 静态 |
| `/demo3` | Demo3 | 打砖块 | 静态 |
| `/snake` | SnakeGame | 贪吃蛇 | 静态 |
| `/2048` | Game2048 | 2048 | 静态 |
| `/canvas3d` | Canvas3D | 机位角度拖拽演示 | 静态 |
| `/lightscene` | LightScene | 光源方向拖拽演示 | 静态 |
| `/richeditor` | RichEditor | PromptInput 富文本演示 | 静态 |
| `/hic` | HtmlInCanvas | Canvas `drawElementImage` 演示 | 懒加载 |
| `/three-editor` | ThreeEditor | Three.js 场景编辑器 | 懒加载 |
| `/3d-scene` | 3DScene | 3D 导演台 | 懒加载 |
| `/vue-flow` | VueFlow | 流程图画布 demo（[REQ-FLOW](09-flow-chart.md)），已从侧栏移除，仅保留路由 | 懒加载 |
| `/projects` | Projects | 项目列表（[REQ-CANVAS](13-flow-canvas-management.md)），侧栏入口「画布项目」 | 懒加载 |
| `/projects/:projectId` | ProjectHome | 项目主页：画布 / 成员同页 Tab | 懒加载 |
| `/invite/:token` | InviteAccept | 邀请落地页 | 懒加载 |
| `/flows/:flowId` | FlowEditor | 画布编辑器，**`meta.layout = 'bare'`（无侧栏）** | 懒加载 |

## 3. 已知缺口

- 侧栏导航列表是**手写常量**，与路由表各维护一份，容易漏配：`/demo3`、`/hic`、`/example`、`/3d-cube` 都没有出现在侧栏里，`/example` 和 `/3d-cube` 甚至已经没有对应路由（视图文件 `Example.vue` / `Emu3DView.vue` 仍在）。
- 导航项名称大小写风格不统一（`canvas3d`、`richeditor` 对比 `Three Editor`、`3D导演台`）。
- 两个不同的导航项复用了同一个图标（`Sun`、`Video`）。

## 4. 验收标准

- [ ] 未登录访问任意页面，在**服务端**就被 302 到 `/login?redirect=<原地址>`，浏览器不会加载任何前端产物；登录成功后回到原页面。
- [ ] 已登录时访问 `/login` 会被弹回目标页，不会停在登录页。
- [ ] 后端未配置 Keycloak 时，全站可直接访问，侧栏不显示用户区。
- [ ] 桌面端折叠 / 展开侧栏后，内容区宽度跟随变化且有过渡动画。
- [ ] 窄屏下侧栏默认收起，点击悬浮按钮可唤出，点击导航项后自动收起。
- [ ] 侧栏当前项高亮与实际路由一致。

## 5. 本期不做

- 多级 / 可折叠分组导航。
- 面包屑、标签页（多开）导航。
- 导航项的权限过滤（按角色隐藏菜单）。
- 侧栏折叠状态的持久化（刷新后恢复默认）。

## 6. 待确认事项

- 侧栏导航是否改为从路由表 `meta` 自动生成，以消除两份清单不同步的问题。
- `Example.vue` / `Emu3DView.vue` 是恢复路由，还是直接删除。
