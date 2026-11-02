import type { Options } from '@mikro-orm/core'
import type { ModulesContainer } from '@nestjs/core'

export type Entities = NonNullable<Options['entities']>

/**
 * 功能模块向 {@link DataAccess} 登记实体的 token。模块在自己的 providers 里写：
 *
 * ```ts
 * @Module({ providers: [{ provide: DATA_ACCESS_ENTITIES, useValue: [Session] }] })
 * ```
 *
 * 不需要 export、不需要 import DataAccessModule，模块保持静态。没有被 import 的模块，它的实体就不在这个进程里，也就不会建表。
 */
export const DATA_ACCESS_ENTITIES = Symbol('DATA_ACCESS_ENTITIES')

/**
 * 只给测试用，不从包入口导出：换掉整个实体集（探针实体），不走模块收集。
 * 动态模块的元数据要算哈希，实体对象又深又有环，所以替换时用 `useFactory`（见 test/helpers.ts）。
 */
export const DATA_ACCESS_ENTITY_OVERRIDE = Symbol('DATA_ACCESS_ENTITY_OVERRIDE')

/**
 * 从模块容器里收集各模块登记的实体。ORM 工厂调用它：Nest 先扫描完整张模块图、才开始建实例，所以工厂运行时每个模块都已经在容器里，
 * 收到的实体集和模块在 imports 里的先后无关（`LazyModuleLoader` 懒加载的模块除外：它们晚于工厂，不能在里面登记实体）。
 *
 * **只认 `useValue`**：值在扫描时就放进了 wrapper；工厂或类 provider 此刻可能还没实例化，收集结果会随 Nest 建实例的顺序变，
 * 少一个实体就是少一张表，查询时才炸。所以这里直接抛错拒绝启动，不看它碰巧解析好了没有。
 */
export function collectEntities(modules: ModulesContainer): Entities {
  const entities = new Set<unknown>()
  for (const moduleRef of modules.values()) {
    const wrapper = moduleRef.providers.get(DATA_ACCESS_ENTITIES)
    if (!wrapper) continue
    const owner = moduleRef.metatype.name
    if (wrapper.metatype !== null) {
      throw new Error(`[data-access] ${owner} 登记实体只能用 useValue（模块扫描完就要读到，工厂和类 provider 这时还没实例化）`)
    }
    if (!Array.isArray(wrapper.instance)) throw new Error(`[data-access] ${owner} 登记的实体必须是数组`)
    for (const entity of wrapper.instance) entities.add(entity)
  }
  return [...entities] as Entities
}
