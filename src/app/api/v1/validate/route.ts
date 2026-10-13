import { z } from 'zod'
import { handle, json, parseJson } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { validateUpload } from '@/server/services/uploads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ uploadId: z.string().min(1).max(64) }).strict()

export const POST = handle(
  async ({ req, session }) => {
    const { uploadId } = await parseJson(req, body)
    return json({ upload: await validateUpload(getRuntime(), session.id, uploadId) })
  },
  { mutating: true },
)
