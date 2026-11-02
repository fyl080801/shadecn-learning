/**
 * 构建标识：服务端（`apps/server/scripts/build-server.mjs`）和沙箱镜像里的 runner（`apps/agent-sandbox/scripts/bundle-runner.mjs`）
 * 各自用 esbuild 的 `define` 注入。`pnpm build` 经 `AGENT_BUILD_ID` 给两边同一个 id（一次构建 = 一个 id）；单独重建镜像就是另一个 id。
 * 源码运行（`pnpm dev` / 测试 / `tsx`）没有注入，就是 {@link SOURCE_BUILD_ID}。
 *
 * 它只用来**软提示**「沙箱镜像和服务端不是同一次构建」（网关打一条 warn，不拒绝）；真正拦截不兼容的是
 * `protocol.ts` 的 `RUNNER_PROTOCOL_VERSION`。本包不读 `process.env`，所以运行时走编译期注入（`AGENT_BUILD_ID` 只有构建脚本读）。
 */

/** esbuild `define` 注入的字符串字面量；没注入时这个标识符不存在（所以只能用 typeof 探测） */
declare const __AGENT_BUILD_ID__: string

/** 源码运行时的构建 id：和任何构建 id 都不算「不一致」 */
export const SOURCE_BUILD_ID = 'source'

export const BUILD_ID: string = typeof __AGENT_BUILD_ID__ === 'string' ? __AGENT_BUILD_ID__ : SOURCE_BUILD_ID

/** 双方都是构建产物、且不是同一次构建才算不一致（任何一方是 `source` 或没报都不提示） */
export function buildsDiffer(server: string, runner: string | null | undefined): boolean {
  return !!runner && runner !== SOURCE_BUILD_ID && server !== SOURCE_BUILD_ID && runner !== server
}
