import { z } from 'zod'
import { handle, json, parseJson } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { createConversion, listConversions } from '@/server/services/conversions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z
  .object({
    uploadId: z.string().min(1).max(64),
    outputFormat: z.string().min(1).max(16),
    options: z.record(z.string(), z.union([z.string().max(64), z.number(), z.boolean()])).optional(),
  })
  .strict()

export const POST = handle(
  async ({ req, session }) => {
    const input = await parseJson(req, body)
    const { job, created } = await createConversion(getRuntime(), session.id, input)
    return json({ job, created }, { status: created ? 202 : 200 })
  },
  { mutating: true },
)

/** Conversion history for the current session. */
export const GET = handle(async ({ session }) => json({ jobs: await listConversions(getRuntime(), session.id) }))
