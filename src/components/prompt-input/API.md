# PromptInput 组件 API / 方法规约

> 本文件用于指导基于 `prompt-input` 的二次开发与插件编写。  
> 内容与源码保持一一对应；新增/修改方法时**必须同步更新此文档**。  
> 组件仅依赖 Vue，无第三方富文本库（不依赖 Slate / ProseMirror / Tiptap）。

---

## 0. 模块拓扑

```
PromptInput.vue ──┬─→ operations.ts   (Editor/Transforms/createEditor 历史栈)
                  ├─→ definePlugin.ts (插件工厂 + 触发正则)
                  ├─→ selection.ts    (DOM ↔ Model 选区桥接)
                  ├─→ serialize.ts    (string ↔ Descendant[] 序列化)
                  └─→ types.ts        (所有公共类型定义)

characters.ts        (Demo 数据，可替换)
index.ts             (公共入口，仅 re-export)
```

依赖原则：**仅向同目录文件导入**，外部仅依赖 `vue`。

---

## 1. 核心数据模型（types.ts）

### 1.1 节点树

| 类型 | 形态 | 含义 |
|---|---|---|
| `BaseText` | `{ text: string }` | 文本叶最小形态 |
| `CustomText` | `BaseText & { bold?, italic?, code?, underline? }` | 带行内样式的文本叶 |
| `EmptyText` | `{ text: string }` | 占位文本叶（用于内联 void 的 `children`） |
| `CustomInline` | `{ type, data?, children: [EmptyText] }` | 插件渲染的内联 void 节点 |
| `Paragraph` | `{ type: 'paragraph', children: Array<CustomText \| CustomInline> }` | 段落块 |
| `Element` | `Paragraph \| CustomInline` | 含子节点的节点 |
| `Descendant` | `Element \| CustomText` | 文档顶层节点 |

### 1.2 选区

| 类型 | 形态 | 说明 |
|---|---|---|
| `Path` | `number[]` | 自根到节点的下标序列；文本叶路径长度为 2：`[blockIdx, inlineIdx]` |
| `Point` | `{ path: Path; offset: number }` | 仅落在文本叶内 |
| `Range` | `{ anchor: Point; focus: Point }` | 双端选区，可以反向 |

**不变量**（normalization 保证）：
1. 每个 `paragraph` 至少有一个 text leaf。
2. `paragraph` 的首/尾子节点恒为 text leaf。
3. 任意两个内联 void 之间必有 text leaf。
4. 相邻 text leaf 会被合并。
5. 光标只停在 text leaf 上。

### 1.3 Editor 接口

```ts
type Editor = {
  children: Descendant[]
  selection: Range | null
  revision: number                              // 每次 apply 自增，用于强制重渲染
  isInline: (node: Element) => boolean          // 由插件注册表动态填充
  isVoid:   (node: Element) => boolean
  insertText(text: string): void
  deleteBackward(unit?): void
  deleteForward(unit?): void
  apply(): void                                 // 提交并通知（含历史栈管理）
  undo(): void                                  // 回滚上一次"内容性"提交
  redo(): void                                  // 重做
  batch(fn: () => void): void                   // 合并多个提交为一次 undo
  __plugins?: Map<string, PromptPlugin>         // 内部注册表（外部只读）
}
```

> 关键约定：`Transforms.select` 等**仅改 selection** 的提交**不**单独入历史栈，它会随下一次内容提交合并。

### 1.4 插件接口

```ts
interface PromptPlugin {
  name: string                                  // 唯一名；路由 element:<name> / portal:<name>
  trigger?: { key: string; pattern?: RegExp }   // 触发字符；缺省正则 ^{key}(\S*)$
  inline?: { type?: string; isVoid?: boolean; isInline?: boolean }  // 默认 type=name, void=true, inline=true
  commit?(editor, { range, data }): void        // 缺省：替换 range 为 createInline(type, data)
  onKeyDown?(event, ctx): boolean               // 拦截 popover 激活时的键盘
  parse?(text): ParsedSegment[]                 // text → 片段（用于 v-model→model 反序列化）
  serialize?(node): string                      // node → text（用于 model→v-model 序列化）
}

type ParsedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'node'; type: string; data?: unknown }
```

**优先级规则**：`parse` 与 `serialize` 均按**注册的逆序**执行——后注册者优先认领文本/序列化输出。

---

## 2. PromptInput.vue 对外契约

### 2.1 Props

| 名称 | 类型 | 默认 | 必填 | 说明 |
|---|---|---|---|---|
| `editor` | `Editor` | — | ✅ | 由 `createEditor()` 创建的实例 |
| `modelValue` | `string` | `""` | ❌ | v-model 双向绑定的**纯字符串**；插件决定如何 round-trip |
| `placeholder` | `string` | `"输入触发字符（如 @）打开菜单…"` | ❌ | 文档为空时显示 |

### 2.2 Emits

| 事件 | 载荷 | 触发时机 |
|---|---|---|
| `update:modelValue` | `value: string` | 任何内容性提交后 |
| `change` | `value: string` | 同上（语义副本，便于 `@change` 监听） |
| `keydown` | `event: KeyboardEvent` | 键盘事件冒出（已先经插件 `onKeyDown` 拦截） |
| `select` | `range: Range \| null` | 选区或光标变化 |
| `focus` | — | 编辑区获得焦点 |
| `blur` | — | 编辑区失去焦点 |
| `trigger-open` | `ctx: TriggerContext` | 触发字符首次出现，popover 打开 |
| `trigger-search` | `ctx: TriggerContext` | popover 已开时搜索词变化 |
| `trigger-close` | — | popover 关闭（提交、Esc、失焦等任何原因） |

### 2.3 Slots

| 名称 | Scope | 用途 |
|---|---|---|
| `#element:<plugin.name>` | `{ element: CustomInline; attributes: Record<string, unknown> }` | 渲染该插件类型的内联节点（**必须**展开 `attributes` 到根元素） |
| `#element` | `{ element, attributes }` | 兜底渲染：未匹配任何 `element:<name>` 时使用 |
| `#portal:<plugin.name>` | `{ trigger: TriggerContext; commit: (payload) => void; close: () => void; editor: Editor }` | 触发器 popover 内容（菜单、列表等） |

### 2.4 Expose（通过 `ref` 访问）

| 方法 | 签名 | 说明 |
|---|---|---|
| `editor` | `Editor` | 原始 editor 引用 |
| `toDOMRange(range)` | `(range: Range) => DOMRange \| null` | 把 model range 转为 DOM Range |
| `closeTrigger()` | `() => void` | 主动关闭当前 popover |
| `getSelectedText()` | `() => string` | 选区对应的**真实字符串**（经 `plugin.serialize` 还原）；折叠时返回 `""` |
| `getFullText()` | `() => string` | 整篇文档的真实字符串，等价于 `modelValue` |

---

## 3. operations.ts —— Editor / Transforms 命名空间

### 3.1 Path / Point / Range 工具

| 函数 | 签名 | 用途 |
|---|---|---|
| `pathsEqual` | `(a: Path, b: Path) => boolean` | 路径相等 |
| `pointsEqual` | `(a: Point, b: Point) => boolean` | 位置相等 |
| `comparePoints` | `(a: Point, b: Point) => -1\|0\|1` | 文档序比较 |
| `RangeEdges` | `(range: Range) => [start, end]` | 把可能反向的 range 标准化 |
| `RangeIsCollapsed` | `(range: Range \| null) => boolean` | 是否光标 |
| `RangeCreate` | `(anchor, focus?) => Range` | 构造 range；focus 缺省=anchor |
| `Range` | namespace `{ edges, isCollapsed, create }` | 上述三者的别名集合 |

### 3.2 Editor namespace（只读查询）

| 方法 | 签名 | 用途 |
|---|---|---|
| `Editor.string(editor, range)` | `(Editor, Range) => string` | 取 range 内的字符串（仅同一文本叶内有效） |
| `Editor.before(editor, point, { unit })` | — | 前一位置；`unit` 可为 `'offset' \| 'character' \| 'word' \| 'line' \| 'block'` |
| `Editor.after(editor, point)` | — | 后一位置 |
| `Editor.range(editor, anchor, focus?)` | — | 构造 range |
| `Editor.isCollapsed(editor, range?)` | — | range 缺省取 `editor.selection` |
| `Editor.unhangRange(editor, range)` | — | 占位实现：直接返回原 range |

### 3.3 Transforms namespace（写操作，自动触发 `apply()`）

| 方法 | 签名 | 行为 |
|---|---|---|
| `Transforms.select` | `(editor, range \| null)` | 仅改 selection，不入独立历史 |
| `Transforms.insertNodes` | `(editor, Descendant \| Descendant[])` | 在光标处插入；若 range 非折叠会先删除 |
| `Transforms.move` | `(editor, { reverse? })` | 光标前/后移一格 |
| `Transforms.delete` | `(editor, { reverse? = true })` | 默认向后删除（Backspace 语义） |
| `Transforms.insertText` | `(editor, text)` | 插入纯文本（不解释换行） |
| `Transforms.insertFragmentText` | `(editor, text)` | 插入多行文本，`\n` → 分块 |
| `Transforms.splitBlock` | `(editor)` | 在光标处分裂段落 |

### 3.4 工厂

| 函数 | 签名 | 说明 |
|---|---|---|
| `createEditor` | `(options?: { plugins?: PromptPlugin[] }) => CreateEditorResult` | 创建响应式 editor |
| `CreateEditorResult` | `{ editor, addPlugin, removePlugin, getPlugins }` | 解构使用 |
| `initializeEditor` | `(editor, initialValue: Descendant[]) => void` | 写入初值并把光标放到末尾 |
| `createText` | `(text, marks?: Partial<CustomText>) => CustomText` | 构造文本叶 |
| `createInline` | `(type, data?) => CustomInline` | 构造内联 void 节点 |
| `createParagraph` | `(children) => Paragraph` | 构造段落 |

**历史栈语义**：
- 默认 100 条上限（`HISTORY_LIMIT`）。
- `apply()` 在 `children` 引用变化时入栈。
- `batch(fn)` 内的多次 `apply` 合并为一条历史；可重入（嵌套合并到最外层）。
- `undo/redo` 通过 `historyMuted` 防止重入入栈。

---

## 4. definePlugin.ts

| 导出 | 签名 | 说明 |
|---|---|---|
| `definePlugin` | `(plugin: PromptPlugin) => PromptPlugin` | 标识函数 + 默认值填充（`inline.type=name`，`isVoid/isInline=true`，缺省 `commit` = `select → insertNodes(createInline) → move`） |
| `defaultTriggerPattern` | `(key: string) => RegExp` | 生成 `^{escape(key)}(\S*)$` |
| `getTriggerPattern` | `(plugin) => RegExp \| null` | 没有 `trigger` 时返回 null |

### 插件最简写法

```ts
const mention = definePlugin({
  name: 'mention',
  trigger: { key: '@' },
  parse: (text) => splitByRegex(text, /@\[([^\]]+)\]\(([^)]+)\)/g,
    (m) => ({ kind: 'node', type: 'mention', data: { id: m[2], label: m[1] } })),
  serialize: (node) => {
    const d = node.data as { id: string; label: string }
    return `@[${d.label}](${d.id})`
  }
})
```

---

## 5. selection.ts —— DOM 桥接

### 5.1 DOM 约定（写插件不要破坏）

```html
<div data-block-path="[bi]">
  <span data-slate-node="text">
    <span data-slate-leaf="true" data-leaf-path="[bi,ii]">
      <span data-slate-string="true">…</span>                <!-- 非空 -->
      <!-- 或 -->
      <span data-slate-zero-width="z|n" data-slate-length="0">FEFF</span>
    </span>
  </span>
  <span data-void-path="[bi,ii]" contenteditable="false">…</span>
</div>
```

### 5.2 导出函数

| 函数 | 签名 | 说明 |
|---|---|---|
| `findLeafElement` | `(root, path) => HTMLElement \| null` | 按 `data-leaf-path` 选择 |
| `findBlockElement` | `(root, path) => HTMLElement \| null` | 按 `data-block-path` 选择 |
| `toDOMPoint` | `(root, point) => { node, offset } \| null` | model point → DOM 锚点 |
| `toModelPoint` | `(root, node, offset) => Point \| null` | DOM 锚点 → model point；处理零宽填充与 void 元素 |
| `toDOMRange` | `(root, range) => DOMRange \| null` | model range → DOM Range |
| `applyDOMRange` | `(root, range) => void` | 把 model range 应用到 `window.getSelection()` |
| `readModelRange` | `(root) => Range \| null` | 读取浏览器当前选区并转 model |

> 自定义内联可加 `data-inline-editable` 标记声明"我自己处理输入"，外层引擎会跳过默认处理。

---

## 6. serialize.ts —— 字符串 ⇄ 模型

### 6.1 段落映射约定
- `\n\n` 分隔**段落**（产生新 `<paragraph>` 块）。
- 单个 `\n` 作为文本叶内的字符保留。

### 6.2 导出函数

| 函数 | 签名 | 说明 |
|---|---|---|
| `splitByRegex` | `(text, pattern, build) => ParsedSegment[]` | 写 plugin `parse` 的核心工具；**pattern 必须含 `g` flag**，否则抛错；自动处理零宽匹配死循环 |
| `textToModel` | `(text, plugins) => Descendant[]` | 字符串 → 文档；空串生成单空段落 |
| `modelToText` | `(children, plugins) => string` | 文档 → 字符串；缺序列化器时 `console.warn` 并丢弃节点 |
| `serializeRange` | `(children, range, plugins) => string` | 序列化选区为字符串；折叠选区返回 `""`；多段落用 `\n\n` 拼接 |

### 6.3 优先级
`parse` 与 `serialize` 都按**逆序遍历插件**：后注册者优先认领。

---

## 7. characters.ts

| 导出 | 说明 |
|---|---|
| `CHARACTERS: MentionItem[]` | Demo 数据（约 36 条） |
| `characterSource(search) => MentionItem[]` | 大小写不敏感的前缀过滤；可作为 `#portal:mention` 中的数据源 |

---

## 8. 开发规范（强约束）

1. **路径有效性**：所有写操作前应通过 `editor.selection`/`getText` 校验 path；越界直接 `return`，不抛错。
2. **immutable 提交**：所有 `editor.children` 修改必须替换为新数组（`map/slice/concat`），不得就地改 push/splice 后再赋值。
3. **normalization 必走**：内容性提交必须通过 `renormalizeAndCommit` 或 `commitChildren`，禁止裸赋值 `editor.children = …`。
4. **selection 漂移修复**：normalization 后 path 可能位移，使用 `{ blockIdx, textLeafIdx, offset }` 三元组定位文本叶并 clamp。
5. **历史栈纪律**：
   - 单次用户动作如果涉及多次 `apply`（如粘贴），必须用 `editor.batch(() => …)`。
   - `Transforms.select` 不要单独提交；它会随下一次内容提交合并。
6. **插件 API 稳定性**：
   - `inline.type` 一经发布禁止变更（影响序列化兼容）。
   - `parse/serialize` 必须互逆：`textToModel(modelToText(x))` 与 `x` 在文档结构上应等价。
7. **DOM 标记**：插件渲染节点**必须**展开 slot 的 `attributes`（含 `data-void-path`、`contenteditable="false"` 等）到根元素，否则 selection 桥失效。
8. **第三方依赖**：组件本体仅依赖 `vue`；新增方法**不得**引入新的运行时依赖。
9. **注释纪律**：任何新增导出都需配 JSDoc 并同步更新本文件对应小节。

---

## 9. 典型用法骨架

```vue
<script setup lang="ts">
import {
  PromptInput, createEditor, definePlugin, splitByRegex
} from '@/components/prompt-input'

const mention = definePlugin({
  name: 'mention',
  trigger: { key: '@' },
  parse: (text) => splitByRegex(text, /@\[([^\]]+)\]\(([^)]+)\)/g,
    (m) => ({ kind: 'node', type: 'mention', data: { id: m[2], label: m[1] } })),
  serialize: (n) => {
    const d = n.data as { id: string; label: string }
    return `@[${d.label}](${d.id})`
  }
})

const { editor } = createEditor({ plugins: [mention] })
const text = ref('hello @[Yoda](yoda)!')
</script>

<template>
  <PromptInput v-model="text" :editor="editor">
    <template #element:mention="{ element, attributes }">
      <span v-bind="attributes" class="mention">
        @{{ (element.data as any).label }}
      </span>
    </template>
    <template #portal:mention="{ trigger, commit, close }">
      <MentionList :search="trigger.search" @pick="(item) => commit({ data: item })" @cancel="close" />
    </template>
  </PromptInput>
</template>
```

---

## 10. 变更日志

| 日期 | 变更 | 责任人 |
|---|---|---|
| 2026-06-08 | 初版方法规约落档 | — |