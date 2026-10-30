import { StringEnum, Type } from '@mariozechner/pi-ai'
import type { CanvasTool } from '../tools.ts'
import { DEFAULT_SANDBOX_COMMANDS } from './local.ts'
import type { Sandbox } from './types.ts'

/**
 * 让模型在沙箱里跑 ffmpeg / ffprobe 的工具。
 *
 * **默认不暴露**：它属于技能 `media-exec`（`skills/media/`，按需加载），只有宿主开了它（apps/server 里是 `AGENT_SANDBOX_EXEC=1`）、
 * 且 Grant 里有 `sandbox:exec` 时才提供这个技能。
 * 二期起它在 **runner 里本地执行**（runner 就是沙箱，命令跑在这一轮自己的工作目录里，`openLocalSandbox`），
 * 不经网关（docs/22 §3：沙箱内部动作）；服务端只拿它的定义给事件里的那句话（`describe`）。
 * 本期它只能处理工作目录里已有的文件（run 开始时写进去的 `canvas.json`、它自己产出的文件）——
 * 资源存储（`assetId`，docs/20 §3.6）还不存在，产物也还挂不到节点上。
 */

/** 媒体工具的名字：它在 runner 里本地执行，网关不代它执行 */
export const MEDIA_TOOL_NAME = 'run_media_command'

export const MEDIA_TOOL_LIMITS = {
  timeoutMs: 60_000,
  maxOutputBytes: 64 * 1024,
  maxArgs: 64,
  maxArgLength: 1000,
  /** 回给模型的输出再截一道：64KB 的 ffmpeg 日志对模型毫无用处，只烧 token */
  replyChars: 4000,
} as const

const mediaParams = Type.Object(
  {
    command: StringEnum(DEFAULT_SANDBOX_COMMANDS, { description: '要跑的命令' }),
    args: Type.Array(Type.String({ maxLength: MEDIA_TOOL_LIMITS.maxArgLength }), {
      maxItems: MEDIA_TOOL_LIMITS.maxArgs,
      description: '参数列表（不经 shell）；文件一律写工作目录内的相对路径',
    }),
  },
  { additionalProperties: false },
)

function tail(text: string): string {
  return text.length > MEDIA_TOOL_LIMITS.replyChars
    ? `…（前面省略 ${text.length - MEDIA_TOOL_LIMITS.replyChars} 字）${text.slice(-MEDIA_TOOL_LIMITS.replyChars)}`
    : text
}

export function createMediaTool(sandbox: Sandbox): CanvasTool {
  const tool: CanvasTool<typeof mediaParams> = {
    name: MEDIA_TOOL_NAME,
    capability: 'sandbox:exec',
    execution: 'runner',
    label: '媒体处理',
    description:
      '在隔离的工作目录里运行 ffmpeg 或 ffprobe（不经 shell，没有网络访问权限的假设，不能读工作目录外的文件）。' +
      '工作目录里有一份 canvas.json（本轮开始时的画布快照）。返回退出码和输出尾部。',
    parameters: mediaParams,
    executionMode: 'sequential',
    describe: (args) => `运行 ${args.command}`,
    async execute(_id, args, signal) {
      if (signal?.aborted) throw new Error('已中止')
      // 一轮被中止（用户停止 / 失权 / 超时）时 pi 掐掉这个 signal：沙箱当场 SIGKILL 子进程，不等它跑完
      const run = await sandbox.exec(args.command, args.args, {
        timeoutMs: MEDIA_TOOL_LIMITS.timeoutMs,
        maxOutputBytes: MEDIA_TOOL_LIMITS.maxOutputBytes,
        ...(signal ? { signal } : {}),
      })
      if (run.aborted) throw new Error(`${args.command} 随这一轮中止，已强制结束`)
      if (run.timedOut) throw new Error(`${args.command} 超过 ${MEDIA_TOOL_LIMITS.timeoutMs / 1000} 秒，已强制结束`)
      const reply = {
        exitCode: run.exitCode,
        ...(run.signal ? { signal: run.signal } : {}),
        stdout: tail(run.stdout),
        stderr: tail(run.stderr),
        ...(run.truncated ? { truncated: true } : {}),
      }
      if (run.exitCode !== 0) throw new Error(`${args.command} 退出码 ${run.exitCode}：${JSON.stringify(reply)}`)
      return {
        content: [{ type: 'text', text: JSON.stringify(reply) }],
        details: { summary: `运行 ${args.command}（退出码 0）`, elementIds: [] },
      }
    },
  }
  return tool as unknown as CanvasTool
}
