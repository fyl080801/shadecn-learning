import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 镜像的护栏。`apps/server/test/scripts/dockerfiles.test.ts` 只认那三份 Dockerfile，这一份的护栏和 agent-sandbox 那份同样要带齐：
 * 架构比对是事故换来的（docs/12 §2.5.1），`FROM scratch` 决定了容器环境里只有 PATH，基础镜像不写死代理地址。
 */
const appDir = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(appDir, '../..')
const dockerfile = readFileSync(path.join(appDir, 'Dockerfile'), 'utf8')

/** 按 FROM 切阶段：[FROM 那一行, 阶段的全文] */
function stages(text: string): { from: string; body: string }[] {
  const result: { from: string; body: string }[] = []
  for (const line of text.split('\n')) {
    if (/^FROM\s/.test(line)) result.push({ from: line, body: '' })
    else if (result.length > 0) result.at(-1)!.body += `${line}\n`
  }
  return result
}

const ARCH_CHECK = /ARG TARGETARCH\nRUN set -e; \\\n\s+have=\$\(node -p "process\.arch === 'x64' \? 'amd64' : process\.arch"\); \\\n\s+if \[ -n "\$\{TARGETARCH\}" \] && \[ "\$\{TARGETARCH\}" != "\$have" \]; then/

describe('runner 镜像的 Dockerfile', () => {
  it('基础镜像走构建参数，默认是上游官方的引用，不写死任何代理', () => {
    expect(dockerfile).toContain('ARG NODE_IMAGE=docker.io/library/node:22-alpine\n')
    expect(dockerfile).not.toMatch(/harbor|192\.168\./)
  })

  it('每个用到 node 的阶段都是同一个 ${NODE_IMAGE}，并比对 TARGETARCH', () => {
    const nodeStages = stages(dockerfile).filter((stage) => !/^FROM scratch/.test(stage.from))
    expect(nodeStages.map((stage) => stage.from)).toEqual(['FROM ${NODE_IMAGE} AS deps', 'FROM ${NODE_IMAGE} AS rootfs'])
    for (const stage of nodeStages) expect(stage.body, stage.from).toMatch(ARCH_CHECK)
  })

  it('最后一个阶段是 FROM scratch，镜像配置里只有 PATH：基础镜像的 NODE_VERSION / YARN_VERSION 不进沙箱环境，也不能加别的变量', () => {
    const last = stages(dockerfile).at(-1)!
    expect(last.from).toBe('FROM scratch')
    expect(last.body).toContain('COPY --from=rootfs / /\n')
    expect([...last.body.matchAll(/^ENV\s+(\S+?)=/gm)].map((match) => match[1])).toEqual(['PATH'])
    expect(last.body).toContain('USER 10001:10001\n')
    expect(last.body).toContain('ENTRYPOINT ["node", "/sandbox/runner/agent-runner.js"]\n')
  })

  it('镜像带 managed 标签，不带 instance：实例标识只由驱动打在容器上，写在镜像上 reap 会认错', () => {
    expect(dockerfile).toContain('shadecn.agent/managed="true"')
    expect(dockerfile).not.toContain('shadecn.agent/instance')
  })

  it('依赖安装不跑脚本；npm 下载地址可选，默认官方源；ARG 声明在安装命令之前', () => {
    const deps = stages(dockerfile).find((stage) => stage.from.endsWith('AS deps'))!
    const install = deps.body.split('\n').find((line) => /^RUN npm install\b/.test(line))!
    expect(install).toContain('--omit=dev --ignore-scripts')
    expect(install).toContain('${NPM_REGISTRY:+--registry=${NPM_REGISTRY}}')
    expect(deps.body.indexOf('ARG NPM_REGISTRY=\n')).toBeGreaterThan(-1)
    expect(deps.body.indexOf('ARG NPM_REGISTRY=\n')).toBeLessThan(deps.body.indexOf(install))
  })

  it('构建期自检：runner 没有环境变量时必须以 2 退出（1 = 缺包）', () => {
    expect(dockerfile).toContain('node runner/agent-runner.js > /tmp/selfcheck.log')
    expect(dockerfile).toContain('if [ "$code" != 2 ]')
  })
})

describe('接线', () => {
  it('根 Dockerfile 在 install 之前 COPY 这个包的 package.json', () => {
    const root = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')
    const line = root.indexOf('COPY apps/agent-runner/package.json ./apps/agent-runner/\n')
    expect(line).toBeGreaterThan(-1)
    expect(line).toBeLessThan(root.indexOf('RUN pnpm install --frozen-lockfile'))
  })

  it('根 .dockerignore 排除构建上下文和测试', () => {
    const ignored = readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8').split('\n')
    expect(ignored).toContain('apps/agent-runner/dist')
    expect(ignored).toContain('apps/agent-runner/test')
  })

  it('构建上下文不进 output/：旧服务的 `docker build ./output` 只排除了 agent-sandbox', async () => {
    const { contextDir } = await import('../scripts/bundle-runner.mjs')
    expect(path.relative(repoRoot, contextDir)).toBe(path.join('apps', 'agent-runner', 'dist'))
  })
})
