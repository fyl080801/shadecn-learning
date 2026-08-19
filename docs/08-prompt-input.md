# REQ-PROMPT 插件式富文本输入组件（PromptInput）

## 1. 目标

做一个**只依赖 Vue**的富文本输入组件，用于 AI 对话框这类"以纯文本为主、夹杂结构化标记"的场景。

核心命题：不引入 Slate / ProseMirror / Tiptap，自己实现一套够用的编辑内核，并把所有"能插什么、怎么渲染、怎么序列化"的决定权交给**插件**。

演示页：`/richeditor`。方法级接口契约见 `src/components/prompt-input/API.md`（**新增或修改导出必须同步更新该文档**）。

## 2. 关键设计约束

| 约束 | 理由 |
|---|---|
| `v-model` 绑定的是**纯字符串** | 宿主拿到的永远是可直接发给后端 / 模型的文本；结构只是编辑期的中间表示 |
| 组件本体仅依赖 `vue` | 这是本需求的验证点；新增能力不得引入运行时依赖 |
| 结构化内容一律是**内联 void 节点** | 只需支持"文本中夹标记"，不做块级富文本（标题、列表、表格） |
| 插件决定 round-trip | `parse`（字符串 → 节点）与 `serialize`（节点 → 字符串）必须互逆 |
| 渲染由宿主提供 | 组件只出插槽（`#element:<name>` / `#portal:<name>`），不内置任何具体样式 |

## 3. 功能需求

### 3.1 编辑内核

- 文档模型：`Descendant[]`，段落块 + 文本叶 + 内联 void 节点。
- 选区模型：`Path` / `Point` / `Range`，光标**只落在文本叶上**。
- 每次提交后执行 normalization，保证以下不变量：
  1. 每个段落至少有一个文本叶；
  2. 段落的首 / 尾子节点恒为文本叶；
  3. 任意两个内联 void 之间必有文本叶；
  4. 相邻文本叶合并；
  5. 光标只停在文本叶上。
- normalization 会导致 path 位移，必须用「块下标 + 文本叶下标 + offset」三元组重新定位并 clamp 选区，避免光标乱跳。
- 所有对 `children` 的修改必须是不可变替换（新数组），禁止原地 push/splice。

### 3.2 历史栈

- 默认上限 100 条。
- **只有内容性提交入栈**；仅改选区的提交（`Transforms.select`）不单独入栈，会并入下一次内容提交。
- `editor.batch(fn)` 把多次提交合并成一条撤销记录（粘贴等复合操作必须使用），支持嵌套。
- `undo` / `redo` 期间禁止重入入栈。
- `editor.muteHistory(fn)` 让"程序联动"的改动不占撤销步（删除某个 badge 后的重编号、外部素材删除后联动移除引用）：期间的提交照常推进内容与 `revision`，但不入栈，且下一次正常编辑的撤销点是**静音变更之后**的状态——撤销不会把静音变更一起吐回来。静音变更同样清空 redo 分支。

### 3.3 触发器与 popover

- 插件可声明触发字符（如 `@`），默认匹配 `^{key}(\S*)$`。
- 触发后组件负责：定位并打开 popover、把搜索词透传给宿主（`trigger-open` / `trigger-search` / `trigger-close`）、把键盘事件先交给插件的 `onKeyDown` 拦截（上下选择、Enter/Tab 提交、Esc 关闭）。
- popover 内容完全由宿主通过 `#portal:<name>` 插槽提供。
- 视口变化时宿主可调用 `repositionPopover()` 重新定位。

### 3.4 无触发器插件

插件可以只声明 `parse` / `serialize` 而没有触发字符 —— 用于渲染由外部程序写入文本的标记（如 `{{Ref 1}}`、`{{Camera}}`）。

### 3.5 可编辑内联块

内联 void 节点可以声明 `data-inline-editable`，表示"我自己处理输入"，外层引擎跳过默认处理。行内代码插件（`src/components/inline-code/`）就是这个能力的样例：

- 文本形态是 Markdown 风格的 `` `code` ``；
- 块内可直接点击编辑，但**禁止换行**；
- 左右方向键在块边界处**整块跳过**，不逐字进入；
- 内容变化通过 `commitInlineCodeText` 写回 `node.data.text` 再触发 `apply()`；
- 序列化时若内容含换行需压缩为空格（防御）。

> 实现要点：块内 DOM 文本必须由子组件自管（ref + 手动同步），不能走模板插值 —— 否则每次 `revision++` 重写 `textContent` 会把光标拉回块首。

### 3.6 字符串序列化约定

- **一个 `\n` = 一个段落块**（DOM 上是独立的 `<div data-block-path>`），空行即空段落；文本叶内**禁止**出现字面 `\n`。
  - 理由：靠 `white-space: pre-wrap` 在叶内折行时，浏览器在折行点的点击定位与光标换算不可靠（长段落尤甚），而且与 Enter 的 `splitBlock` 行为不一致——同样是"换行"，一个进模型是字符、一个是新块。
  - 因此 `Transforms.insertText` 收到带 `\n` 的文本（Chrome 某些 Enter / IME 序列会发出 `data: "\n"` 的 `insertText`）时，自动拆成"逐行插入 + `splitBlock`"，并 `batch` 成一次撤销。
- 入模型的文本统一清洗：`\r\n` / `\r` 归一为 `\n`，剥掉 `U+200B` / `U+FEFF`（存量数据里泄漏的零宽占位符——不可见却占一个光标停靠点，行尾残留时方向键跨行要多按一次且光标短暂消失）。ZWJ / ZWNJ 参与 emoji 合字，不剥。
- `parse` 和 `serialize` 都按插件**注册的逆序**执行：后注册者优先认领。
- 节点找不到序列化器时 `console.warn` 并丢弃该节点，不得抛错。
- `splitByRegex` 要求正则必须带 `g` 标志，否则抛错；并且要能处理零宽匹配导致的死循环。

### 3.7 组件能力

- 字符数限制（`maxLength`）+ 计数器（`showCounter`）+ 清空按钮（`showClear`），超限时触发 `exceed-limit` 并给出提示。计数**剔除换行和零宽字符**。
- 只读模式（`disabled`）。
- 占位文案（`placeholder`）。
- 样式可完全覆盖（`containerClass` / `wrapperClass`）。
- `deferFocusOnClick` —— 挂载时不自动聚焦，避免嵌在画布类页面中时抢走 Delete 键。
- 通过 ref 暴露 `getSelectedText()` / `getFullText()` / `focus()` / `closeTrigger()` / `toDOMRange()` 等方法。

### 3.8 浏览器行为纠偏（contenteditable 的现实）

`contenteditable` 在不同浏览器下会自作主张地改 DOM 和选区，模型层看不见这些改动（模型没变 → Vue 不重渲染 → 破坏永久残留）。组件必须自愈：

- **零宽占位结构自愈**：空段落叶渲染为 `FEFF + <br>`（`<br>` 撑行高），inline 相邻的空叶只有 `FEFF`（光标停靠点）。Firefox 会在 Enter 的 `beforeinput` **之前**注入 `<br>` 并吞掉 `FEFF`（`preventDefault` 拦不住），组件在每次 `revision` 变化和 focus 后按不变式修复；除零宽 span 与插件自治区外，编辑区内不允许存在 `<br>`。
- **Enter 前的选区快照**：Firefox 在 `keydown` 与 `beforeinput` 之间会插一次 `selectionchange`，可能把选区挪到段首；`keydown` 时拍快照，`insertParagraph` 时用快照做 `splitBlock`。
- **选区读写用 anchor/focus，不用 `getRangeAt(0)`**：`start/end` 丢方向（反向拖选会被存成正向），且 Firefox 会把跨 `contenteditable=false` 内联的选区拆成多个 Range，第一段只覆盖 void 之前。写回同理用 `setBaseAndExtent`——`addRange` 只能表达正向选区。
- **拖选期间只读不写**：拖选中任何程序化写 DOM 选区都会重置浏览器的拖选锚点（Firefox 表现为选区闪烁 / 选不中）；`mouseup` 后补一次归一。原生 HTML5 拖拽不触发 `mouseup`，必须同时监听 `dragend`，否则拖一次徽章后标记永久卡住。
- **游离节点兜底**：点击空行、最后一行下方 padding 等位置时，Firefox 会把选区落在不属于任何叶的节点上。此时不能返回 `null`（那会让模型选区过期，下一次按键落回旧光标位置），要解析到文档顺序上最近的文本叶。
- **点击不抢光标**：`focus` 时不要把存储的模型选区写回 DOM——那会让光标弹回上次的位置（"点了某一行但光标不动"）。只有 DOM 选区不在编辑区内（程序式 `.focus()`）才恢复模型选区。
- **光标跟随滚动**：写回选区后按 focus 端插入点矩形滚动容器，模拟 `<textarea>` 的行为（量测 focus 端而非整段包围盒，否则反向拖选会把滚动条拉回选区尾部）。
- **渲染分支用 `<span v-if/v-else-if/v-else>`，不用 `<template v-if>`**：后者产生 Fragment VNode，Chrome 的 contenteditable 会删掉 Fragment 边界的空文本节点，Vue 卸载 Fragment 时读 `null.nextSibling` 直接崩。

### 3.9 演示页要求

`/richeditor` 需同时挂载四个插件，覆盖所有插件形态：

| 插件 | 触发 | 文本语法 |
|---|---|---|
| `mention` | `@` | `@[Name](id)` |
| `ref` | 无 | `{{Ref N}}` |
| `camera` | 无 | `{{Camera}}` |
| `inline-code` | 无 | `` `code` ``（块内可编辑） |

页面右侧同步展示 `v-model` 的原始字符串，直观呈现 round-trip 结果。

## 4. 开发强约束

1. 写操作前必须校验 path，越界直接 `return`，不抛错。
2. 内容提交必须走 normalization 入口，禁止裸赋值 `editor.children`。
3. 插件渲染的节点**必须**把插槽的 `attributes` 展开到根元素，否则 DOM ↔ 模型选区桥接失效。
4. `inline.type` 一经发布不得变更（影响历史文本的兼容性）。
5. 任何新增导出都要写 JSDoc 并同步更新 `API.md`。

## 5. 验收标准

- [ ] 输入 `@` 弹出候选，上下键选择、Enter 提交后生成 mention 节点；`v-model` 字符串同步变成 `@[Name](id)`。
- [ ] 直接往 `v-model` 里写 `{{Ref 3}}`，编辑区渲染成对应节点；再取回字符串与写入值一致。
- [ ] 点进行内代码块编辑，`v-model` 中的 `` ` ` `` 内容同步更新；块内按 Enter 不产生换行。
- [ ] 光标停在行内代码块左边界按左方向键，一次跳到块前而不是进入块内。
- [ ] 粘贴一段含多个标记的长文本，一次 `Ctrl+Z` 全部撤销。
- [ ] 连续移动光标不产生任何撤销记录。
- [ ] 设置 `maxLength` 后超限输入被拦截并触发 `exceed-limit`。
- [ ] 单测覆盖 `serialize` 的 round-trip 与 `operations` 的 transform / undo / batch / muteHistory。
- [ ] 按 Enter 换行后光标可见、空行有正常行高；Firefox 下同样成立。
- [ ] 点击任意一行（含空行、最后一行下方的空白）光标落到点击处，而不是弹回上次位置。
- [ ] 反向拖选、跨行拖选、跨内联节点拖选都能选中且不闪烁；拖动一次内联节点徽章后，后续编辑的光标同步仍正常。
- [ ] 粘贴多行文本得到多个段落块，其结构与逐行手敲 Enter 完全一致，且一次 `Ctrl+Z` 全部撤销。

## 6. 本期不做

- 块级富文本：标题、列表、引用、表格、代码块（块级）。
- 行内样式的 UI（`bold`/`italic`/`code`/`underline` 类型已在模型中预留，但没有工具栏和快捷键）。
- 协同编辑（可与 [REQ-COLLAB](04-realtime-collab.md) 结合，但不在本期）。
- 拖拽排序节点、图片 / 附件上传。
- 输入法（IME）组合输入的深度优化。
- 移动端触屏选区。

## 7. 待确认事项

- 是否抽成独立 npm 包发布。
- ~~多段落场景下的 `\n\n` 约定是否会与实际业务文本冲突~~ —— 已改为「一个 `\n` = 一个段落块」，见 §3.6。
- 是否需要提供一套默认样式主题，减少每个宿主重复写渲染插槽。
