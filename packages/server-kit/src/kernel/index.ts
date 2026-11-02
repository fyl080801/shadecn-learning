/**
 * 模块内核（REQ-MODULES，docs/28 §3.1）：集成协议、角色、入口声明与归属表、配置段、选模块与排序、生命周期、能力表。
 * 宿主（packages/server-core/src/platform.ts）按这里的顺序用：parseRoles → assertRolesSupported → parseModuleConfigs → resolveModules → recordFeatures → startModules。
 */
export {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  defineModule,
  defineModuleConfig,
  type AnyServerModule,
  type ModuleConfig,
  type ModuleContext,
  type ModuleDependency,
  type ModuleHandle,
  type ModuleHttp,
  type ServerModule,
  type UpgradeHandler,
} from './module.ts'
export { ALL_ROLES, assertRolesSupported, isAllRoles, parseRoles, type ServerRole } from './roles.ts'
export {
  assertRoutePath,
  buildRouteTable,
  describeRouteTable,
  routeCovers,
  type OwnedRoute,
  type RouteDeclaration,
  type RouteTable,
} from './routes.ts'
export { moduleConfigPath, moduleConfigSchema, moduleEnvName, parseModuleConfigs, type ModuleConfigs } from './config.ts'
export { activeDependencies, resolveModules, type ResolvedModules, type SkippedModule } from './resolve.ts'
export { startModules, withDeadline, type HttpHost, type LoadedModules, type StartContext } from './lifecycle.ts'
export { loadedFeatures, recordFeatures, type FeatureTable } from './registry.ts'
