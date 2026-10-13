import { z } from 'zod'
import { handle, json, parseJson } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { importFromUrl } from '@/server/services/uploads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ url: z.string().min(1).max(2048) }).strict()

/** Downloads a file from a public link (SSRF-protected) and stores it as an upload. */
export const POST = handle(
  async ({ req, session }) => {
    const { url } = await parseJson(req, body)
    return json({ upload: await importFromUrl(getRuntime(), session.id, url) }, { status: 201 })
  },
  { mutating: true, limiter: 'uploads' },
)
