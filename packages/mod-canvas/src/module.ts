import { defineModule } from '@shadecn/server-kit/kernel'
import { CANVAS_SERVICE, type CanvasService } from './contract.ts'
import { Flow, FlowUserState, Project, ProjectInvite, ProjectMember } from './entities.ts'
import { flowDocs } from './flow-docs.ts'
import { flows } from './flows.ts'
import { flowRequest, requireFlowMember } from './guards.ts'
import { projects } from './projects.ts'
import { flows as flowRoutes } from './routes/flows.ts'
import { invites as inviteRoutes } from './routes/invites.ts'
import { projects as projectRoutes } from './routes/projects.ts'

/**
 * 画布模块（REQ-CANVAS，docs/13；docs/28 §3.1）：项目、成员、邀请、画布元数据 —— 别的能力都建在它上面。
 *
 * - **随所有角色加载**：协同进房要判成员、要读写画布内容，agent 要判权，它们都经 `canvas` 服务问这里；
 *   REST 接口只归 `web`（声明了角色，别的进程里内核不挂）。
 * - 别的模块挂在 `/api/flows/:flowId/<x>` 下的路由自己叠 `canvas.flowGuard`（`./contract.ts`）。
 * - 「复制前落库」走总线（`flushFlowContent`）：持有活内容的协同登记处理，画布不认识协同。
 */
export default defineModule({
  name: 'canvas',
  roles: ['web', 'collab', 'agent'],
  // 「这个请求是谁」来自登录模块提供的平台 `auth`：它要先 setup
  dependsOn: ['auth'],
  provides: [CANVAS_SERVICE],
  entities: [Project, ProjectMember, ProjectInvite, Flow, FlowUserState],
  routes: [
    { path: '/api/projects', role: 'web', access: 'user' },
    { path: '/api/invites', role: 'web', access: 'user' },
    { path: '/api/flows', role: 'web', access: 'user' },
  ],
  setup(ctx) {
    const service: CanvasService = {
      flowGuard: requireFlowMember,
      request: flowRequest,
      locate: (flowId) => flows.locate(flowId),
      roleOf: (projectId, userId) => projects.roleOf(projectId, userId),
      docs: flowDocs,
    }
    ctx.provide(CANVAS_SERVICE, service)

    ctx.http.route('/api/projects', projectRoutes)
    ctx.http.route('/api/invites', inviteRoutes)
    ctx.http.route('/api/flows', flowRoutes)
  },
})
