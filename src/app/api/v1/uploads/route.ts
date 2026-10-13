import { handle, json } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { receiveUpload } from '@/server/services/uploads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Receives raw file bytes (not multipart). The original name is sent URL-encoded in X-File-Name. */
export const POST = handle(
  async ({ req, session }) => json({ upload: await receiveUpload(getRuntime(), session.id, req) }, { status: 201 }),
  { mutating: true, limiter: 'uploads' },
)
