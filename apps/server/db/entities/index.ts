import { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from './agent.ts'
import { AuthRequest, PendingLink, Session, User, UserIdentity } from './auth.ts'
import { Flow, FlowUserState, Project, ProjectInvite, ProjectMember } from './canvas.ts'

export { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from './agent.ts'
export { AuthRequest, PendingLink, Session, User, UserIdentity } from './auth.ts'
export { Flow, FlowUserState, Project, ProjectInvite, ProjectMember } from './canvas.ts'
export { newId } from './columns.ts'

/** 交给 MikroORM 发现的全部实体。加实体 = 写进 auth.ts / canvas.ts / agent.ts 并加到这里 */
export const entities = [
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
  AgentConversation,
  AgentRun,
  AgentToolCall,
  AgentGrant,
  AgentGrantScope,
]
