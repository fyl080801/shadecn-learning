import type { ProjectKind, ProjectRole } from '@learning/contracts/canvas'
import { SessionGuard, type SessionUser } from '@learning/session'
import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  UseGuards,
} from '@nestjs/common'
import { FlowsService } from './flows.service.js'
import { ProjectsService } from './projects.service.js'

/**
 * 项目维度的判权。两条铁律（docs/13 §4.8）：
 * - **非成员一律 404**，不是 403 —— 不泄露项目 / 画布是否存在；
 * - 是成员但角色不够（member 干 admin 的事）才是 **403**。
 */

/** 守卫挂到请求上的「这个请求在这个项目里是什么身份」 */
export interface CanvasAccess {
  projectId: string
  role: ProjectRole
  /** 个人空间上不许有分享链接 / 成员管理；画布数上限只对团队项目生效 */
  kind: ProjectKind
}

interface CanvasRequest {
  headers: Record<string, unknown>
  user?: SessionUser
  params: Record<string, string | undefined>
  canvasAccess?: CanvasAccess
}

const requestOf = (context: ExecutionContext) => context.switchToHttp().getRequest<CanvasRequest>()

/** 全局的 `ApiSessionGuard` 已经挂好 user；进程没配它时走一遍同样的校验（401 的形状只有一处） */
async function userOf(sessionGuard: SessionGuard, context: ExecutionContext): Promise<SessionUser> {
  const request = requestOf(context)
  if (!request.user) await sessionGuard.canActivate(context)
  return request.user as SessionUser
}

const projectNotFound = () => new HttpException({ error: 'Not Found', message: '项目不存在' }, 404)
const flowNotFound = () => new HttpException({ error: 'Not Found', message: '画布不存在' }, 404)

/** 要求请求者是 `:projectId` 的成员；项目软删了同样 404 */
@Injectable()
export class ProjectMemberGuard implements CanActivate {
  constructor(
    @Inject(SessionGuard) private readonly sessionGuard: SessionGuard,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = await userOf(this.sessionGuard, context)
    const request = requestOf(context)
    const projectId = request.params.projectId
    const membership = projectId ? await this.projects.membershipOf(projectId, user.id) : null
    if (!projectId || !membership) throw projectNotFound()
    request.canvasAccess = { projectId, ...membership }
    return true
  }
}

/**
 * 叠在 {@link ProjectMemberGuard} 之后：个人空间上不许干的事（分享链接、成员管理、删项目、改名）用它挡掉。
 * 是 **403 不是 404** —— 请求者确实是这个「项目」的成员，他只是在对自己的私人空间做一件没有意义的事。
 */
@Injectable()
export class TeamProjectGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (requestOf(context).canvasAccess?.kind !== 'team') {
      throw new HttpException({ error: 'Forbidden', message: '个人空间不支持这个操作' }, 403)
    }
    return true
  }
}

/** 叠在 {@link ProjectMemberGuard} 之后：角色不够就是 403 */
@Injectable()
export class ProjectAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (requestOf(context).canvasAccess?.role !== 'admin') {
      throw new HttpException({ error: 'Forbidden', message: '需要项目管理员权限' }, 403)
    }
    return true
  }
}

/** 团队项目的管理动作：先判成员（404），再判项目形态（403），再判角色（403）。顺序就是错误优先级 */
export const TeamProjectAdmin = () => applyDecorators(UseGuards(ProjectMemberGuard, TeamProjectGuard, ProjectAdminGuard))

/**
 * 画布路由用：先按 `:flowId` 查出归属项目，再判成员身份。画布或其项目被软删、请求者不是成员，统统 404。
 * 别的模块挂在 `/api/flows/:flowId/<x>` 下的路由（协同的 `/doc`、上传）import `CanvasModule` 后自己叠它，之后用 {@link CurrentAccess} 读身份。
 */
@Injectable()
export class FlowMemberGuard implements CanActivate {
  constructor(
    @Inject(SessionGuard) private readonly sessionGuard: SessionGuard,
    @Inject(FlowsService) private readonly flows: FlowsService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = await userOf(this.sessionGuard, context)
    const request = requestOf(context)
    const flowId = request.params.flowId
    const target = flowId ? await this.flows.locate(flowId) : null
    if (!target) throw flowNotFound()

    const membership = await this.projects.membershipOf(target.projectId, user.id)
    if (!membership) throw flowNotFound()

    request.canvasAccess = { projectId: target.projectId, ...membership }
    return true
  }
}

/**
 * 路由参数装饰器：拿守卫挂上去的 {@link CanvasAccess}。
 * 没挂守卫是写错了代码，抛普通错误（500），不能用 undefined 让路由以为判过权了。
 */
export const CurrentAccess = createParamDecorator((_data: unknown, context: ExecutionContext): CanvasAccess => {
  const { canvasAccess } = requestOf(context)
  if (!canvasAccess) throw new Error('[canvas] 用了 @CurrentAccess() 的路由没有挂 ProjectMemberGuard / FlowMemberGuard')
  return canvasAccess
})
