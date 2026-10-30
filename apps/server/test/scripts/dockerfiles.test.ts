import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 三个 Dockerfile 的架构护栏（docs/12 §2.5.1）和 CI 的取产物方式（ci/workflow-template.yaml）。
 * 护栏是事故换来的，而且「构建成功」证明不了架构对：单架构 tag + QEMU 会让拉错架构完全不报错。
 * CI 现在用的是根 Dockerfile 的 `artifacts` 阶段 + 产物里的 output/Dockerfile + 沙箱的 Dockerfile，
 * 所以三份都得带齐 —— output-image 那份以前就漏过 TARGETARCH 检查。
 */

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8')

/** 按 FROM 切阶段：[FROM 那一行, 阶段的全文] */
function stages(dockerfile: string): { from: string; body: string }[] {
  const lines = dockerfile.split('\n')
  const result: { from: string; body: string }[] = []
  for (const line of lines) {
    if (/^FROM\s/.test(line)) result.push({ from: line, body: '' })
    else if (result.length > 0) result.at(-1)!.body += `${line}\n`
  }
  return result
}

const ARCH_CHECK = /ARG TARGETARCH\nRUN set -e; \\\n\s+have=\$\(node -p "process\.arch === 'x64' \? 'amd64' : process\.arch"\); \\\n\s+if \[ -n "\$\{TARGETARCH\}" \] && \[ "\$\{TARGETARCH\}" != "\$have" \]; then/

describe('Dockerfile 的架构护栏', () => {
  it('每个 FROM 都用同一个 ${NODE_IMAGE}（多架构引用走构建参数）；用到 node 的阶段除了只跑在构建机上的 build，都比对 TARGETARCH', () => {
    for (const file of ['Dockerfile', 'apps/server/scripts/output-image/Dockerfile', 'apps/server/scripts/agent-sandbox/Dockerfile']) {
      const all = stages(read(file))
      const nodeStages = all.filter((stage) => !/^FROM scratch/.test(stage.from))
      expect(nodeStages.length, file).toBeGreaterThan(0)
      for (const stage of nodeStages) {
        expect(stage.from, file).toMatch(/^FROM (--platform=\$BUILDPLATFORM )?\$\{NODE_IMAGE\}( AS [a-z-]+)?$/)
        // build 阶段是 $BUILDPLATFORM，产物与架构无关，不在这里比对
        if (!stage.from.includes('$BUILDPLATFORM')) expect(stage.body, `${file}: ${stage.from}`).toMatch(ARCH_CHECK)
      }
    }
  })

  it('两份应用镜像的运行时阶段都真的加载原生模块（better-sqlite3 开库 + 其余 dlopen）', () => {
    for (const file of ['Dockerfile', 'apps/server/scripts/output-image/Dockerfile']) {
      const runtime = stages(read(file)).at(-1)!
      expect(runtime.body, file).toContain(`new (require('better-sqlite3'))(':memory:').prepare('select 1').get()`)
      expect(runtime.body, file).toContain('process.dlopen')
    }
  })

  it('根 Dockerfile：沙箱的构建上下文不进应用镜像；artifacts 阶段把 output/ 和沙箱上下文一起导出给 CI（最后一个阶段仍是应用镜像）', () => {
    const root = read('Dockerfile')
    expect(root).toContain('RUN pnpm build && mv output/agent-sandbox /app/agent-sandbox')
    const all = stages(root)
    const artifacts = all.find((stage) => stage.from === 'FROM scratch AS artifacts')!
    expect(artifacts.body).toContain('COPY --from=build /app/output /output')
    expect(artifacts.body).toContain('COPY --from=build /app/agent-sandbox /agent-sandbox')
    expect(all.at(-1)!.body).toContain('COPY --from=build /app/output ./')
    expect(all.at(-1)!.body).toContain('CMD ["sh", "-c", "node server/db-sync.js && exec node server/index.js"]')

    const template = read('ci/workflow-template.yaml')
    expect(template).toContain('--target artifacts')
    expect(template).toContain('--output type=local,dest=${ARTIFACTS}')
    expect(template).toContain('build_image ${PLATFORM} ${APP_INTERNAL} ${ARTIFACTS}/output')
    expect(template).toContain('build_image ${PLATFORM} ${SANDBOX_INTERNAL} ${ARTIFACTS}/agent-sandbox')
    // 每个构建都传同一个基础镜像参数
    expect(template.match(/--build-arg NODE_IMAGE=\$\{BASE_IMAGE\}/g)).toHaveLength(2)
  })
})
