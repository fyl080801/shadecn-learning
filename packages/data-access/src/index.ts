/**
 * @learning/data-access —— Nest 服务的数据访问模块：启动时把库对齐到实体定义，经依赖注入提供 {@link DataAccess}。
 * 实体由各功能模块经 `DATA_ACCESS_ENTITIES` 登记，本包自己只有 `User`（所有模块的外键目标）和写实体用的列。
 *
 * **单例不变式**：实体对象、`DataAccess`、`DATA_ACCESS_ENTITIES` 都只能有一份，否则 MikroORM 的元数据和 Nest 的注入 token 都对不上。
 * 所以消费者把本包声明成 peerDependency；本包把 `@learning/config`、`@nestjs/*` 声明成 peer，理由相同（它们的类就是注入 token）。
 */
export { createdAtColumn, idColumn, updatedAtColumn } from './columns.js'
export { DataAccess } from './data-access.js'
export { User } from './entities.js'
export { DATA_ACCESS_ENTITIES } from './entity-registry.js'
export { databaseProviderOf, DataAccessModule } from './module.js'
