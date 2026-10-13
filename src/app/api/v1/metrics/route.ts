import { timingSafeEqual } from 'node:crypto'
import { getConfig } from '@/server/config'
import { metrics } from '@/server/metrics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Prometheus metrics for this process. Disabled unless METRICS_TOKEN is configured. */
export function GET(req: Request) {
  const token = getConfig().metricsToken
  if (!token) return new Response('Not Found', { status: 404 })
  const given = Buffer.from(req.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return new Response('Unauthorized', { status: 401 })
  return new Response(metrics.render(), { headers: { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' } })
}
