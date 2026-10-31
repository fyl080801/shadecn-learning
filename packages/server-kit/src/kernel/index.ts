/**
 * 模块内核（REQ-MODULES，docs/28 §3.1）：模块契约、角色、选模块与排序、生命周期、能力表。
 * 宿主（apps/server/boot.ts）按这里的顺序用：parseRoles → assertRolesSupported → resolveModules → recordFeatures → startModules。
 */
export {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  defineModule,
  type ModuleContext,
  type ModuleHandle,
  type ServerModule,
} from './module.ts'
export { ALL_ROLES, assertRolesSupported, isAllRoles, parseRoles, type ServerRole } from './roles.ts'
export { resolveModules, type ResolvedModules, type SkippedModule } from './resolve.ts'
export { startModules, withDeadline, type LoadedModules } from './lifecycle.ts'
export { loadedFeatures, recordFeatures, type FeatureTable } from './registry.ts'
