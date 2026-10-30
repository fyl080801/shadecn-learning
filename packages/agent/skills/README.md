# 文字技能（pi `SKILL.md`）

这个目录放画布 agent 的**文字技能**（REQ-AGENT-DEF `docs/26-agent-definitions.md` §3.8、REQ-AGENT-SKILL `docs/23-agent-skills.md` §7）：
只有指令、不带代码、不新增工具，可以声明依赖哪些内置技能。它和代码目录 `packages/agent/src/skills/`（内置技能）是两回事。

**本文件不是技能**：根目录下的 `README.md`（不分大小写）只是这个目录的说明，加载时跳过。仓库目前没有放任何文字技能。

## 格式

```md
---
name: storyboard-review
description: 按分镜规范检查导演台场景，列出问题
requires: [director]        # 可省略：依赖的内置技能 id
---

（正文：指令）
```

- `name`：小写字母开头，只能有小写字母、数字、`-`，最长 48；不能和内置技能 id（`canvas`、`director`……）或它们的旧 id（`canvas-edit`、`delegate`）重名，也不能和别的文字技能重名。发布后不改：会话记住的就是它。
- `description`：必填，一句话（≤ 1024 字），进系统提示的技能目录。
- `requires`：可省略；YAML 数组或逗号分隔，只能写现有的内置技能 id（不能写文字技能）。
- 只认这三个键；其余的（包括 pi 的 `disable-model-invocation`）一律报错。
- 正文不能为空。

## 放在哪

- `<name>/SKILL.md`：一个子目录一个技能，`name` 必须和目录同名；找到 `SKILL.md` 就不再往这个目录里面找。没有 `SKILL.md` 的子目录会继续往下找。
- `<name>.md`：直接放在本目录根上的 `.md` 也各算一个技能（`README.md` 除外）。
- 以 `.` 开头的和 `node_modules` 跳过。

服务端启动时读这个目录并校验（`apps/server/agent/definitions.ts`），**任何一个文件不合法服务都起不来**；构建时拷到 `output/server/skills/`。
