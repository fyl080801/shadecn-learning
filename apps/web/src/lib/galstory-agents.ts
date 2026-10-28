import type { AgentKind, AgentRole, OutputForm } from "@/types/galstory"

/**
 * 环节的**中文显示名**。纯展示 —— 它是这份镜像里唯一还留在前端的东西。
 *
 * 曾经这里还镜像着每个环节的 `kind`/`output`/`mechanical`，那是错的：那几样是引擎的
 * **判据**（`config/agent_kinds.py` 的 `AGENT_NEEDS`），现在随 `GET /api/config` 的
 * `bindings[]` 一起下发。同一个判据两处声明，两份迟早漂 —— 而漂了不报错，只是矩阵上
 * 显示的分类与引擎实际按的那一套不是同一个。
 *
 * ⚠️ **表里没有的名字回落标识本身**（同引擎那条「解析不出就原样保留，绝不猜」）：
 * 引擎新增一个环节而这里忘了加，界面上出现的是一个英文名，不是一个错的中文名。
 */
interface AgentLabel {
  label: string
  /** 这一步在引擎里干什么（一句话） */
  purpose: string
}

const AGENT_LABELS: Record<string, AgentLabel> = {
  render_role: { label: "演员演出", purpose: "按导演给的 task 演绎自己这一步的言行" },
  render_scene: { label: "场景渲染", purpose: "环境、群体动作、时间推移 —— 不属于任何单个角色的呈现" },
  integrate: { label: "导演汇总", purpose: "把各角色的表演整合成玩家读到的那段叙事" },
  render_player: { label: "玩家步演绎", purpose: "把玩家选定/输入的行动意图演绎成这一步的呈现" },
  narrate_player: { label: "玩家步润色", purpose: "统一文风；玩家读到的其余每一段都出自导演那支笔" },
  plan: { label: "导演规划", purpose: "产出轮次卡 Beat —— 全项目最深的嵌套 schema" },
  propose_options: { label: "玩家选项", purpose: "给出意图粒度的选项（不写台词）" },
  world_bootstrap: { label: "建档生成", purpose: "新建存档时的初次印象与公开人物志" },
  judge_transition: { label: "转场判定", purpose: "只认 end_when 与自然收束，保守缺省不切" },
  summarize_for: { label: "知识归纳", purpose: "提交时按角色视角归纳落库，带 evidence 接地门" },
  update_relations: { label: "相识与称呼", purpose: "每轮更新 knows / call —— 玩家自报姓名要当轮生效" },
  digest_relations: { label: "心路历程", purpose: "跟提交触发器，一段情节长一条轨迹" },
  critique: { label: "输出核验", purpose: "判产出有没有违反机制约束；保守缺省，拿不准判通过" },
  digest_script: { label: "剧本摘要", purpose: "压缩历轮原件成 <summary>；走产出契约，载体自适应" },
  content_normalization: { label: "建档归一化", purpose: "归一化角色描述与开场白，带落盘体检门" },
  public_profiles: { label: "公开人物志", purpose: "给缺 public_ref 的角色一次全出：不认得他的人该怎么称呼他" },
  critique_impression: { label: "泄密判定", purpose: "判初次印象有没有说中人家的底牌；保守方向与 critic 相反，拿不准判泄露" },
  cognition: { label: "检索认知", purpose: "生成前的取料：按这一步的视角捞出该知道的事实、信念与对在场者的认知" }
}

/**
 * **是哪一位 agent** 的中文名。
 *
 * ⚠️ **全局就这四位**（导演 / 演员 / 场景 / 玩家，= 引擎自己那套 scope 词表）：认知检索、
 * 知识归纳、相识与称呼、心路历程**都不是另外几位**，它们是这四位各自的行为。按功能另立一类
 * 读起来就成了「旁边还有个记忆 agent 在记账」，而那几次调用本来就是按视角各跑一次的。
 *
 * 纯展示 —— 「哪个环节属于哪一位」由引擎随进度事件下发（`PipelineEvent.role`，判据在
 * `gal_server/progress.py` 的 `ROLES`，那里还有一条门钉着词表不许分家）。
 *
 * ⚠️ 表里没有的回落 key 本身（宁可露一个英文标识，也不猜一个中文说法）。
 */
const ROLE_LABELS: Record<string, string> = {
  world: "世界",
  director: "导演",
  actor: "演员",
  scene: "场景",
  player: "玩家",
  other: "其它"
}

/** 一句话说清这一位干什么 —— 配置页的组头与流水线的详情都用它 */
const ROLE_HINTS: Record<string, string> = {
  world: "开局把这个世界立起来：归一化设定、公开人物志、给每个人建初次印象、泄密判定。",
  director: "排这一轮的轮次卡、把各步演出汇总成叙事、判这一场收没收、压缩剧本线。",
  actor: "演出，以及这一位自己记东西的那几件事（知识归纳、相识与称呼、心路历程）。",
  scene: "环境、群体动作、时间推移 —— 不属于任何单个角色的呈现。",
  player: "演绎你的行动、给你下一步的选项，以及你自己的记忆。",
  other: "引擎新增了还没归位的环节 —— 照常显示，不猜它归谁。"
}

/**
 * 五位的显示顺序 —— **只是回落值**。
 *
 * ⚠️ 正经的顺序由引擎随 `/api/config` 给（`ModelConfig.roleOrder` ← `roster.AGENT_ROLE_IDS`）：
 * 「一轮里它们大致登场的顺序」是执行事实，不是渲染偏好。这里留一份是为了接口还没答复、
 * 或旧服务端没给这一格时页面仍排得出来 —— **别把它当真相源**。
 */
export const AGENT_ROLE_ORDER: AgentRole[] = ["world", "director", "actor", "scene", "player"]

export function roleLabel(key: string): string {
  return ROLE_LABELS[key] ?? key
}

export function roleHint(key: string): string {
  return ROLE_HINTS[key] ?? ""
}

/**
 * 流水线上一行的抬头：**这一位是谁**。
 *
 * `演员 · 林越` / `导演` / `场景`。名字是角色卡上的**真名** —— 那是引擎那侧 `cast_name` 的
 * 决定（运维面与正文是两个受众，判据写在 `agui._progress`），这里只负责摆出来。
 *
 * `role` 为空 = 还只有取料、正主没跑完，那就只报名字（有的话）。
 */
export function laneLabel(role: string, who: string): string {
  const head = role ? roleLabel(role) : ""
  if (head && who) return `${head} · ${who}`
  return head || who || "准备中"
}

export function agentLabel(name: string): string {
  return AGENT_LABELS[name]?.label ?? name
}

export function agentPurpose(name: string): string {
  return AGENT_LABELS[name]?.purpose ?? ""
}

export const AGENT_KIND_LABELS: Record<AgentKind, string> = {
  thinking: "值得思考",
  no_thinking: "不必思考"
}

/** 每一类的判据 —— 说清楚「为什么这几个环节归一类」，界面上要给出来 */
export const AGENT_KIND_HINTS: Record<AgentKind, string> = {
  thinking: "演出、汇总、规划、选项、建档 —— 创作型，思考对它们有帮助。",
  no_thinking:
    "判定与归纳，不是创作，不该为长链思考付钱 —— 实测输出 token 的 81% 是拿不到的思考。"
}

/**
 * 两类的显示顺序（引擎的 `BINDING_KEYS` 也是这个序）。
 *
 * ⚠️ 曾经是三类，中间那个 `creative_structured` 2026-08-23 随「引擎不再向端点索取结构化
 * 产出」一起取消 —— 它存在的全部理由就是「有些端点上思考 × 结构化互斥」。
 */
export const AGENT_KINDS: AgentKind[] = ["thinking", "no_thinking"]

/** 产出形状的中文名。**纯描述性** —— 它说的是产物长什么样，不是端点要会什么 */
export const OUTPUT_FORM_LABELS: Record<OutputForm, string> = {
  text: "自由文本",
  blocks: "重复块",
  contract: "分段取其一"
}

// ── 流水线的阶段 ────────────────────────────────────────────────────────────
//
// ⚠️ **「哪个环节属于哪个阶段」不在这里 —— 它由引擎随进度事件下发**（`progress.phase`，
// 判据在 `gal_server/progress.py` 的 `PHASES`）。那是**执行顺序**的事实（出处是引擎那张图），
// 不是渲染偏好；放在前端就是同一个判据两处声明 —— 引擎新增一个环节或改个名字，这边不会有
// 任何东西提醒，那个环节只是默默落进「其它」，界面照常渲染、分组悄悄错了。引擎那侧有一条门
// 钉着「每个环节都得有归属」。
//
// 这里只留**纯展示**的那一半：阶段的中文名与一句说明。阶段是个极小的闭集，且引擎给的是 key。

export interface PhaseLook {
  label: string
  /** 展开时显示的一句话 */
  hint: string
}

/** ⚠️ 表里没有的 key 回落成 key 本身（同 `agentLabel` 的取向：宁可露一个英文标识，也不猜） */
const PHASE_LOOK: Record<string, PhaseLook> = {
  bootstrap: {
    label: "建档",
    hint: "新建存档的一次性开销：归一化、公开人物志、每个视角的初次印象、泄密判定"
  },
  plan: { label: "导演规划", hint: "产出这一轮的轮次卡：谁在这一轮做什么、按什么顺序" },
  perform: {
    label: "逐步演出",
    hint: "导演排了几步就演几步 —— 下面每一条是一次角色或场景的演出"
  },
  player: { label: "玩家演绎", hint: "把你选定/输入的行动意图演绎成这一步的呈现 —— 这一轮的起点" },
  integrate: {
    label: "汇总与收束",
    hint: "把各步演出整合成玩家读到的那段叙事，再判这一场收没收"
  },
  options: { label: "玩家选项", hint: "给出意图粒度的下一步选项（不写台词，台词由玩家步演绎）" },
  writeback: {
    label: "知识写回",
    hint: "提交触发时才跑：按角色视角归纳落库、更新相识与心路历程、压缩剧本"
  },
  retrieve: {
    label: "认知检索",
    hint: "生成前的取料：按这一步的视角把该知道的世界事实、私有信念与对在场者的认知捞出来"
  },
  verify: { label: "输出核验", hint: "产出之后判有没有违反机制约束；保守缺省，拿不准判通过" },
  other: { label: "其它", hint: "引擎新增了还没归类的环节 —— 照常显示，不猜它属于哪一步" }
}

/**
 * 流水线上**一组**的抬头。
 *
 * ⚠️ 它与 `phaseLook(...).label` 是两个位置、两种说法，故分开写：那个是在详情面板上答
 * 「这一步排在哪一段」（`汇总与收束`），这个是瀑布流上一整块的名字，读起来该像**谁在干活**
 * （`导演` / `剧本演绎`）—— 同一个词在两个位置各有更好的说法时，硬共用一个只会两边都别扭。
 *
 * 分组本身仍是引擎给的（按 `phase`），这里只管怎么称呼它。
 */
const GROUP_TITLES: Record<string, string> = {
  bootstrap: "初始化",
  plan: "规划剧本",
  perform: "剧本演绎",
  integrate: "剧情汇总",
  // 玩家那一侧有两段（演绎他的行动 · 给他下一步的选项），中间隔着汇总，故不会并成一段；
  // 它们是同一件事的两次，用同一个抬头
  player: "玩家辅助",
  options: "玩家辅助",
  writeback: "知识写回"
}

/**
 * 一组的抬头 = **这一段在干什么**（阶段），而**谁在干**永远在下一层
 * （`初始化 › 世界 › …`、`规划剧本 › 导演 › …`）。
 *
 * ⚠️ **那一层从不折叠，哪怕只有一位**：折掉之后「谁在做」就没有固定的位置了 —— 有时在
 * 第二层、有时在第一层，读的人每次都要重新找。曾经为了少一层空转折过一次，换来的是
 * 「认知检索」「知识写回」这种**不是 agent 的东西**顶在了 agent 的位置上。
 *
 * ⚠️ 表里没有的回落空串，由渲染层退到那一位自己的名字 —— 宁可少说一句，也不猜。
 */
export function groupTitle(phase: string): string {
  return GROUP_TITLES[phase] ?? ""
}

export function phaseLook(key: string): PhaseLook {
  return PHASE_LOOK[key] ?? { label: key, hint: "" }
}
