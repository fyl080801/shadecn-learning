import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeRouteTable } from '@shadecn/server-kit/kernel'
import { routeRole, routeTable } from '../helpers/routes.ts'
import { parseYamlDocuments } from '../helpers/yaml.ts'

/**
 * 按角色拆分的 k8s 清单（`k8s/variants/roles/`，docs/28 §3.9）。
 * 钉住三件事：每个 Deployment 真的是它声称的那个角色、该带的带了不该带的没带；
 * Service 选得中对应的 Pod；ingress 的分流和服务端的路由归属表（`routes-table.ts`，入口声明推出的）是同一张表。
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
type Doc = Record<string, any>
const load = (file: string) => parseYamlDocuments(readFileSync(path.join(repoRoot, 'k8s/variants/roles', file), 'utf8')) as Doc[]

const deployments = Object.fromEntries(
  (['web', 'collab', 'agent'] as const).map((role) => [role, load(`deployment.${role}.yaml`)[0]!]),
) as Record<'web' | 'collab' | 'agent', Doc>
const services = load('service.yaml')
const ingress = load('ingress.yaml')[0]!
const hpa = load('hpa.collab.yaml')[0]!

const container = (doc: Doc) => doc.spec.template.spec.containers[0]
const envOf = (doc: Doc) => new Map<string, Doc>(container(doc).env.map((item: Doc) => [item.name, item]))

describe('k8s/variants/roles：三个 Deployment', () => {
  it.each(['web', 'collab', 'agent'] as const)('%s：SERVER_ROLES、标签、多副本前提、探针、退出宽限', (role) => {
    const doc = deployments[role]
    const env = envOf(doc)
    expect(env.get('SERVER_ROLES')?.value).toBe(role)
    // 拆角色必须是多副本模式 + PostgreSQL（单副本下服务端拒绝拆角色启动）
    expect(env.get('CLUSTER_MODE')?.value).toBe('redis')
    expect(env.get('DATABASE_PROVIDER')?.value).toBe('postgresql')
    expect(env.get('SERVER_INSTANCE_ID')?.valueFrom?.fieldRef?.fieldPath).toBe('metadata.name')
    // app 标签：沙箱 NetworkPolicy 按它放行回连；shadecn/role：Service 按它选
    expect(doc.spec.template.metadata.labels).toEqual({ app: 'shadecn-learning', 'shadecn/role': role })
    expect(doc.spec.selector.matchLabels).toEqual({ app: 'shadecn-learning', 'shadecn/role': role })
    expect(doc.spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64' })
    // 两个探针失败时该发生的事相反：liveness 保持浅
    expect(container(doc).livenessProbe.httpGet.path).toBe('/api/health')
    expect(container(doc).readinessProbe.httpGet.path).toBe('/api/health/ready')
    expect(doc.spec.template.spec.terminationGracePeriodSeconds).toBe(60)
    expect(container(doc).lifecycle.preStop.exec.command).toEqual(['sh', '-c', 'sleep 5'])
    // 模型配置只走带外的 envFrom，env 里写了会静默盖掉管理员配的（.claude/rules/deploy.md）
    for (const name of ['LLM_PROVIDERS', 'MODULES_AGENT_PROVIDER', 'MODULES_AGENT_MODEL', 'MODULES_AGENT_API_KEY', 'MODULES_AGENT_TOKEN_SECRET']) {
      expect(env.has(name)).toBe(false)
    }
    // 三种角色用同一份 agent / S3 配置（web 按它显示 agent 面板）
    const sources = container(doc).envFrom.map((item: Doc) => item.secretRef?.name ?? item.configMapRef?.name)
    expect(sources).toEqual(expect.arrayContaining(['shadecn-learning-auth', 'shadecn-learning-agent', 'shadecn-learning-s3']))
  })

  it('只有 agent 带沙箱的 SA 和环境变量（POD_IP 当网关地址）；web / collab 不能起 Pod', () => {
    expect(deployments.agent.spec.template.spec.serviceAccountName).toBe('shadecn-learning')
    const agentEnv = envOf(deployments.agent)
    expect(agentEnv.get('MODULES_AGENT_SANDBOX_DRIVER')?.value).toBe('k8s')
    expect(agentEnv.get('POD_IP')?.valueFrom?.fieldRef?.fieldPath).toBe('status.podIP')
    for (const role of ['web', 'collab'] as const) {
      expect(deployments[role].spec.template.spec.serviceAccountName).toBeUndefined()
      expect(envOf(deployments[role]).has('MODULES_AGENT_SANDBOX_DRIVER')).toBe(false)
    }
  })

  it('Service 只给 web 和 collab，选中的正是对应角色的 Pod；agent 不对外', () => {
    const selectors = Object.fromEntries(services.map((doc) => [doc.metadata.name, doc.spec.selector]))
    expect(selectors).toEqual({
      'shadecn-learning-web': { app: 'shadecn-learning', 'shadecn/role': 'web' },
      'shadecn-learning-collab': { app: 'shadecn-learning', 'shadecn/role': 'collab' },
    })
  })

  it('HPA 扩的是 collab', () => {
    expect(hpa.spec.scaleTargetRef.name).toBe(deployments.collab.metadata.name)
    expect(hpa.spec.minReplicas).toBeGreaterThanOrEqual(2)
  })
})

describe('k8s/variants/roles：ingress 分流 = 服务端的路由归属表', () => {
  const paths: { regex: RegExp; length: number; role: string }[] = ingress.spec.rules[0].http.paths.map((item: Doc) => ({
    // use-regex 下 ingress-nginx 生成 `location ~* "^<path>"`，并按路径长度从长到短排。
    // 正则来自仓库里自己写的清单，不是外部输入
    // eslint-disable-next-line security/detect-non-literal-regexp
    regex: new RegExp(`^${item.path}`, 'i'),
    length: item.path.length,
    role: String(item.backend.service.name).replace('shadecn-learning-', ''),
  }))
  paths.sort((a, b) => b.length - a.length)
  const ingressRole = (pathname: string) => paths.find((item) => item.regex.test(pathname))?.role

  it.each([
    '/ws/collaboration',
    '/api/collab/health',
    '/api/collab/rooms',
    '/api/flows/abc123/doc',
    '/api/flows/abc123/doc/',
    '/api/flows/abc123',
    '/api/flows/abc123/duplicate',
    '/api/flows/abc123/agent/messages',
    '/api/projects',
    '/api/auth/login',
    '/login',
    '/',
    '/assets/index.js',
  ])('%s', (pathname) => {
    expect(ingressRole(pathname)).toBe(routeRole(pathname))
  })

  it('每条不归 web 的入口声明（agent 网关除外）都在 ingress 里分到同一个角色：模块新加了入口，清单漏了就红', () => {
    for (const route of describeRouteTable(routeTable)) {
      if (route.role === 'agent') continue
      // 参数段代入一个样例 id；any（健康检查）在 ingress 上走 web
      const sample = route.path.replace(/:[^/]+/g, 'abc123')
      expect(ingressRole(sample), route.path).toBe(route.role === 'any' ? 'web' : route.role)
    }
  })

  it('agent 网关不经 ingress（沙箱直连 Pod IP）：落到 web，由服务端 404', () => {
    expect(ingressRole('/api/agent-gateway/run/redeem')).toBe('web')
    expect(routeRole('/api/agent-gateway/run/redeem')).toBe('agent')
  })
})
