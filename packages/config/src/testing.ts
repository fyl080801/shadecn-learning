import os from 'node:os'
import path from 'node:path'
import { type DynamicModule, Module } from '@nestjs/common'
import { ConfigService } from './config.service.js'

export interface TestConfigOptions {
  /** 默认在系统临时目录下，不落到真实仓库：漏配 `database.url` 的用例也碰不到真实的 data/ */
  rootDir?: string
  /** 默认 `<rootDir>/data` */
  dataDir?: string
  /** 默认 false */
  isProduction?: boolean
  /** {@link ConfigService.env} 能取到的值，默认空：不读真实的环境变量和 .env */
  env?: Readonly<Record<string, string | undefined>>
}

@Module({})
class TestConfigModule {}

/**
 * 只给测试用：不读文件，直接给各段的值。和生产的 `ConfigModule` 提供同一个 token，
 * 被测模块走的是同一条读配置的路径。
 */
export function testConfigModule(values: Record<string, unknown> = {}, options: TestConfigOptions = {}): DynamicModule {
  const rootDir = options.rootDir ?? path.join(os.tmpdir(), 'learning-config-test')
  const config = new ConfigService({
    rootDir,
    dataDir: options.dataDir ?? path.join(rootDir, 'data'),
    isProduction: options.isProduction ?? false,
    values,
    env: options.env,
  })
  return {
    module: TestConfigModule,
    global: true,
    providers: [{ provide: ConfigService, useValue: config }],
    exports: [ConfigService],
  }
}
