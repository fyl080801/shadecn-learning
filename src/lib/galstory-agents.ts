import type { AgentKind, OutputForm } from "@/types/galstory"

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
  content_normalization: { label: "建档归一化", purpose: "归一化角色描述与开场白，带落盘体检门" }
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
