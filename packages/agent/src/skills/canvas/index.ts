import { createCanvasBaseTools, TOOL_LIMITS } from '../../tools.ts'
import { defineSkill } from '../registry.ts'

/**
 * 画布的基础技能 `canvas`（docs/23 §4）：读、内容、连线、删除、布局，共 13 个工具。`always` ——
 * 几乎每一轮都要读写画布，按需加载只会多一次往返。
 *
 * 原先拆成只读的 `canvas` 和写结构的 `canvas-edit`，是为了节点范围会话的画布只读；节点范围会话取消后
 * （docs/20 §3.10.9）合成这一个。会话记住的旧 id `canvas-edit` 读出时按 `canvas` 处理（`@shadecn/shared/agent` 的 `canonicalSkillIds`）。
 *
 * **只要 `flow:read` 就提供**（`offeredWith`）：Grant 里缺 `flow:write` / `flow:delete` 时照样能读，写工具在网关逐个判权时被拒。
 * `requires` 仍是全部工具能力的并集（注册表校验它覆盖每个工具的 `capability`）。
 *
 * 工具实现在 `tools.ts`（一次调用一个 Y 事务、写只走 `flow-ops`），这里只把它们配上提示段。
 */

export const canvasSkill = defineSkill({
  id: 'canvas',
  title: '画布',
  summary: '读写画布：读取节点与连线、新建 / 修改 / 复制节点、连线、删除、移动、改尺寸、分组、自动布局',
  prompt: `- 画布上有节点和连线。节点有 id、类型和四组字段：layout（坐标、所属分组）、metadata（名字 label、说明）、data（业务字段，例如 text 节点的正文 data.text、生成类节点的 data.prompt）、runtime（运行状态和各输出端口的产出，只读）。inputs 是连进这个节点的线，按端口和序号排好，只读。
- 节点类型：text = 文本（正文 data.text）；image = 图片（素材地址 data.src）；video = 视频（素材地址 data.src、预览图 data.poster）；director = 导演台（3D 场景与动画存在 data 的 dc.* 字段里，这里只给摘要；读写导演台内容用 director 技能）；还可能有 group（分组框）和认不出类型的老节点。端口和数据类型见 read_canvas 的 nodeTypes。
- 读：read_canvas 读取全部内容；get_node 只读一个节点（只关心一个节点时用它，别为一个节点读整张画布）；check_connection 只检查两个节点能不能连、会连哪对端口，不写。
- 要用到某个节点的 id、端口之前，先用 read_canvas 拿到真实的值；工具报「不存在」时重新读取再决定。
- 你能新建的类型只有四种：text、image（素材地址 data.src 只能在 add_node 时给）、video、director（新建的导演台是空场景；导演台内容用 director 技能，update_node / add_node 不能写 data 里的 dc.* 字段）。group 和认不出类型的老节点可以读、改名、连线、删除，但不能新建。
- 内容：add_node 新建节点（可顺带从已有节点连过来）；update_node 修改节点的 metadata 或 data；duplicate_node 复制一个节点（不带连线、不带产出）。
- 连线与删除：connect 连线（端口自动选，也可以用 sourcePort / targetPort 指定）；delete_elements 删除节点或连线。
- 布局：move_nodes 挪位置；resize_node 改宽高；group_nodes 把几个顶层节点圈进一个新分组；ungroup 解散分组（组员留在原地）；auto_layout 按连线从左到右整体重排。

规则：
1. 修改、连线、删除之前，先用 read_canvas 拿到真实的 id，不要编造。
2. 用户要求改某个被 \`@\` 提及的节点的内容时，用 update_node 改那个 id，不要新建一个节点代替。
3. 只改用户要求的部分。update_node 只传要改的字段。
4. 连线要端口类型兼容（图片连图片、文本连文本）。text 只能连出去、不能被连入；image / video 都能被连入（带着素材的「素材」形态节点被连入后会自动变回「生成」形态，data.form 由画布维护，不要自己写）；同一个上游、同一对端口不连第二条；一般不用指定端口，工具会按声明顺序自动选，需要连到特定端口时先 read_canvas 看 nodeTypes 再用 sourcePort / targetPort 指定。
5. 删除要克制：一轮最多删 ${TOOL_LIMITS.deletePerRun} 个元素（ungroup 拆掉的分组框也算一个），超出会被拒绝；大规模删除请让用户自己操作。
6. 布局：新建了一批节点并连好线后，用一次 auto_layout 收拾版面，不要逐个 move_nodes；用户没要求时不要重排已有的画布。组内节点的坐标相对它所在的分组框；分组不能嵌套，已在分组里的节点要先 ungroup 才能圈进新分组。`,
  tools: (ctx) => createCanvasBaseTools(ctx),
  requires: ['flow:read', 'flow:write', 'flow:delete'],
  offeredWith: ['flow:read'],
  activation: 'always',
})
