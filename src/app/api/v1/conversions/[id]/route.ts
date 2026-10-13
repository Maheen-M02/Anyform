import { handle, json } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { deleteConversion, getOwnedJob, jobView } from '@/server/services/conversions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = handle<{ id: string }>(async ({ session }, { id }) =>
  json({ job: jobView(await getOwnedJob(getRuntime(), session.id, id)) }),
)

export const DELETE = handle<{ id: string }>(
  async ({ session }, { id }) => {
    await deleteConversion(getRuntime(), session.id, id)
    return new Response(null, { status: 204 })
  },
  { mutating: true },
)
