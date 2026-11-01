# REQ-APPS 应用执行：语言 / 图像 / 视频 / 3D 生成服务统一成 `executeApp`

> 状态：**部分实现**（第 1 期：模块、应用表、三种驱动、服务契约与 HTTP 入口；第 2 期：一个应用多个模型（§3.7）、画布图片 / 视频节点用应用生成（§3.8）；第 3 期：画布生成任务化（§3.10）—— 提交即返回、服务端执行并写回节点、生成状态推送、重启续查、取消；§5 的 agent 工具未做）。
>
> 前置：[REQ-MODULES](28-server-modules.md)（模块集成协议、配置层）、[REQ-AGENT](20-agent-canvas.md)（模型通路与 `ollama` 预设，[REQ-AGENT-DEF §3.4](26-agent-definitions.md) 的模型表）。

## 1. 目标

1. **一个入口调所有生成服务**：`executeApp(appId, params)` —— 调用方只认应用 id 和参数，不认识背后是火山方舟、ComfyUI 还是 ollama。
2. **对接服务可扩充，不堆代码**：接一种新的服务 = 写一个驱动文件 + 注册表加一行；加一个新应用 = 应用表里加一段配置，**不改代码**。
   参数校验、默认值、超时、中止、错误归一、上游请求与轮询只写一次，驱动里不重复。
3. **语言模型和 agent 共用一条通路**：ollama 的应用走画布 agent 同一个 `resolveAgentModel` + `streamUpstream`，兼容开关只维护一份。
4. **一个驱动服务很多模型，模型差异是配置**：各代模型的参数差异（参考图上限、支不支持组图…）写在应用表里，上游出新模型不改代码。
5. **画布上用起来**：图片 / 视频节点的底部输入框选一个应用、写提示词、连参考图，发送就生成，结果挂回节点。

## 2. 概念

| 概念 | 是什么 | 在哪 |
|---|---|---|
| **驱动**（driver） | 一种对接服务的协议实现：火山方舟、ComfyUI、ollama… | `packages/mod-apps/src/drivers/<type>.ts` |
| **提供方**（provider） | 驱动的一个实例：地址 + 密钥。同一种驱动可以有多个（两套 ComfyUI、两个方舟账号） | 应用表 `providers.<id>` |
| **操作**（operation） | 驱动提供的一种能力：方舟的 `image` / `video` / `3d`，ComfyUI 的 `workflow`，ollama 的 `chat` | 驱动的 `operations` |
| **应用**（app） | 提供方 + 操作 + 模型（一个或多个）+ 驱动特有的 `options` + 参数默认值 | 应用表 `apps.<id>` |
| **模型档案**（model profile） | 某个模型（或一类模型，按前缀）的参数差异 | 应用表顶层 `models`，应用里 `models.<id>` 再覆盖 |

## 3. 功能需求

### 3.1 模块

`@shadecn/mod-apps`，模块名 `apps`，随 `web` 和 `agent` 角色加载（agent 的工具以后在执行副本上直接调服务），不建表、不跨副本。
依赖 `canvas`（画布入口的守卫），软依赖 `storage`（画布入口的资源读写，没有就原样）。前后端共用的线上形状在 `@shadecn/shared/apps`。
`provides: ['apps']`：别的模块经 `ctx.service('apps')` 拿 `AppsService`（`@shadecn/mod-apps/contract`）。
应用表不存在或为空 → 模块关掉，原因进启动日志和 `/api/features`。

### 3.2 驱动协议

驱动（`ProviderDriver`）只回答三件事：

1. 提供方实例要哪些字段（`parseProvider`）；
2. 有哪些操作（`operations`）；
3. 每个操作在某个应用的 `options` 下：类别、**基础参数表**、执行函数（`prepare` → `PreparedApp { category, params, checkModel?, submit, poll?, cancel?, pollIntervalMs? }`）。

**执行拆成「提交」和「查状态」两步**（§3.10 的续查要靠它）：

- `submit(values, ctx, model)`：同步出结果的上游（方舟生图、ollama）直接回 `{ done: true, output }`；任务型的上游（方舟视频 / 3D、ComfyUI）建好任务就回
  `{ done: false, handle }` —— **续查句柄** `handle = { upstreamId, state? }` 是可 JSON 序列化的，存进任务表，进程重启后拿它接着查；
- `poll(handle, ctx)`：按这个驱动的上游接口**查一次**状态（方舟 `GET /tasks/{id}`、ComfyUI `GET /history/{id}`），没完回 `{ done: false, status, ratio? }`，
  完了回 `{ done: true, value: output }`（取产物也在这一步），失败抛 `AppError`；
- `cancel(handle, ctx)`：可选，尽力撤销上游任务（方舟删任务、ComfyUI 从队列删 / 打断），失败只打日志；
- 轮询的循环、间隔（`pollIntervalMs`，提供方可配）、时限、中止、进度回调都在执行层，驱动不写循环、不 sleep。

**驱动不认识具体模型**：基础参数表取各代模型的并集（最宽的上限），每个模型的收窄写在配置里（§3.7）。`requiresModel: false` 的操作（ComfyUI —— 模型在工作流里）不写 `model`；
`checkModel(model)` 让驱动在启动时判某个模型现在用不用得了（LLM 驱动在这里解析模型），用不了的只标它一个。

字段读取统一经 `Fields`：类型、必填、默认值、**未知字段报错**、**密钥只认 `"$环境变量名"`**。驱动不读 `process.env`，不调 `fetch` 判状态码 ——
上游请求、二进制读取（带大小上限）、任务轮询在 `http.ts`。

### 3.3 应用表与配置

| 配置项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `modules.apps.file` | `APPS_FILE` | `<dataDir>/apps.yaml` | 应用表文件（YAML / JSON），相对路径按应用根目录 |
| `modules.apps.timeoutMs` | `APPS_TIMEOUT_MS` | `600000` | 应用没写 `timeoutMs` 时一次执行的时限 |
| `modules.apps.enabled` | `APPS_ENABLED` | `true` | 开关 |

完整示例：仓库根的 [`apps.example.yaml`](../apps.example.yaml)（`packages/mod-apps/test/example.test.ts` 解析它，写错了测试会红）。形状：

```yaml
models:               # 模型档案（§3.7）：所有应用共用，按顺序取第一条匹配的
  doubao-seedream-5-0*: { title: Seedream 5.0, params: { image: { maxLength: 10 }, maxImages: null } }
providers:
  ark:    { type: ark, apiKey: $ARK_API_KEY }               # baseUrl 默认 https://ark.cn-beijing.volces.com/api/v3
  comfy:  { type: comfyui, baseUrl: http://127.0.0.1:8188 }  # apiKey 可选（鉴权代理）
  local:  { type: ollama }                                   # baseUrl 默认 http://127.0.0.1:11434/v1
apps:
  seedream:
    title: Seedream 生图
    provider: ark
    operation: image
    model: [doubao-seedream-5-0-pro-260628, doubao-seedream-5-0-flash-260915]   # 多个 = 调用方可选
    models: { doubao-seedream-5-0-flash-260915: { title: 5.0 flash } }          # 可选：只对这个应用的覆盖
    options: { body: { optimize_prompt_options: { mode: fast } } }              # 驱动特有的配置
    defaults: { size: 2K }
  seedance:
    provider: ark
    operation: video
    model: doubao-seedance-2-0-260128
    timeoutMs: 900000
  sdxl:
    provider: comfy
    operation: workflow   # 不写 model
    options:
      workflow: data/comfy/sdxl.json
      category: image
      inputs:
        prompt: { node: "6", field: text, type: string, required: true }
        seed:   { node: "3", field: seed, type: integer, random: true }
  qwen:     { provider: local, operation: chat, model: [qwen3, llama3], options: { system: 你是一个简洁的助手 } }
```

- **文件形状不对 → 启动失败**：不认识的字段、类型不对、引用不存在的提供方 / 操作 / 工作流节点、`defaults` 里写了哪个模型都没有的参数、密钥写了明文、
  该写 `model` 没写（或不该写写了）、`model` 重复、`models.<id>` 不在 `model` 列表里、模型档案的 key 里 `*` 不在最后；
- **配置对但现在用不了**（`$ENV` 引用的变量没设、模型解析不了）→ 应用标成不可用（`unavailable` 带原因），启动打一行 `[apps]` 警告，执行回 `unavailable`。

### 3.4 参数

所有驱动共用一套参数类型：`string` / `number` / `integer` / `boolean` / `image` / `images` / `size`（§3.9）/ `json`，带 `required` / `default` / `enum` / `min` / `max` / `maxLength`（`size` 另有 `tiers` / `presets` / `minPixels` / `maxPixels` / `maxAspect`）。
单个值的校验是 `@shadecn/shared/apps` 的 `checkParamValue`，**前后端同一个函数**（前端的尺寸选择器据此判「合不合这个模型」）。
执行层统一校验：缺必填、类型、范围、枚举、**不认识的参数**一次全报出来（`invalid_params`）；空串 / 空数组当没给。
默认值优先级：调用方 > 应用表 `defaults` > 驱动的 `default`。图片参数是 `http(s)` 地址或 `data:image/…;base64,…`。

### 3.5 结果与错误

```ts
interface AppResult { appId; outputs: AppOutput[]; usage?; upstreamId?; durationMs }
interface AppOutput { kind: 'text' | 'image' | 'video' | '3d' | 'audio' | 'file'; text?; url?; data?: Uint8Array; mimeType?; meta? }
```

失败一律是 `AppError`，`code` ∈ `not_found` / `unavailable` / `invalid_params` / `upstream` / `timeout` / `aborted`；上游原始报文截短后只进 `detail` 和日志。

### 3.6 HTTP 入口（web 角色，需登录）

| 请求 | 说明 |
|---|---|
| `GET /api/apps` | 应用列表：id、标题、类别、驱动类型、参数表、不可用原因（不含地址和密钥） |
| `GET /api/apps/:appId` | 一个应用 |
| `POST /api/apps/:appId/execute` | 请求体 `{ params }`，同步等结果；字节产物在回包里是 `dataUrl`。请求体上限 32MB；客户端断开 = 中止 |
| `POST /api/flows/:flowId/apps/:appId/execute` | 画布节点用（§3.8、§3.10）：请求体 `{ params, nodeId }`，**提交即返回** `202 { task }`；叠画布守卫（非成员 404）。参数在提交时就按模型校验（错了直接 400，不建任务）；同一个节点已有进行中的任务 → 409 |
| `GET /api/flows/:flowId/apps/tasks` | 这张画布进行中（排队 / 生成中）的任务：`{ tasks: AppTaskView[], now }` |
| `POST /api/flows/:flowId/apps/tasks/:taskId/cancel` | 取消一个任务：发起人或项目管理员（别人 403）；已经结束 / 不存在 → 204（幂等） |

状态码：`invalid_params` 400、`not_found` 404、`unavailable` 503、`upstream` 502、`timeout` 504、`aborted` 499。

### 3.7 一个应用多个模型

- `model` 写一个 id 或一个数组。**多于一个**时参数表最前面多一个 `model` 参数（`enum` = 列表，`default` = `defaults.model` 或第一个可用的），调用方按它选；
  单模型的应用没有这个参数（传了算不认识的参数）。
- **每个模型的参数表** = 驱动的基础表 → 应用表顶层 `models` 里**第一条匹配**的档案（key 是模型 id 或 `*` 结尾的前缀，所以更具体的写在前面）→ 应用里的 `models.<id>`。
  档案里每一项是对参数说明的部分覆盖（`enum` 整个替换），`null` = 这个模型没有这个参数，新参数要写 `type`。
- **按选中的模型校验**：5.0 传 `maxImages` 报「不认识的参数」，11 张参考图报「最多 10 张」，都在发请求之前。`defaults` 只对有这个参数的模型生效。
- 某个模型用不了（`checkModel` 回原因）只标它：`AppInfo.models[i].unavailable`；默认模型跳过它；选它执行回 `unavailable`。全都用不了整个应用才不可用。
- `GET /api/apps` 的每一项带 `models: [{ id, title, params, unavailable? }]` 和 `defaultModel`；`params` 是默认模型的那份（含 `model`）。

### 3.8 画布节点用应用生成

图片 / 视频节点（generate 形态）的底部输入框，发送按钮左边是**应用 / 模型选择器**（`components/flow/apps/AppPicker.vue`）：

- 列出这个节点类别（看输出端口：图片节点 → `image`，视频节点 → `video`）的应用，用不了的置灰、悬停看原因；应用是多模型的才有第二个下拉；
  所选应用 / 模型用不了时旁边一句原因；一个应用都没有时只显示「服务端还没有配置生成应用」。
- **参考图上限不显示，直接限制连入**：按所选模型的参考图上限（第一个 `images` 参数的 `maxLength`，只有 `image` 参数 = 1 张，没有图片参数 = 0），
  图片端口连满了拖线连不进来、落在节点身上拒绝、底部输入框的加号建不出新节点，提示「Seedream 5.0 最多连 10 张参考图」。
  走的是连线规则里「端口已满」那一步（连线上下文的 `inputLimit`，只收紧不放宽），**只在人连线这一侧**：agent 连线不受它限，
  多出来的参考图生成时截掉并提示（下面第 2 步）。换了模型、已有的连线超出新上限的不删（读的一侧不回写），生成时截掉。
- 选择写进节点的 `data.appId` / `data.appModel`（协作者看到的是同一个选择，一步撤销）；没选 / 选的不在了 = 这个类别第一个可用的应用、它的默认模型（读的一侧不回写）。

**发送 = 生成**（`runnable` 把 `composer:submit` 转成 `node:run`，运行器是能力 `app-run`）：

1. **输入**（`collectNodeAppInputs`）：参考图 = 连进来的、有图的上游，按连入顺序（`data.inputOrder`）；提示词里对参考图的 `@` 提及换成「图N」（方舟按「图1」「图2」认图），
   对文本节点的提及换成它的正文；连进来但没被提及的文本节点，正文接在提示词前面。
2. **参数**（`@shadecn/shared/apps` 的 `nodeAppParams`，按参数表认、不按驱动认）：提示词进 `prompt`，参考图进第一个 `images` 参数（截到上限，截掉几张就提示几张），
   没有就进第一个 `image` 参数；多模型应用带上 `model`。
3. **提交与执行**：`POST /api/flows/:flowId/apps/:appId/execute`（画布守卫：非成员 404）建一个生成任务就返回，执行在服务端（§3.10）。参考图里**属于这张画布的资源**由服务端按对象键读字节、换成 data URL 交给上游
   （`storage.assets.read`：地址先反解成本桶键，再查 `FlowAsset` 归属，**从不请求那个地址**）；别的地址原样交给驱动（方舟收地址，ComfyUI / LLM 拒）。
   图片 / 视频产物**存成这张画布的资源**（`storage.assets.save`：同上传接口的键、缩略图、`FlowAsset` 记录），回包的 `url` 是本服务的地址（上游地址会过期）；
   上游给的是地址时由服务端取回（只取 https、有大小和时间上限）。存失败的那一个保留上游地址。没有对象存储时两头都原样。
4. **写回由服务端做**（§3.10）：任务成功后执行副本经活房间把产物用 `recordGeneration`（= `attachAsset` + 记一条生成历史，[REQ-CANVAS](13-flow-canvas-management.md) §3.7「生成历史」）挂到这个节点（有连入的节点保持 generate 形态，可以改了提示词再生成；视频有尾帧图就当预览图），
   **关掉页面也照样挂回去**。运行状态写在 `runtime`，**只有执行副本写**（前端一笔都不写）：执行副本接手时写 `processing` + `taskId` → `completed`，或 `error` + 服务端那句话，取消回到 `idle`。
   排队中（还没有执行副本接手）节点上没有痕迹，只在任务列表里（§3.10）。状态**不进任何人的撤销栈**（服务端的 origin 不在任何人的 `trackedOrigins` 里）；生成结果也不在发起人的撤销栈里。
5. 同一个节点同时只有一个进行中的任务（服务端判，409「这个节点正在生成」）；前端在提交请求还在路上、或这个节点有进行中（排队 / 生成中）的任务时，底部输入框的发送按钮转圈、不可点（`useFlowAppTasks().isGenerating`）。
   选的应用不可用 / 没有应用：只提示，不发请求、不改状态。提交被拒（参数、没有执行实例）：只提示服务端那句话，节点不带错误态（没有任务）。

### 3.9 尺寸参数与弹出框

**`size` 类型**：值是一个分辨率档位（`tiers` 里的一个，比例由模型按提示词定 —— 方舟推荐的写法），或 `宽x高`。宽x高要满足像素总量（宽 × 高）在 `[minPixels, maxPixels]`、
长边 / 短边 ≤ `maxAspect`；`presets` 是常用宽高表（比例 → 每档的宽x高，和 `tiers` 等长同序），**是参考值不是白名单**，范围内的别的宽高照样收。
启动时校验：`presets` 每一行和 `tiers` 等长、表里每个宽高都在范围内，否则起不来。

方舟 Seedream 各代的档位、宽高表、范围抄自方舟文档（2026-11），写在 `apps.example.yaml` 的模型档案里：

| 模型 | 档位 | 宽 × 高像素范围 |
|---|---|---|
| 5.0 pro / flash | 1K / 1.5K / 2K | 921600～4624220 |
| 5.0 lite | 2K / 3K / 4K | 3686400～16777216 |
| 4.5 | 2K / 4K | 3686400～16777216 |
| 4.0 | 1K / 2K / 4K | 921600～16777216 |

比例都在 1/16～16；常用比例 1:1、4:3、3:4、16:9、9:16、3:2、2:3、21:9。同一比例同一档位，各代的宽高不一定一样（16:9 的 1K：5.0 是 1424x800，4.0 是 1280x720）。

**画布节点上的尺寸按钮**（所选模型有 `size` 参数才出现，在模型下拉右边）：显示当前尺寸（「16:9 · 2K」「2K · 自动比例」），点开是弹出框（`apps/SizePicker.vue`）：

- **分辨率**：`tiers` 里的档位按钮；换分辨率时比例保持（换成同一比例的另一档），这一档没有那个比例就回到「自动」；
- **比例**：「自动」（只传档位，比例由模型按提示词定）+ `presets` 的比例，每格只有一个按比例的小方块和比例本身（不显示宽高），这一档没有参考值的比例不可选；
- 只能在表里选，**不能自定义宽高**（表外的值只可能来自应用表默认值或别的调用方，按钮上照样显示）；
- 面板没有底栏（不显示当前值、没有「恢复默认」）；尺寸按钮和旁边的应用 / 模型下拉同一套外观（边框、底色、高度、右侧箭头）。
- 选择写进节点的 `data["appParam.size"]`（一个参数一个键，`appParam.<参数名>`）。换了模型、旧值不合新模型时**不清掉**：按钮显示默认值并标红，执行时不带它（`nodeAppParams` 用同一份校验过滤）。

底部输入框加宽到 520px，放得下应用、模型、尺寸三个控件。

### 3.10 生成任务（任务化执行）

视频 / 3D 要几分钟，同步等会撞上 ingress 的超时，关页面结果也挂不回去。所以画布上的生成是**任务**：提交 → 服务端执行 → 写回节点。

**状态分三层放，各管一件事**：

| 层 | 放什么 | 为什么 |
|---|---|---|
| 节点 `runtime`（Y.Doc） | `status`（`processing` / `completed` / `error` / `idle`）、`taskId`、`error` —— 只在状态切换时写，**只有执行副本写** | 协作者都看得到、刷新后还在、不进撤销栈。`processing` = 执行副本已经在跑 |
| 任务表 `app_task`（数据库，权威） | 应用、模型、参数、发起人、状态、进度、续查句柄、租约、错误、产物、时间 | 生命周期的事实源：关页面、换副本、进程重启都不丢 |
| 任务列表推送（不落库） | 这张画布进行中的任务全量列表（stateless `apps:tasks`） | 进度是高频变化，写进 Y.Doc 会撑大文档、刷落库；和 agent 任务列表同一条路 |

**任务状态**：`queued`（排队，没有执行副本接手）→ `running`（执行副本接手，带进度 `{ status, ratio? }`）→ `succeeded` / `failed` / `canceled`。

**谁执行**：web 角色只受理（校验参数、建任务行、经总线**派给一个** agent 角色的副本），**agent 角色执行**（它带着 headless 协同实例，能经 direct connection 写活房间；同 agent 的一轮，docs/28 §3.6）。

**执行身份：凭发起人**（同画布 agent 的 Grant，[REQ-AGENT-SANDBOX](22-agent-sandbox.md) §5）：执行副本接手时按发起人签一份执行身份（记下画布当时所在的项目 / 个人空间所有者）；
发起人此刻就进不了这张画布 → 任务记失败「发起人已不能访问这张画布」，不开房间、不调上游。之后**每次用画布之前判一次**：读参考图前 `flow:read`，存产物、写节点前 `flow:write`，每次续租顺带判一次；
有效权限 = 发起人此刻是这张画布的成员 ∩ 画布仍在签发时那个项目里（判权结论缓存 3 秒）。权限变化事件（移除成员、删项目 / 画布）当场重判本副本在跑的任务（别的副本最迟一个巡检周期）。
**失权即停**：撤上游任务、任务记失败「发起人已失去这张画布的访问权限」，**不再写节点**（已经无权写了）。和登录态无关：发起人退出登录、会话过期不影响在跑的任务。
判权本身查不了库 → 这一步不做（写节点跳过；读参考图 / 存产物时任务记失败）。不另建授权表：任务行本身记着发起人、画布、起止和结果。
没有 agent 副本 → 任务记为失败，回 503。派发超时不重发（可能已经开始），任务留在 `queued` 等对账接手。

**租约与续查**：执行副本接手 = 原子地写上自己的实例 id 和租约到期时间（`lease_owner` / `lease_until`），执行期间每 10 秒续一次（租约 30 秒）。
续租时顺带读一次状态：被取消了就中止。每个 agent 副本每 15 秒对账一次：`queued` / `running` 且租约过期（或没有租约）的任务由它接手 ——
有续查句柄的（任务型上游已建好任务）**接着查**，不重新提交；排队中的照常执行；没有句柄却在 `running` 的（同步上游调到一半进程没了）记为失败「执行中断，请重新生成」，不重复扣费。
时限从任务开始算（`started_at` + 应用的 `timeoutMs`），续查不重置。

**执行**（执行副本）：参考图里本画布的资源换成字节（§3.8 第 3 步）→ `submit` → 句柄存表 → 按间隔 `poll`，每次把进度写表并推送 → 产物存成画布资源 → 写回节点 → 任务行记结果。
执行期间那张画布的房间由这条 direct connection 钉着（推送要从持有房间的副本发出，多副本经 redis 扩展转发），结束时断开（断开即落库）。
写之前判发起人此刻还能进这张画布、房间没到容量上限；节点被删了 / 节点的 `runtime.taskId` 已经不是这个任务了，就只记任务结果，不碰节点。

**取消**：发起人或项目管理员。web 把任务行从 `queued` / `running` 原子地改成 `canceled`，再经总线通知所有 agent 副本：持有它的那个立刻中止、尽力撤销上游任务（驱动的 `cancel`）、把节点改回 `idle`。
通知丢了也不要紧，下一次续租读到 `canceled` 照样中止。排队中的任务没有执行者、节点上也没写过 `processing`：web 再经总线让一个 agent 副本补推一次任务列表，别的协作者的列表才会去掉它。

**推送**：任务开始、每次进度、结束时，执行副本读这张画布进行中的任务全量（库里），经房间的 stateless 发 `apps:tasks`（`AppTasksMessage { flowId, tasks, now }`）。
前端连上 / 重连时 `GET …/apps/tasks` 拉一次，之后只收推送、整份替换（同 agent 任务列表，没有轮询）。

**界面**：

- 节点：`runtime.status === 'processing'`、或任务列表里有这个节点排队中的任务时，节点**主体上盖一层生成中的状态**（和「生成失败」同一个位置、同一套外观，**不撑开节点**，外圈高亮）：
  转圈 +「排队中」/「生成中」，上游给了进度就是进度条 +「生成中 42%」（按 `runtime.taskId` 去任务列表里找，再按节点找；都找不到就是「运行中」），下面一个「取消」（发起人和管理员才有）。
  成功后节点直接显示产物（服务端写的 `src`）；失败时盖一层「生成失败」（服务端的原话在悬停提示里），重新发送即重试；
- 右上角**单独一个「生成任务」按钮**（排在分享按钮和对话按钮之间，和 agent 的对话按钮分开，对话按钮只数 agent 的轮次）：有任务在跑时外圈转一个环、右上角挂任务数；
  点开是一个浮层，列出进行中的生成任务（应用 · 节点名、发起人（项目画布）、状态 / 进度条、已用时），点一行定位到那个节点（浮层不关），行尾「取消」只给发起人和管理员；
  没有任务时是一句空状态。

## 4. 驱动

### 4.1 火山方舟 `ark`

- `image`：`POST /images/generations`，同步；参数 `prompt`（必填）、`image`（参考图，≤14）、`size`、`maxImages`（>1 时开组图）、`watermark`（默认 false）、`outputFormat`；
  组图里个别失败不影响其余的，一张都没有才算失败；
- `video`：`POST /contents/generations/tasks` 建任务（`submit` 回句柄）→ `GET …/tasks/{id}` 查状态（`poll`，默认 5 秒一次，提供方 `pollIntervalMs` 可改）→ 取消是 `DELETE …/tasks/{id}`（方舟只撤得掉排队中的）；参数 `prompt`、`firstFrame`、`lastFrame`、`referenceImages`、
  `resolution`、`ratio`、`duration`、`generateAudio`、`watermark`、`seed`；首尾帧 / 参考图的互斥规则在发请求前就校验；产物 `content.video_url`（`return_last_frame` 时还有尾帧图）；
- `3d`：同一组任务接口；参数 `image`（必填）、`fileFormat`（默认 glb）、`subdivisionLevel`；产物 `content.file_url`（zip）。
- 模型写在应用上；基础参数表取 Seedream / Seedance 各代的并集，各代的收窄在 `apps.example.yaml` 的 `models` 段（2026-11 按方舟文档核对；Seedream 4.0 / 4.5 / 5.0 lite、Seedance 1.0 lite / 1.5 的确切 id 文档里没找到，按前缀匹配）。
- 每个操作的 `options`：`body`（原样并进请求体的固定字段，给不常用、随模型代际变化的参数用；盖不掉 `model` 和已映射的参数）。

### 4.2 ComfyUI `comfyui`

- 操作 `workflow`（不写 `model`：模型在工作流里，要让调用方选就把 `ckpt_name` 映射成带 `enum` 的参数）：API 格式的工作流文件 + `inputs`（参数名 → `node` / `field`，其余字段即参数说明）+ 可选 `outputs`（只收哪些节点）+ `category` + `maxOutputMb`（默认 100）；
- `POST /prompt`（`submit` 回句柄 `prompt_id`）→ `GET /history/{id}`（`poll`）→ 完成时 `GET /view` 取字节（预览 `temp` 不要）；产物是字节，因为 ComfyUI 的地址浏览器通常到不了；
  取消 = `POST /queue { delete: [id] }` + `POST /interrupt { prompt_id }`；
- `random: true` 的整数参数没给时随机（同参数的请求 ComfyUI 会直接回缓存结果）；
- **图片参数只收 data URL**，先 `POST /upload/image` 再把文件名填进节点。服务端替调用方抓任意地址是 SSRF 入口，不做。

### 4.3 ollama `ollama`

- 操作 `chat`：一问一答，不带工具、不留历史。模型写在应用上（`ollama list` 里的名字，一个或多个，每个启动时各解析一次）。`options`：`system`（写了就不再作为参数）、`maxTokens`（默认 4096）、`imageInput`（开了才有 `images` 参数）；
- 走 `@shadecn/agent/model` 的 `ollama` 预设（本机 `/v1`、占位 key、保守兼容开关）+ `@shadecn/agent/model-stream` 的 `streamUpstream`；
- 驱动由 `createLlmDriver({ type, provider })` 生成：接 pi 注册表里的其他提供方是注册表里多一行。

## 5. 本期不做

- **画布外调用的产物转存**：`/api/apps/:appId/execute` 和服务调用的产物仍是上游地址 / 字节（画布入口已转存，§3.8）。转存要先定好"不属于某张画布的对象"的键空间；
- **画布外调用的任务化**：`/api/apps/:appId/execute` 和服务调用仍是同步的（画布入口已任务化，§3.10）；
- **任务历史界面**：任务表留着已结束的任务（排查用），界面只显示进行中的；
- **agent 工具**：把应用暴露成 agent 的技能（[REQ-AGENT-SKILL](23-agent-skills.md)），产物挂到画布节点上；
- **按参数表渲染的完整表单**：画布节点只用提示词 + 参考图 + 模型 + 尺寸（§3.8、§3.9），其余参数用应用表的 `defaults`；
- **判权与配额**：现在登录即可调用所有应用；按用户 / 项目的限额、计费没有；
- **流式文字输出**、多轮对话、ComfyUI 的 WebSocket 进度。

## 6. 验收标准

- `pnpm test:mod-apps`：应用表的形状错误、明文密钥、缺环境变量即不可用、参数校验、超时 / 中止、方舟图片 / 视频 / 3D、ComfyUI 工作流、ollama 的请求形状；
- `apps/server/test/routes/apps.test.ts`：未登录 401、列表不泄露提供方配置、错误码映射、成功回统一结果；
- `pnpm test:mod-apps` 的 `models.test.ts` / `example.test.ts`：模型档案的套用顺序、按模型校验、配置错误、`checkModel`、示例文件可解析；
- `apps/server/test/routes/flow-apps.test.ts`：画布守卫、本画布资源换成字节（不请求地址）、别的画布的资源不换、产物存成本画布资源、没有存储时原样；
- `pnpm test:mod-apps` 的 `drivers.test.ts`：各驱动 `submit` / `poll` / `cancel` 的请求形状；`catalog.test.ts`：句柄回调、续查（`resumeApp`）、时限从开始算；
- `apps/server/test/routes/flow-apps.test.ts`（任务化）：提交回 202 + 任务、参数错 400 不建任务、同节点 409、执行后节点被写回（`src` / `runtime`）、失败写 `error`、任务列表、取消（权限、幂等、中止执行）、
  重启续查（有句柄的任务被对账接手、接着查不重新提交；没句柄的 `running` 记失败）；
- `packages/shared/test/apps.test.ts`：节点输入 → 参数的映射、`apps:tasks` 载荷的解析；`apps/web/src/test/components/flow/apps/app-run.test.ts`：选应用 / 模型、提及换「图N」、
  提交后写 `processing` + `taskId`、状态不进撤销栈、提交失败 / 不可用 / 重复发送；任务列表（推送替换、重连拉取）、节点角标的进度与取消、会话按钮计数。

## 7. 待确认

- 应用表是否要搬进数据库、由管理界面维护（现在是文件，改了要重启）；
- 应用的可见范围（全员 / 按项目）。
