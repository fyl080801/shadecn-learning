import type { Options } from '@mikro-orm/core'
import { Session, AuthRequest, PendingLink, UserIdentity } from '@shadecn/mod-auth/entities'
import { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from '@shadecn/mod-agent/entities'
import { AppTask } from '@shadecn/mod-apps/entities'
import { Flow, FlowUserState, Project, ProjectInvite, ProjectMember } from '@shadecn/mod-canvas/entities'
import { FlowAsset } from '@shadecn/mod-storage/entities'
import { User } from '@shadecn/server-kit/identity'

/**
 * 默认管理的全部实体：User + 五个模块各自拥有的实体（归属不变，docs/28 §3.1，这里只是列出来）。
 * 模块往自己的 entities 里加实体时这里要跟着加，`test/entities.test.ts` 对着各 entities 模块的导出钉着。
 */
export const dataAccessEntities = [
  User,
  UserIdentity,
  Session,
  PendingLink,
  AuthRequest,
  Project,
  ProjectMember,
  ProjectInvite,
  Flow,
  FlowUserState,
  FlowAsset,
  AgentConversation,
  AgentRun,
  AgentToolCall,
  AgentGrant,
  AgentGrantScope,
  AppTask,
] as NonNullable<Options['entities']>
