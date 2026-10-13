import { FORMATS } from '@/lib/formats'
import { handle, json } from '@/server/http'
import { getConfig } from '@/server/config'
import { registry } from '@/server/conversions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Registered conversion capabilities. Only implemented, tested adapters appear here. */
export const GET = handle(async () => {
  const cfg = getConfig()
  const adapters = registry.list()
  const inputs = [...new Set(adapters.flatMap((a) => a.inputFormats))]
  return json({
    formats: Object.values(FORMATS),
    inputs,
    conversions: adapters.map((a) => ({
      id: a.id,
      label: a.label,
      inputFormats: a.inputFormats,
      outputFormat: a.outputFormat,
      lossy: a.lossy,
      notes: a.notes,
      options: a.optionFields(null),
    })),
    limits: {
      maxUploadBytes: cfg.maxUploadBytes,
      maxDurationSeconds: cfg.maxDurationSeconds,
      uploadTtlMinutes: Math.round(cfg.uploadTtlMs / 60_000),
      resultTtlMinutes: Math.round(cfg.resultTtlMs / 60_000),
    },
  })
})
