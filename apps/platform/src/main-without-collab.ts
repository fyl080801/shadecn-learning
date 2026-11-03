import 'reflect-metadata'
import { PlatformSplitModule } from './platform-split.module.js'
import { startPlatform } from './start.js'

/** 协同由 `apps/collab` 的副本提供时的入口：前面的代理把协同的路径分给它们（docs/30 §3） */
await startPlatform(PlatformSplitModule)
