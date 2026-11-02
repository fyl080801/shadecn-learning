import 'reflect-metadata'
import { defineEntity, p } from '@mikro-orm/core'
import { Global, Injectable, Module, type OnModuleInit } from '@nestjs/common'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_ACCESS_ENTITIES, DataAccess, DataAccessModule, User } from '../src/index.js'
import { boot, databaseConfig, dataAccessWith, sqliteFixture, tableNames, type DatabaseFixture } from './helpers.js'

const Alpha = defineEntity({
  name: 'RegisteredAlpha',
  properties: { id: p.text().primary(), owner: () => p.manyToOne(User).nullable() },
})
const Beta = defineEntity({ name: 'RegisteredBeta', properties: { id: p.text().primary() } })

@Module({ providers: [{ provide: DATA_ACCESS_ENTITIES, useValue: [Alpha] }] })
class AlphaModule {}
@Module({ providers: [{ provide: DATA_ACCESS_ENTITIES, useValue: [Beta] }] })
class BetaModule {}

describe('DATA_ACCESS_ENTITIES：模块登记实体', () => {
  let fixture: DatabaseFixture
  let url: string

  beforeAll(() => {
    fixture = sqliteFixture()
  })
  afterAll(() => fixture.cleanup())
  beforeEach(async () => {
    url = await fixture.fresh()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const sorted = async (app: Awaited<ReturnType<typeof boot>>) => (await tableNames(app.get(DataAccess).orm)).sort()

  it.each([
    ['登记模块在 DataAccessModule 前面', () => [AlphaModule, BetaModule, databaseConfig(url), DataAccessModule]],
    ['登记模块在 DataAccessModule 后面', () => [databaseConfig(url), DataAccessModule, AlphaModule, BetaModule]],
    ['两边各一个', () => [BetaModule, databaseConfig(url), DataAccessModule, AlphaModule]],
  ])('%s：表都建出来，和 imports 的先后无关', async (_name, imports) => {
    const app = await boot(imports())
    expect(await sorted(app)).toEqual(['registered_alpha', 'registered_beta', 'user'])
    await app.close()
  })

  it('没引入的模块（这里是 BetaModule）：它的实体不进实体集，也不建表', async () => {
    const app = await boot([databaseConfig(url), DataAccessModule, AlphaModule])
    expect(await sorted(app)).toEqual(['registered_alpha', 'user'])
    await app.close()
  })

  it('登记模块藏在 imports 深处或是全局模块，也收得到', async () => {
    @Module({ imports: [AlphaModule] })
    class Mid {}
    @Module({ imports: [Mid] })
    class Outer {}
    @Global()
    @Module({ providers: [{ provide: DATA_ACCESS_ENTITIES, useValue: [Beta] }] })
    class GlobalRegistrant {}

    const app = await boot([Outer, GlobalRegistrant, databaseConfig(url), DataAccessModule])
    expect(await sorted(app)).toEqual(['registered_alpha', 'registered_beta', 'user'])
    await app.close()
  })

  it('同一个实体被两个模块登记：去重，正常启动', async () => {
    @Module({ providers: [{ provide: DATA_ACCESS_ENTITIES, useValue: [Alpha, User] }] })
    class AlphaAgain {}
    const app = await boot([AlphaModule, AlphaAgain, databaseConfig(url), DataAccessModule])
    expect(await sorted(app)).toEqual(['registered_alpha', 'user'])
    await app.close()
  })

  it('顺序不变式：排在最前面的模块，它的异步工厂和 onModuleInit 查自己登记的表时，同步已经做完', async () => {
    const seen: string[] = []

    @Injectable()
    class Consumer implements OnModuleInit {
      constructor(readonly dataAccess: DataAccess) {}
      async onModuleInit() {
        await this.dataAccess.em().count(Alpha)
        seen.push('onModuleInit')
      }
    }
    @Module({
      providers: [
        { provide: DATA_ACCESS_ENTITIES, useValue: [Alpha] },
        Consumer,
        {
          provide: 'FACTORY',
          inject: [DataAccess],
          useFactory: async (dataAccess: DataAccess) => {
            await dataAccess.em().count(Alpha)
            seen.push('factory')
            return true
          },
        },
      ],
    })
    class EarlyModule {}

    const app = await boot([EarlyModule, databaseConfig(url), DataAccessModule])
    expect([...seen].sort()).toEqual(['factory', 'onModuleInit'])
    await app.close()
  })

  it.each([
    ['useFactory', { provide: DATA_ACCESS_ENTITIES, useFactory: () => [Alpha] }],
    ['useClass', { provide: DATA_ACCESS_ENTITIES, useClass: class NotEntities {} }],
    ['useExisting', { provide: DATA_ACCESS_ENTITIES, useExisting: 'SOMETHING' }],
  ])('登记用了 %s → 拒绝启动并点名模块：扫描时读不到值，放过去就是悄悄少一张表', async (_name, provider) => {
    @Module({ providers: [provider, { provide: 'SOMETHING', useValue: [] }] })
    class BadRegistrant {}
    await expect(boot([BadRegistrant, databaseConfig(url), DataAccessModule])).rejects.toThrow(
      /BadRegistrant 登记实体只能用 useValue/,
    )
  })

  it('登记的不是数组 → 拒绝启动', async () => {
    @Module({ providers: [{ provide: DATA_ACCESS_ENTITIES, useValue: Alpha }] })
    class NotArray {}
    await expect(boot([NotArray, databaseConfig(url), DataAccessModule])).rejects.toThrow(/NotArray 登记的实体必须是数组/)
  })

  it('测试专用的替换：实体集整个换掉，模块登记的不算', async () => {
    const app = await boot([AlphaModule, databaseConfig(url), dataAccessWith([Beta])])
    expect(await sorted(app)).toEqual(['registered_beta'])
    await app.close()
  })
})
