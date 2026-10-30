import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  K8S_DEFAULT_NAMESPACE,
  K8S_PULL_POLICIES,
  k8sPodSpec,
  k8sPrivilegedPodSpec,
  k8sResources,
  parseK8sNodeSelector,
  type K8sDriverOptions,
  type SandboxSpec,
} from '@shadecn/agent/sandbox/drivers'
import { parseYamlDocuments } from '../helpers/yaml.ts'

/**
 * agent `k8s` 沙箱的清单（docs/22 §7.5）和驱动、CI 对得上，且守住几条安全底线。两种形态：
 *
 * - **当前（dev 形态）**：`k8s/agent-sandbox.yaml`（ArgoCD 同步：服务端 SA、dev 里的 Role / RoleBinding、只选沙箱 Pod 的
 *   NetworkPolicy）+ `k8s/variants/agent-sandbox-vap.yaml`（集群级 ValidatingAdmissionPolicy，人工 apply，替 dev 补上 Pod Security 的缺口）；
 * - **更强（独立命名空间形态）**：`k8s/variants/agent-sandbox.yaml`（Pod Security restricted + 配额）。
 *
 * VAP 的 CEL 在这里跑不了（不加依赖），所以下面 {@link RULES} 是一份**逐条等价的 TS 判定**：规则名就是 VAP 每条 message 开头的
 * `[规则名]`，两边的集合必须一致、每条 CEL 必须引用它对应的字段；驱动生成的 Pod、样例 allow.yaml 必须全部通过，
 * deny.yaml 的每一份必须恰好违反注解里写的那几条。真集群上的同一组样例由管理员 dry-run（样例文件头里的命令）。
 * 仓库不为测试加 YAML 依赖：用 `helpers/yaml.ts` 的子集解析器（解析不了就抛，不会静默放过）。
 */

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8')
const load = (file: string) => parseYamlDocuments(read(file)) as any[]

const synced = load('k8s/agent-sandbox.yaml')
const variant = load('k8s/variants/agent-sandbox.yaml')
const vapDocs = load('k8s/variants/agent-sandbox-vap.yaml')
const [allowPod] = load('k8s/variants/agent-sandbox-vap-samples/allow.yaml')
const denyPods = load('k8s/variants/agent-sandbox-vap-samples/deny.yaml')
const deployment = load('k8s/deployment.yaml').find((doc) => doc.kind === 'Deployment')
const clusterDeployment = load('k8s/variants/deployment.cluster.yaml').find((doc) => doc.kind === 'Deployment')

const ofKind = (docs: any[], kind: string, namespace?: string) =>
  docs.filter((doc) => doc.kind === kind && (namespace === undefined || doc.metadata.namespace === namespace))
const one = (docs: any[], kind: string, namespace?: string) => {
  const found = ofKind(docs, kind, namespace)
  expect(found, `${kind}${namespace ? ` in ${namespace}` : ''}`).toHaveLength(1)
  return found[0]
}

const serverNamespace = deployment.metadata.namespace as string
const podTemplate = deployment.spec.template
const serverContainer = podTemplate.spec.containers[0]
const serverPort = serverContainer.ports[0].containerPort as number
const serverEnv = Object.fromEntries((serverContainer.env as any[]).map((entry) => [entry.name, entry]))
const envValue = (name: string) => serverEnv[name]?.value as string | undefined
const serviceAccount = podTemplate.spec.serviceAccountName as string
const policy = one(vapDocs, 'ValidatingAdmissionPolicy')
const binding = one(vapDocs, 'ValidatingAdmissionPolicyBinding')

/** CI 模板的参数默认值（模板里有块标量，子集解析器不认，按文本取） */
function templateParam(name: string): string {
  const lines = read('ci/workflow-template.yaml').split('\n')
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  const value = at === -1 ? undefined : /^\s+value: (\S+)$/.exec(lines[at + 1] ?? '')?.[1]
  if (!value) throw new Error(`ci/workflow-template.yaml 里没有参数 ${name}`)
  return value
}
const occurrences = (text: string, needle: string) => text.split(needle).length - 1

/** 驱动按 k8s/deployment.yaml 里的 env 生成的沙箱 Pod（宿主 apps/server/agent/index.ts 也是这么拼的） */
function deployedOptions(): Pick<K8sDriverOptions, 'image' | 'instance' | 'namespace' | 'imagePullSecret' | 'imagePullPolicy' | 'nodeSelector'> {
  const nodeSelector = parseK8sNodeSelector(envValue('AGENT_SANDBOX_K8S_NODE_SELECTOR') ?? '')
  if (!nodeSelector.ok) throw new Error(nodeSelector.reason)
  return {
    image: envValue('AGENT_SANDBOX_IMAGE')!,
    instance: 'abcdef0123456789',
    namespace: envValue('AGENT_SANDBOX_K8S_NAMESPACE')!,
    imagePullSecret: envValue('AGENT_SANDBOX_K8S_PULL_SECRET')!,
    imagePullPolicy: envValue('AGENT_SANDBOX_K8S_PULL_POLICY') as K8sDriverOptions['imagePullPolicy'],
    nodeSelector: nodeSelector.value,
  }
}

const sandboxSpec: SandboxSpec = {
  runId: 'run_lq3x5k_ab12cd34',
  flowId: '2f0c6b8e-1d1a-4f63-9a52-2b8f1c2d3e4f',
  ownerId: 'u1',
  grantId: '9b2d7e4a-5c6f-4a3b-8d1e-0f2a3b4c5d6e',
  image: 'unused',
  // 宿主的默认资源（AGENT_SANDBOX_CPUS / _MEMORY_MIB / _DISK_MIB）+ 默认 10 分钟一轮 + 30 秒余量
  resources: { cpu: 1, memoryMiB: 512, pids: 128, diskMiB: 512, deadlineMs: 630_000 },
  gatewayUrl: 'http://10.2.3.4:3000/api/agent-gateway',
  credential: { kind: 'bootstrap', token: 'one-time' },
}
/** 启动自检 dry-run 的那一份（`check()` 里的 probe）：名字、资源、网关地址不同，安全字段一样 */
const selfcheckSpec: SandboxSpec = {
  ...sandboxSpec,
  runId: 'selfcheck',
  flowId: 'selfcheck',
  grantId: 'selfcheck',
  resources: { cpu: 1, memoryMiB: 512, pids: 128, diskMiB: 512, deadlineMs: 60_000 },
  gatewayUrl: 'http://dry-run.invalid/api/agent-gateway',
  credential: { kind: 'bootstrap', token: 'dry-run' },
}

// —— VAP 的等价判定 ——

/** VAP 的 [sandbox-image] 里那条正则（CEL 的 matches 是 RE2；这个写法在 RE2 和 JS 里含义相同） */
const SANDBOX_IMAGE = /^192[.]168[.]68[.]95:31443\/apps\/shadecn-agent-sandbox:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const SECCOMP_OK = ['RuntimeDefault', 'Localhost']

const containersOf = (pod: any) => (pod.spec.containers ?? []) as any[]
const sc = (container: any) => container.securityContext ?? {}
const podSc = (pod: any) => pod.spec.securityContext ?? {}
const everyContainer = (pod: any, check: (container: any) => boolean) => containersOf(pod).every(check)

/** 规则名 → CEL 里必须出现的片段（防止两边各改各的）+ 等价判定（对着准入看到的对象：通过 = true） */
const RULES: Record<string, { cel: string[]; check: (pod: any) => boolean }> = {
  'managed-label': { cel: ["'shadecn.agent/managed'", "== 'true'"], check: (pod) => pod.metadata.labels?.['shadecn.agent/managed'] === 'true' },
  'single-container': { cel: ['size(object.spec.containers) == 1'], check: (pod) => containersOf(pod).length === 1 },
  'no-init-containers': { cel: ['initContainers'], check: (pod) => (pod.spec.initContainers ?? []).length === 0 },
  'no-ephemeral-containers': { cel: ['ephemeralContainers'], check: (pod) => (pod.spec.ephemeralContainers ?? []).length === 0 },
  'sandbox-image': {
    cel: [`c.image.matches('${SANDBOX_IMAGE.source.replaceAll('\\/', '/')}')`],
    check: (pod) => everyContainer(pod, (c) => SANDBOX_IMAGE.test(c.image)),
  },
  'no-host-namespaces': {
    cel: ['hostNetwork', 'hostPID', 'hostIPC'],
    check: (pod) => !pod.spec.hostNetwork && !pod.spec.hostPID && !pod.spec.hostIPC,
  },
  'no-privileged': { cel: ['securityContext.privileged'], check: (pod) => everyContainer(pod, (c) => !sc(c).privileged) },
  'emptydir-only': { cel: ['volumes.all(v, has(v.emptyDir))'], check: (pod) => (pod.spec.volumes ?? []).every((v: any) => v.emptyDir !== undefined) },
  'no-env-from': { cel: ['envFrom'], check: (pod) => everyContainer(pod, (c) => (c.envFrom ?? []).length === 0) },
  'no-value-from': { cel: ['valueFrom'], check: (pod) => everyContainer(pod, (c) => (c.env ?? []).every((e: any) => e.valueFrom === undefined)) },
  'no-service-account-token': { cel: ['automountServiceAccountToken == false'], check: (pod) => pod.spec.automountServiceAccountToken === false },
  'default-service-account': {
    cel: ['serviceAccountName', 'serviceAccount in'],
    check: (pod) => [undefined, '', 'default'].includes(pod.spec.serviceAccountName) && [undefined, '', 'default'].includes(pod.spec.serviceAccount),
  },
  'run-as-non-root': {
    cel: ['runAsNonRoot', 'runAsUser == 0'],
    check: (pod) =>
      everyContainer(pod, (c) => (sc(c).runAsNonRoot !== undefined ? sc(c).runAsNonRoot === true : podSc(pod).runAsNonRoot === true)) &&
      podSc(pod).runAsUser !== 0 &&
      everyContainer(pod, (c) => sc(c).runAsUser !== 0),
  },
  'no-privilege-escalation': { cel: ['allowPrivilegeEscalation == false'], check: (pod) => everyContainer(pod, (c) => sc(c).allowPrivilegeEscalation === false) },
  'drop-all-capabilities': {
    cel: ["'ALL' in c.securityContext.capabilities.drop", 'capabilities.add'],
    check: (pod) => everyContainer(pod, (c) => (sc(c).capabilities?.drop ?? []).includes('ALL') && (sc(c).capabilities?.add ?? []).length === 0),
  },
  'read-only-root': { cel: ['readOnlyRootFilesystem == true'], check: (pod) => everyContainer(pod, (c) => sc(c).readOnlyRootFilesystem === true) },
  seccomp: {
    cel: ["seccompProfile.type in ['RuntimeDefault', 'Localhost']"],
    check: (pod) =>
      everyContainer(pod, (c) => SECCOMP_OK.includes(sc(c).seccompProfile !== undefined ? sc(c).seccompProfile.type : podSc(pod).seccompProfile?.type)),
  },
  'no-host-ports': { cel: ['hostPort'], check: (pod) => everyContainer(pod, (c) => (c.ports ?? []).every((port: any) => !port.hostPort)) },
  'no-sysctls': { cel: ['sysctls'], check: (pod) => (podSc(pod).sysctls ?? []).length === 0 },
  'default-proc-mount': { cel: ["procMount == 'Default'"], check: (pod) => everyContainer(pod, (c) => sc(c).procMount === undefined || sc(c).procMount === 'Default') },
}

/** 这个 Pod 违反了哪几条（空 = VAP 放行） */
const violations = (pod: unknown) =>
  Object.entries(RULES)
    .filter(([, rule]) => !rule.check(pod))
    .map(([name]) => name)

const validations = (policy.spec.validations as { expression: string; message: string; reason: string }[]).map((validation) => ({
  ...validation,
  rule: /^\[([a-z-]+)\] /.exec(validation.message)?.[1] ?? '',
}))

describe('k8s 清单：子集解析器', () => {
  it('现有的 Deployment 清单解析得出来（解析器认得这些写法）', () => {
    expect(deployment).toMatchObject({ kind: 'Deployment', spec: { replicas: 1, strategy: { type: 'Recreate' } } })
    expect(serverContainer.lifecycle.preStop.exec.command).toEqual(['sh', '-c', 'sleep 5'])
    expect(clusterDeployment.spec.replicas).toBe(3)
    expect(() => parseYamlDocuments('a: |\n  block\n')).toThrow('块标量')
  })
})

describe('k8s 清单：服务端 Deployment（dev 形态）', () => {
  it('AGENT_SANDBOX=k8s、POD_IP 来自 status.podIP（F14：连回发起的副本）、沙箱建在服务端自己的命名空间、不写网关地址（不许是 Service）', () => {
    expect(envValue('AGENT_SANDBOX')).toBe('k8s')
    expect(serverEnv.POD_IP).toEqual({ name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } })
    expect(envValue('AGENT_SANDBOX_K8S_NAMESPACE')).toBe(serverNamespace)
    expect(serverEnv.AGENT_GATEWAY_URL).toBeUndefined()
    // 沙箱连的是 Pod IP：服务端必须听全部地址，网关端口 = PORT
    expect(envValue('HOST')).toBe('0.0.0.0')
    expect(envValue('PORT')).toBe(String(serverPort))
    expect(K8S_PULL_POLICIES).toContain(envValue('AGENT_SANDBOX_K8S_PULL_POLICY'))
    // 拉镜像的 Secret 就是服务端自己用的那个（dev 里现成的，kubelet 用）
    expect(envValue('AGENT_SANDBOX_K8S_PULL_SECRET')).toBe(podTemplate.spec.imagePullSecrets[0].name)
  })

  it('模型配置只从 envFrom 的 shadecn-learning-agent（ConfigMap + Secret，optional）来、S3 只从 shadecn-learning-s3 来；env 里不写这些（env 优先于 envFrom，会把它们盖掉）', () => {
    expect(serverContainer.envFrom).toEqual([
      { secretRef: { name: 'shadecn-learning-auth' } },
      { configMapRef: { name: 'shadecn-learning-agent', optional: true } },
      { secretRef: { name: 'shadecn-learning-agent', optional: true } },
      { configMapRef: { name: 'shadecn-learning-s3', optional: true } },
      { secretRef: { name: 'shadecn-learning-s3', optional: true } },
    ])
    // S3：env 里只许有上限这一项（其余来自 shadecn-learning-s3 那对 ConfigMap / Secret；S3_KEY_PREFIX 空串 = 桶根，和不配不同，所以哪儿都不写）
    expect(Object.keys(serverEnv).filter((name) => name.startsWith('S3_'))).toEqual(['S3_MAX_UPLOAD_MB'])
    for (const name of ['AGENT_PROVIDER', 'AGENT_MODEL', 'AGENT_BASE_URL', 'AGENT_API', 'AGENT_IMAGE_INPUT', 'AGENT_API_KEY', 'AGENT_TOKEN_SECRET']) {
      expect(serverEnv[name], name).toBeUndefined()
    }
  })

  it('沙箱镜像：完整引用，和服务端镜像同一个 tag（同一次构建），过得了 VAP 的镜像规则；名字和 CI 模板的参数一致', () => {
    const [serverRepo, serverTag] = (serverContainer.image as string).split(/:(?=[^:/]+$)/)
    const [sandboxRepo, sandboxTag] = envValue('AGENT_SANDBOX_IMAGE')!.split(/:(?=[^:/]+$)/)
    expect(serverRepo).toBe(templateParam('imageName'))
    expect(sandboxRepo).toBe(templateParam('sandboxImageName'))
    expect(sandboxTag).toBe(serverTag)
    expect(SANDBOX_IMAGE.test(envValue('AGENT_SANDBOX_IMAGE')!)).toBe(true)
    // CI 的 git-update-image-tag 按这两种行改 tag：各恰好一行，别的地方（注释）不许出现同样的写法
    const text = read('k8s/deployment.yaml')
    expect(occurrences(text, `image: ${templateParam('imageName')}:`)).toBe(1)
    expect(occurrences(text, `value: ${templateParam('sandboxImageName')}:`)).toBe(1)
  })

  it('架构：CI 构建的平台 = 服务端 Pod 的 nodeSelector = 沙箱 Pod 的 nodeSelector；Workflow 也落在同一种节点上', () => {
    const platforms = templateParam('platforms').split(',')
    expect(platforms).toEqual(['linux/arm64'])
    const arch = platforms[0]!.split('/')[1]
    expect(podTemplate.spec.nodeSelector).toEqual({ 'kubernetes.io/arch': arch })
    expect(deployedOptions().nodeSelector).toEqual({ 'kubernetes.io/arch': arch })
    // 手动入口和 Gitea Actions 提交的 Workflow：构建就在那种架构的节点上原生跑（不靠 QEMU）
    for (const file of ['ci/run.yaml', '.gitea/workflows/cicd.yaml']) {
      const pinned = [...read(file).matchAll(/nodeSelector:\n\s+kubernetes\.io\/arch: (\w+)\n/g)].map((match) => match[1])
      expect(pinned, file).toEqual([arch])
      expect([...read(file).matchAll(/kubernetes\.io\/arch: (\w+)/g)].map((match) => match[1]), file).toEqual([arch])
    }
  })

  it('serviceAccountName 指向同步目录里的 ServiceAccount（ArgoCD 同一次 sync 先建好它，ReplicaSet 才建得出 Pod）', () => {
    expect(one(synced, 'ServiceAccount', serverNamespace)).toMatchObject({ metadata: { name: serviceAccount }, automountServiceAccountToken: true })
  })
})

describe('k8s 清单：dev 形态的 RBAC / NetworkPolicy（k8s/agent-sandbox.yaml，ArgoCD 同步）', () => {
  it('只有 dev 里的命名空间级资源（AppProject 的 destination 只有 dev）；没有 Secret、没有集群级资源', () => {
    for (const doc of synced) expect(doc.metadata.namespace, `${doc.kind}/${doc.metadata.name}`).toBe(serverNamespace)
    expect(synced.map((doc) => doc.kind).sort()).toEqual(['NetworkPolicy', 'Role', 'RoleBinding', 'ServiceAccount'])
  })

  it('Role：pods 的 create/get/list/watch/delete + pods/log 的 get；没有 secrets / exec / 通配；绑给服务端的 ServiceAccount', () => {
    const role = one(synced, 'Role', serverNamespace)
    const granted = (role.rules as any[]).flatMap((rule) => {
      expect(rule.apiGroups).toEqual([''])
      expect(rule.resourceNames).toBeUndefined()
      return (rule.resources as string[]).flatMap((resource) => (rule.verbs as string[]).map((verb) => `${verb} ${resource}`))
    })
    expect(granted.sort()).toEqual(['create pods', 'delete pods', 'get pods', 'get pods/log', 'list pods', 'watch pods'])
    expect(JSON.stringify(role.rules)).not.toMatch(/secrets|\*|exec|attach|portforward|ephemeral|update|patch/)
    const roleBinding = one(synced, 'RoleBinding', serverNamespace)
    expect(roleBinding.roleRef).toEqual({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role.metadata.name })
    expect(roleBinding.subjects).toEqual([{ kind: 'ServiceAccount', name: serviceAccount, namespace: serverNamespace }])
  })

  it('NetworkPolicy 只选中沙箱 Pod（不波及 dev 里别的服务）；入站全拒；出站只到服务端 Pod 的网关端口，不放行 DNS / ipBlock', () => {
    const netpol = one(synced, 'NetworkPolicy', serverNamespace)
    expect(netpol.spec.podSelector).toEqual({ matchLabels: { 'shadecn.agent/managed': 'true' } })
    expect(k8sPodSpec(sandboxSpec, deployedOptions())).toMatchObject({ metadata: { labels: netpol.spec.podSelector.matchLabels } })
    expect([...netpol.spec.policyTypes].sort()).toEqual(['Egress', 'Ingress'])
    expect(netpol.spec.ingress ?? []).toEqual([])
    expect(netpol.spec.egress).toEqual([{ to: [{ podSelector: { matchLabels: podTemplate.metadata.labels } }], ports: [{ protocol: 'TCP', port: serverPort }] }])
    expect(JSON.stringify(netpol.spec.egress)).not.toMatch(/ipBlock|namespaceSelector|53/)
  })
})

describe('k8s 清单：ValidatingAdmissionPolicy（dev 的准入兜底）', () => {
  it('只管 dev 里服务端 ServiceAccount 发起的 Pod CREATE；failurePolicy Fail；绑定是 Deny', () => {
    expect(policy.spec.failurePolicy).toBe('Fail')
    expect(policy.spec.matchConstraints).toEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': serverNamespace } },
      resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE'], resources: ['pods'] }],
    })
    expect(policy.spec.matchConditions).toEqual([
      { name: 'agent-sandbox-driver', expression: `request.userInfo.username == 'system:serviceaccount:${serverNamespace}:${serviceAccount}'` },
    ])
    expect(binding.spec).toEqual({ policyName: policy.metadata.name, validationActions: ['Deny'] })
    // 集群级，不进 ArgoCD 的同步目录
    expect(policy.metadata.namespace).toBeUndefined()
  })

  it('每条规则都有 [规则名]、reason Forbidden；规则集合和 TS 判定一致，每条 CEL 引用了它对应的字段', () => {
    for (const validation of validations) {
      expect(validation.rule, validation.message).not.toBe('')
      expect(validation.reason).toBe('Forbidden')
    }
    expect(validations.map((v) => v.rule).sort()).toEqual(Object.keys(RULES).sort())
    for (const { rule, expression } of validations) {
      for (const fragment of RULES[rule]!.cel) expect(expression, rule).toContain(fragment)
    }
  })

  it('驱动生成的沙箱 Pod（按 k8s/deployment.yaml 的配置）和启动自检的 dry-run 都过得了每一条；privileged 的反例必须被拒', () => {
    const options = deployedOptions()
    expect(violations(k8sPodSpec(sandboxSpec, options))).toEqual([])
    expect(violations(k8sPodSpec(selfcheckSpec, options, 'shadecn-agent-selfcheck-abc123'))).toEqual([])
    // 自检的反例：被放行 = 兜底不在（apps/server 据此不启用 agent）
    expect(violations(k8sPrivilegedPodSpec(selfcheckSpec, options, 'shadecn-agent-selfcheck-guard-abc123'))).toEqual(['no-privileged', 'no-privilege-escalation'])
  })

  it('样例：allow.yaml 一条都不违反；deny.yaml 的每一份恰好违反注解里那几条（管理员在真集群上 dry-run 的就是这两份）', () => {
    expect(violations(allowPod)).toEqual([])
    expect(allowPod.metadata.namespace).toBe(serverNamespace)
    expect(denyPods.length).toBeGreaterThanOrEqual(15)
    const covered = new Set<string>()
    for (const pod of denyPods) {
      const expected = (pod.metadata.annotations['shadecn.agent/denied-by'] as string).split(',').sort()
      expect(violations(pod).sort(), pod.metadata.name).toEqual(expected)
      expect(pod.metadata.namespace).toBe(serverNamespace)
      for (const rule of expected) covered.add(rule)
    }
    // 用户点名要验的三种 + 几条最要紧的，都有反例
    for (const rule of ['emptydir-only', 'no-privileged', 'sandbox-image', 'no-value-from', 'no-env-from', 'no-host-namespaces', 'default-service-account', 'no-service-account-token']) {
      expect(covered, rule).toContain(rule)
    }
    expect(new Set(denyPods.map((pod) => pod.metadata.name)).size).toBe(denyPods.length)
  })
})

describe('k8s 清单：独立命名空间形态（k8s/variants/agent-sandbox.yaml，更强的那种）', () => {
  const namespace = one(variant, 'Namespace').metadata.name as string

  it('命名空间就是驱动的默认值；强制 Pod Security restricted；命名空间级资源都在它里面；服务端的 SA 不在这里重复定义', () => {
    expect(namespace).toBe(K8S_DEFAULT_NAMESPACE)
    expect(one(variant, 'Namespace').metadata.labels).toMatchObject({
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/enforce-version': 'latest',
    })
    for (const doc of variant.filter((d) => d.kind !== 'Namespace')) expect(doc.metadata.namespace, `${doc.kind}/${doc.metadata.name}`).toBe(namespace)
    expect(ofKind(variant, 'ServiceAccount', serverNamespace)).toEqual([])
    expect(one(variant, 'ServiceAccount', namespace)).toMatchObject({ metadata: { name: 'default' }, automountServiceAccountToken: false })
  })

  it('驱动建的 Pod 满足 restricted：非 root、RuntimeDefault、不提权、drop ALL、只有 emptyDir、不共享宿主命名空间、不挂 SA token', () => {
    const pod = k8sPodSpec(sandboxSpec, { image: 'registry.example/agent-sandbox:1', instance: 'abcdef0123456789', runtimeClassName: 'gvisor' }) as any
    expect(pod.metadata.namespace).toBe(namespace)
    const { spec } = pod
    expect(spec.securityContext).toMatchObject({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } })
    expect(spec.securityContext.runAsUser).toBeGreaterThan(0)
    expect(spec).toMatchObject({ hostNetwork: false, hostPID: false, hostIPC: false, automountServiceAccountToken: false, enableServiceLinks: false })
    expect(spec.volumes.every((volume: any) => Object.keys(volume).sort().join() === 'emptyDir,name')).toBe(true)
    for (const container of spec.containers) {
      expect(container.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, privileged: false, capabilities: { drop: ['ALL'] } })
      expect(container.env.map((entry: any) => entry.name).sort()).toEqual(['SHADECN_BOOTSTRAP_TOKEN', 'SHADECN_GATEWAY_URL', 'SHADECN_WORKDIR'])
      expect(container.ports).toBeUndefined()
    }
  })

  it('RBAC：只在沙箱命名空间、同一组动词，绑给 dev 里那个 ServiceAccount；没有 ClusterRole', () => {
    expect(variant.some((doc) => doc.kind === 'ClusterRole' || doc.kind === 'ClusterRoleBinding')).toBe(false)
    const role = one(variant, 'Role', namespace)
    expect(role.rules).toEqual(one(synced, 'Role', serverNamespace).rules)
    expect(one(variant, 'RoleBinding', namespace).subjects).toEqual([{ kind: 'ServiceAccount', name: serviceAccount, namespace: serverNamespace }])
  })

  it('NetworkPolicy：选中命名空间的全部 Pod；入站全拒；出站只到服务端 Pod 的网关端口（DNS 是可选的那一条，默认不放行）', () => {
    const netpol = one(variant, 'NetworkPolicy', namespace)
    expect(netpol.spec.podSelector).toEqual({})
    expect([...netpol.spec.policyTypes].sort()).toEqual(['Egress', 'Ingress'])
    expect(netpol.spec.ingress ?? []).toEqual([])
    expect(netpol.spec.egress).toEqual([
      {
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': serverNamespace } }, podSelector: { matchLabels: podTemplate.metadata.labels } }],
        ports: [{ protocol: 'TCP', port: serverPort }],
      },
    ])
  })

  it('配额兜底：ResourceQuota 限并发 Pod 数；默认资源的沙箱 Pod 在 LimitRange 的上限之内、且带着配额要求的每一项', () => {
    const quota = one(variant, 'ResourceQuota', namespace)
    expect(Number(quota.spec.hard.pods)).toBeGreaterThan(0)
    const container = (k8sPodSpec(sandboxSpec, { image: 'r.example/s:1', instance: 'i' }) as any).spec.containers[0]
    expect(container.resources.requests).toEqual(container.resources.limits)
    for (const key of Object.keys(quota.spec.hard).filter((key) => key !== 'pods')) {
      const [kind, resource] = key.split('.') as ['requests' | 'limits', string]
      expect(container.resources[kind][resource], key).toBeDefined()
    }
    const max = one(variant, 'LimitRange', namespace).spec.limits.find((limit: any) => limit.type === 'Container').max
    for (const [resource, value] of Object.entries(k8sResources({ cpu: 1, memoryMiB: 512, pids: 128, diskMiB: 512, deadlineMs: 1 }))) {
      expect(quantity(value), resource).toBeLessThanOrEqual(quantity(max[resource]))
    }
  })
})

describe('k8s 清单：两种 Deployment 形态', () => {
  it('多副本那份和单副本的服务端 Pod 标签、端口、HOST 对得上（NetworkPolicy 按它们放行）', () => {
    for (const shape of [deployment, clusterDeployment]) {
      expect(shape.spec.template.metadata.labels).toEqual(podTemplate.metadata.labels)
      const container = shape.spec.template.spec.containers[0]
      expect(container.ports[0].containerPort).toBe(serverPort)
      const env = Object.fromEntries((container.env as any[]).map((entry) => [entry.name, entry.value]))
      expect(env.PORT).toBe(String(serverPort))
      expect(env.HOST).toBe('0.0.0.0')
    }
  })
})

/** k8s 的资源量：`500m` / `2` / `512Mi` / `4Gi` → 统一成 millicores 或字节 */
function quantity(value: string | number): number {
  const text = String(value)
  const units: Record<string, number> = { m: 1e-3, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, k: 1e3, M: 1e6, G: 1e9 }
  const match = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(text)
  if (!match) throw new Error(`认不出的资源量 ${text}`)
  const unit = match[2] ?? ''
  if (unit && !(unit in units)) throw new Error(`认不出的单位 ${unit}`)
  return Number(match[1]) * (unit ? units[unit]! : 1)
}
