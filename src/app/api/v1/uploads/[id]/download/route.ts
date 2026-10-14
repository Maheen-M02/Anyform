import { handle } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { downloadOriginal } from '@/server/services/uploads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The original (validated) file, as uploaded or imported. Add ?inline=1 for preview. */
export const GET = handle<{ id: string }>(async ({ req, session }, { id }) => downloadOriginal(getRuntime(), session.id, id, req))
