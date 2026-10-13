import { handle, json } from '@/server/http'
import { getRuntime } from '@/server/runtime'
import { getOwnedUpload, uploadView } from '@/server/services/uploads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = handle<{ id: string }>(async ({ session }, { id }) => {
  const rt = getRuntime()
  return json({ upload: uploadView(rt, await getOwnedUpload(rt, session.id, id)) })
})
