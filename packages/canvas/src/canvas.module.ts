import { DATA_ACCESS_ENTITIES } from '@learning/data-access'
import { Module } from '@nestjs/common'
import { AccessRevocation } from './access-revocation.js'
import { Flow, FlowUserState, Project, ProjectInvite, ProjectMember } from './entities.js'
import { FlowBodyParsers } from './flow-body-parsers.js'
import { FlowDocStore } from './flow-doc.store.js'
import { FlowsService } from './flows.service.js'
import { FlowMemberGuard } from './guards.js'
import { ProjectsService } from './projects.service.js'

/**
 * 画布的服务层：项目、成员、邀请、画布的读写，判权，`FlowDocStore`，撤权信号。协同、存储、agent 进程都 import 它，不需要 REST。
 * 依赖全局底座（`DataAccessModule`、`ClusterModule`、`SessionIdentityModule`），不用 import。
 * **不认识协同**：跨进程只走共享层和数据库（`AccessRevocation`、`CANVAS_FLUSH_CONTENT`，docs/30 §2）。
 */
@Module({
  providers: [
    { provide: DATA_ACCESS_ENTITIES, useValue: [Project, ProjectMember, ProjectInvite, Flow, FlowUserState] },
    ProjectsService,
    FlowsService,
    FlowDocStore,
    AccessRevocation,
    FlowMemberGuard,
    FlowBodyParsers,
  ],
  exports: [ProjectsService, FlowsService, FlowDocStore, AccessRevocation, FlowMemberGuard, FlowBodyParsers],
})
export class CanvasModule {}
