import { handle, json } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { cancelConversion } from '@/server/services/conversions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = handle<{ id: string }>(
  async ({ session }, { id }) => json({ job: await cancelConversion(getRuntime(), session.id, id) }),
  { mutating: true },
)
