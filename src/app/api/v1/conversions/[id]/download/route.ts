import { handle } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { downloadConversion } from '@/server/services/conversions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Streams the output to its owner. Add ?inline=1 for in-browser preview. */
export const GET = handle<{ id: string }>(async ({ req, session }, { id }) => downloadConversion(getRuntime(), session.id, id, req))
