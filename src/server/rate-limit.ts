/**
 * Fixed-window rate limiter held in process memory. Limits apply per web
 * instance; deployments with several web replicas should also rate-limit at the
 * reverse proxy (see docs/DEPLOYMENT.md).
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()
  private lastSweep = Date.now()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; returns seconds until retry when the limit is exceeded, otherwise 0. */
  hit(key: string, now = Date.now()): number {
    this.sweep(now)
    const w = this.windows.get(key)
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 })
      return 0
    }
    w.count++
    return w.count > this.limit ? Math.ceil((w.start + this.windowMs - now) / 1000) : 0
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return
    this.lastSweep = now
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k)
  }
}
