export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Liveness: the process is up and serving requests. */
export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } })
}
