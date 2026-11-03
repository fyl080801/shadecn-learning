import { DataAccess } from '@learning/data-access'
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { AuthRequest, PendingLink, Session } from './entities.js'
import { describeError } from './errors.js'
import { type ResolvedSessionOptions, SESSION_OPTIONS } from './options.js'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * 定时清理：启动时跑一次，之后每小时跑一次。归登录模块：一个库只需要一个进程扫，授权请求也是登录流程自己的表。
 */
@Injectable()
export class SessionSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined

  constructor(
    @Inject(DataAccess) private readonly dataAccess: DataAccess,
    @Inject(SESSION_OPTIONS) private readonly options: ResolvedSessionOptions,
  ) {}

  async onModuleInit() {
    await this.run()
    this.timer = setInterval(() => void this.run(), SWEEP_INTERVAL_MS)
    this.timer.unref()
  }

  onModuleDestroy() {
    clearInterval(this.timer)
  }

  /** 清理失败只记日志：既不该挡住启动，下一轮也还会再来 */
  private async run() {
    try {
      const { sessions, authRequests, pendingLinks } = await this.sweepExpired()
      if (sessions || authRequests || pendingLinks) console.log(`[session] 清理过期数据：会话 ${sessions} 条，授权请求 ${authRequests} 条，待确认关联 ${pendingLinks} 条`)
    } catch (err) {
      console.error(`[session] 清理过期数据失败：${describeError(err)}`)
    }
  }

  /**
   * 清掉活过 ttl 的会话、没用掉的授权请求和没人确认的关联（用户再也不回设置页时，读取时顺手删的那条路走不到）。
   * access_token 过期的会话不在其列：refresh token 还可能续得回来，续不回来的由 `SessionService.load` 删。
   */
  async sweepExpired(): Promise<{ sessions: number; authRequests: number; pendingLinks: number }> {
    const now = Date.now()
    const [sessions, authRequests, pendingLinks] = await Promise.all([
      this.dataAccess.em().nativeDelete(Session, { createdAt: { $lt: new Date(now - this.options.ttlSeconds * 1000) } }),
      this.dataAccess.em().nativeDelete(AuthRequest, { expiresAt: { $lt: new Date(now) } }),
      this.dataAccess.em().nativeDelete(PendingLink, { expiresAt: { $lt: new Date(now) } }),
    ])
    return { sessions, authRequests, pendingLinks }
  }
}
