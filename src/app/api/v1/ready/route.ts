import { checkReadiness } from '@/server/readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Readiness: dependencies (FFmpeg, storage, metadata store) are usable. */
export async function GET() {
  const report = await checkReadiness()
  return Response.json(report, { status: report.ready ? 200 : 503, headers: { 'cache-control': 'no-store' } })
}
