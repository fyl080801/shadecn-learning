/**
 * 「同一时刻只许一个人做这件事」，跨进程。
 *
 * 用在会话续期上：refresh token 开了轮换时，第二个进程拿同一个 token 去换会被判 `invalid_grant`，把好端端的会话注销掉。
 */
export abstract class SharedLock {
  protected readonly namespace: string

  constructor(namespace: string) {
    this.namespace = namespace
  }

  /**
   * 抢到锁就跑 `task`；没抢到就等着，等到之后跑 `fallback`。
   *
   * 两种实现的语义**故意不完全一样**，但都满足「不并发执行 task」：
   * - 内存实现（只有一个进程）直接复用同一个 in-flight promise，后来者拿到的就是同一个结果；
   * - Redis 实现做不到跨进程共享 promise，所以后来者等锁释放或过期，然后跑 `fallback`（通常是重读一遍库）。
   *
   * 所以 `fallback` 必须能独立得出正确答案，不能假设 task 跑成功了：赢家可能失败，也可能崩溃、锁是过期才放开的。
   * `ttlMs` 是锁的存活上限，**必须大于 task 最坏情况的耗时**：过期后别人能抢到锁，task 就并发了。所以没有默认值。
   *
   * 抢锁这一步失败（共享层不可用）抛 {@link SharedLockUnavailableError}，**task 没有跑**。不能退化成无锁执行：
   * 那正是这把锁要防的事。task 自己抛的错原样抛出。
   */
  abstract run<T>(key: string, task: () => Promise<T>, options: { fallback: () => Promise<T>; ttlMs: number }): Promise<T>
}

/** 抢锁失败：不知道锁在谁手里，task 没有跑。调用方决定怎么降级 */
export class SharedLockUnavailableError extends Error {
  constructor(cause: unknown) {
    super('[cluster] 共享锁不可用', { cause })
    this.name = 'SharedLockUnavailableError'
  }
}
