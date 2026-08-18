# 需求文档索引

本目录按「一个需求一个文件」整理当前项目的需求。每篇文档都包含：目标与背景、功能需求、验收标准、本期不做（Out of Scope）、待确认事项。

代码实现细节请看 `CLAUDE.md`（架构说明）与源码；本目录只描述**要做什么**和**做到什么程度**。

| 编号 | 需求 | 文档 | 状态 |
|---|---|---|---|
| — | 项目总体定位与共性约束 | [00-project-overview.md](00-project-overview.md) | 持续 |
| REQ-SHELL | 应用外壳：布局、导航、路由 | [01-app-shell.md](01-app-shell.md) | 已实现 |
| REQ-AUTH | Keycloak 单点登录与会话（BFF） | [02-auth-keycloak.md](02-auth-keycloak.md) | 已实现 |
| REQ-SERVER | 单进程单端口服务端 | [03-server-runtime.md](03-server-runtime.md) | 已实现 |
| REQ-COLLAB | Yjs 实时协同 | [04-realtime-collab.md](04-realtime-collab.md) | 已实现 |
| REQ-DATA | 数据存储与业务 API | [05-data-persistence.md](05-data-persistence.md) | 部分实现 |
| REQ-3DEDITOR | Three.js 场景编辑器 | [06-three-editor.md](06-three-editor.md) | 已实现 |
| REQ-DIRECTOR | 3D 导演台 | [07-director-console.md](07-director-console.md) | 已实现 |
| REQ-PROMPT | 插件式富文本输入组件 | [08-prompt-input.md](08-prompt-input.md) | 已实现 |
| REQ-FLOW | 流程图画布 | [09-flow-chart.md](09-flow-chart.md) | 已实现 |
| REQ-DEMO | 演示页与小游戏 | [10-demo-pages.md](10-demo-pages.md) | 已实现 |
| REQ-QA | 质量保障：测试、类型、Lint | [11-quality-testing.md](11-quality-testing.md) | 已实现 |
| REQ-DEPLOY | 构建与部署 | [12-deployment.md](12-deployment.md) | 已实现 |
| REQ-CANVAS | 项目、画布管理与操作历史 | [13-flow-canvas-management.md](13-flow-canvas-management.md) | 已实现 |
| REQ-CLUSTER | 单副本 / 多副本双模式 | [14-clustering.md](14-clustering.md) | 已实现 |
| — | 协同方案案例研究：竞品与横向对比 | [15-collab-case-study.md](15-collab-case-study.md) | 调研 |

## 状态口径

- **已实现** — 文档中列出的功能需求在当前代码里都能跑通。
- **部分实现** — 有可用实现，但文档中标注了明确的缺口。
- **规划中** — 只有需求，尚无实现。
- **调研** — 不是需求，是给设计决策提供依据的外部考察记录。


## 剩余优化项与已知问题

各需求文档里都有自己的「本期不做 / 已知缺口 / 待确认」，这里只汇总**跨需求、或当前最该关注**的几条，
方便一眼看全。括号里是详情所在。

### 已知问题（会影响使用，但当前接受）

| 问题 | 影响 | 详情 |
|---|---|---|
| 同一字段并发写只有一个赢 | 两人同时拖同一个节点，有一方的操作被静默丢弃；不会数据损坏也不会分叉 | [REQ-COLLAB §5](04-realtime-collab.md) |
| ~~只能单副本~~ | **已解决**：`CLUSTER_MODE=redis` 打开多副本（内容与 awareness 经 Redis 同步、落库加分布式锁）；默认仍是单副本 | [REQ-CLUSTER](14-clustering.md) |
| `kill -9` 丢一个防抖窗口 | 最多丢 2–10s 的画布改动（正常退出有 SIGTERM 兜底；更新流是即时写的，不受影响） | [REQ-COLLAB §3.7](04-realtime-collab.md) |
| `FlowOperation` 只增不减 | 活跃画布的更新流会一直长；文档本身有 Yjs GC，这张表没有 | [REQ-DATA §6](05-data-persistence.md) |
| 断网时刷新打不开页面 | 数据有 IndexedDB 兜底，但应用本体要从服务器加载 —— 没有 Service Worker 就刷不出来 | [REQ-COLLAB §7](04-realtime-collab.md) |
| 侧栏导航与路由表各写一份 | 容易漏配；`Example.vue` / `Emu3DView.vue` 已无对应路由 | [REQ-SHELL §3](01-app-shell.md) |

### 值得做的优化（按性价比排序）

1. ~~**`y-indexeddb`**~~ —— **已做**。断网可继续编辑、改动跨「关页面」存活、恢复网络自动补发，
   加载态也随之改成「服务端已同步 **或** 本地缓存里有东西」（见 [REQ-COLLAB §3.8](04-realtime-collab.md)）。
2. ~~**增量投影**~~ —— **已做**。`observeDeep` 的事件里挑出变了的顶层键，只重解析那几个，
   其余复用同一个对象引用（Vue Flow 靠引用判断要不要重新同步）。
3. ~~**增量落库**~~ —— **部分做了**：状态向量没变就整个跳过；派生投影从「每次都写」降到「卸载前写一次」，
   省掉平时那一半序列化。**真正的基线 + 增量链没做** —— 那要引入 `ydocSeq`、加载时合并、基线压缩，
   还要处理 `FlowOperation` 写失败时的一致性，收益不值这个复杂度。
4. **`FlowOperation` 保留策略** —— 见上表。
5. **历史版本 / 回放界面** —— 数据齐了（按 seq 排列的更新流可重建任意时刻），只差界面。
6. ~~**多副本**~~ —— **已做**。`@hocuspocus/extension-redis` + 一层共享状态抽象（内存 / Redis 两套实现），
   由 `CLUSTER_MODE` 切换，默认仍是单副本（见 [REQ-CLUSTER](14-clustering.md)）。
7. **Service Worker** —— 现在断网**刷新**打不开页面（应用本身要从服务器加载）。
   y-indexeddb 只管数据，要做到「断网刷新照样用」得再加 PWA 那一层。

### 实现了但没启用

- **元素占用**（谁在编辑就别人别动）：仲裁逻辑与测试都在 `src/lib/presence.ts`，
  但没接进画布 —— 当前谁都能同时改同一样东西，节点标签只*显示*还有谁在碰它。
  这是产品选择，不是缺陷；要恢复见 [REQ-COLLAB §4.0.1](04-realtime-collab.md)。
  竞品 libtv 把占用接进去之后的翻车现场见 [协同案例研究 §2](15-collab-case-study.md)。
- **只读连接**：Hocuspocus 的 `connectionConfig.readOnly` 现成可用，但还没有「只读分享」这个功能，
  所以没有入口。

## 相关文档

- `CLAUDE.md` — 仓库架构说明与开发约定（面向 AI/新人）。
- `src/components/prompt-input/API.md` — PromptInput 的方法级 API 规约（属于接口契约，不在本目录）。
