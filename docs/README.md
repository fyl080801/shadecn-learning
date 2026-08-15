# 需求文档索引

本目录按「一个需求一个文件」整理当前项目的需求。每篇文档都包含：目标与背景、功能需求、验收标准、本期不做（Out of Scope）、待确认事项。

代码实现细节请看 `CLAUDE.md`（架构说明）与源码；本目录只描述**要做什么**和**做到什么程度**。

| 编号 | 需求 | 文档 | 状态 |
|---|---|---|---|
| — | 项目总体定位与共性约束 | [00-project-overview.md](00-project-overview.md) | 持续 |
| REQ-SHELL | 应用外壳：布局、导航、路由 | [01-app-shell.md](01-app-shell.md) | 已实现 |
| REQ-AUTH | Keycloak 单点登录与会话（BFF） | [02-auth-keycloak.md](02-auth-keycloak.md) | 已实现 |
| REQ-SERVER | 单进程单端口服务端 | [03-server-runtime.md](03-server-runtime.md) | 已实现 |
| REQ-COLLAB | Yjs 实时协同 | [04-realtime-collab.md](04-realtime-collab.md) | 部分实现 |
| REQ-DATA | 数据存储与业务 API | [05-data-persistence.md](05-data-persistence.md) | 部分实现 |
| REQ-3DEDITOR | Three.js 场景编辑器 | [06-three-editor.md](06-three-editor.md) | 已实现 |
| REQ-DIRECTOR | 3D 导演台 | [07-director-console.md](07-director-console.md) | 已实现 |
| REQ-PROMPT | 插件式富文本输入组件 | [08-prompt-input.md](08-prompt-input.md) | 已实现 |
| REQ-FLOW | 流程图画布 | [09-flow-chart.md](09-flow-chart.md) | 已实现 |
| REQ-DEMO | 演示页与小游戏 | [10-demo-pages.md](10-demo-pages.md) | 已实现 |
| REQ-QA | 质量保障：测试、类型、Lint | [11-quality-testing.md](11-quality-testing.md) | 已实现 |
| REQ-DEPLOY | 构建与部署 | [12-deployment.md](12-deployment.md) | 已实现 |

## 状态口径

- **已实现** — 文档中列出的功能需求在当前代码里都能跑通。
- **部分实现** — 有可用实现，但文档中标注了明确的缺口。
- **规划中** — 只有需求，尚无实现。

## 相关文档

- `CLAUDE.md` — 仓库架构说明与开发约定（面向 AI/新人）。
- `src/components/prompt-input/API.md` — PromptInput 的方法级 API 规约（属于接口契约，不在本目录）。
