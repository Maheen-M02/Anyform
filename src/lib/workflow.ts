import type { ApiErrorBody, Job, Upload } from './api'
import type { DestinationInput, DestinationTarget } from './destinations'
import type { FormatId } from './formats'

/** Facts about the locally selected file, known before any upload. */
export interface LocalFile {
  name: string
  /** Unknown (0) for links until the server has downloaded the file. */
  size: number
  type: string
  source: 'file' | 'url'
}

/**
 * The converter workflow as an explicit state machine. Upload, validation,
 * conversion and result data live in separate phases so impossible
 * combinations (e.g. a result without a job) cannot be represented.
 */
export type Workflow =
  | { phase: 'idle' }
  /** progress is null while the server downloads a link (no reliable progress). */
  | { phase: 'uploading'; file: LocalFile; progress: number | null }
  | { phase: 'validating'; file: LocalFile; upload: Upload }
  | { phase: 'rejected'; file: LocalFile; upload: Upload | null; error: ApiErrorBody }
  | { phase: 'ready'; file: LocalFile; upload: Upload }
  | { phase: 'submitting'; file: LocalFile; upload: Upload }
  | { phase: 'converting'; file: LocalFile; upload: Upload; job: Job }
  | { phase: 'completed'; file: LocalFile; upload: Upload; job: Job }
  | { phase: 'failed'; file: LocalFile; upload: Upload; job: Job | null; error: ApiErrorBody }

export type WorkflowEvent =
  | { type: 'FILE_SELECTED'; file: LocalFile }
  | { type: 'UPLOAD_PROGRESS'; progress: number }
  | { type: 'UPLOADED'; upload: Upload }
  | { type: 'UPLOAD_FAILED'; error: ApiErrorBody }
  | { type: 'VALIDATED'; upload: Upload }
  | { type: 'SUBMIT' }
  | { type: 'SUBMIT_FAILED'; error: ApiErrorBody }
  | { type: 'JOB_UPDATED'; job: Job }
  | { type: 'RETRY' }
  | { type: 'RESET' }

export const initialWorkflow: Workflow = { phase: 'idle' }

export function workflowReducer(state: Workflow, event: WorkflowEvent): Workflow {
  switch (event.type) {
    case 'RESET':
      return initialWorkflow
    case 'FILE_SELECTED':
      // A new file may replace the current one unless work is in flight.
      if (state.phase === 'submitting' || state.phase === 'converting') return state
      return { phase: 'uploading', file: event.file, progress: event.file.source === 'url' ? null : 0 }
    case 'UPLOAD_PROGRESS':
      return state.phase === 'uploading' ? { ...state, progress: event.progress } : state
    case 'UPLOADED':
      return state.phase === 'uploading' ? { phase: 'validating', file: state.file, upload: event.upload } : state
    case 'UPLOAD_FAILED':
      if (state.phase === 'uploading' || state.phase === 'validating') {
        return { phase: 'rejected', file: state.file, upload: state.phase === 'validating' ? state.upload : null, error: event.error }
      }
      return state
    case 'VALIDATED':
      if (state.phase !== 'validating') return state
      if (event.upload.status === 'validated' && event.upload.outputs.length > 0) {
        return { phase: 'ready', file: state.file, upload: event.upload }
      }
      return {
        phase: 'rejected',
        file: state.file,
        upload: event.upload,
        error: event.upload.error ?? { code: 'UNSUPPORTED_CONVERSION', message: 'No conversions are available for this file.' },
      }
    case 'SUBMIT':
      return state.phase === 'ready' ? { phase: 'submitting', file: state.file, upload: state.upload } : state
    case 'SUBMIT_FAILED':
      return state.phase === 'submitting' ? { phase: 'failed', file: state.file, upload: state.upload, job: null, error: event.error } : state
    case 'JOB_UPDATED': {
      if (state.phase !== 'submitting' && state.phase !== 'converting') return state
      const { job } = event
      if (job.status === 'completed') return { phase: 'completed', file: state.file, upload: state.upload, job }
      if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') {
        const error =
          job.error ??
          (job.status === 'cancelled'
            ? { code: 'CANCELLED', message: 'The conversion was cancelled.' }
            : { code: 'RESULT_EXPIRED', message: 'This result has expired.' })
        return { phase: 'failed', file: state.file, upload: state.upload, job, error }
      }
      return { phase: 'converting', file: state.file, upload: state.upload, job }
    }
    case 'RETRY':
      // Back to settings with the same validated upload (if it is still valid).
      if (state.phase === 'failed' || state.phase === 'completed') return { phase: 'ready', file: state.file, upload: state.upload }
      return state
  }
}

export interface ConversionSettings {
  format: FormatId | null
  options: Record<string, number | string>
  /** Destination preset the settings came from; cleared as soon as they are edited by hand. */
  destination: string | null
}

/** Default settings for a freshly validated upload. */
export function defaultSettings(upload: Upload): ConversionSettings {
  const first = upload.outputs[0]
  if (!first) return { format: null, options: {}, destination: null }
  return { format: first.format, options: defaultOptions(upload, first.format), destination: null }
}

/** Settings for a destination target: the format's defaults overridden by the preset. */
export function destinationSettings(upload: Upload, id: string, target: DestinationTarget): ConversionSettings {
  return { format: target.format, options: { ...defaultOptions(upload, target.format), ...target.options }, destination: id }
}

/** What destinations need to know about an upload, or null for files they do not apply to. */
export function destinationInput(upload: Upload): DestinationInput | null {
  const info = upload.info
  if (!info) return null
  switch (info.kind) {
    case 'av': {
      const hasVideo = info.media.videoStreams.some((v) => !v.isAttachedPicture)
      return {
        kind: hasVideo ? 'video' : 'audio',
        durationSec: info.media.durationSec,
        hasAudio: info.media.audioStreams.some((s) => s.decodable !== false),
        hasAlpha: false,
        animated: false,
      }
    }
    case 'image':
      return { kind: 'image', durationSec: null, hasAudio: false, hasAlpha: info.image.hasAlpha, animated: info.image.frames > 1 && (info.image.format === 'gif' || info.image.format === 'webp') }
    case 'pdf':
      return { kind: 'pdf', durationSec: null, hasAudio: false, hasAlpha: false, animated: false }
    case 'archive':
      return null
  }
}

/**
 * The output that removes hidden data while keeping the file as it is: a
 * clean copy for audio/video/PDF, a same-format re-save for images.
 */
export function cleanSettings(upload: Upload): ConversionSettings | null {
  const choice =
    upload.outputs.find((o) => o.adapterIds[0]?.startsWith('clean-')) ??
    (upload.info?.kind === 'image' ? upload.outputs.find((o) => o.sameFormat) : undefined)
  if (!choice) return null
  const options = defaultOptions(upload, choice.format)
  if (choice.options.some((f) => f.key === 'quality')) options.quality = 'high'
  return { format: choice.format, options, destination: null }
}

export function defaultOptions(upload: Upload, format: FormatId): Record<string, number | string> {
  const choice = upload.outputs.find((o) => o.format === format)
  const options: Record<string, number | string> = {}
  for (const field of choice?.options ?? []) {
    if (field.type === 'select') options[field.key] = field.default
    if (field.type === 'number') options[field.key] = ''
    if (field.type === 'audioStream') {
      const usable = upload.info?.kind === 'av' ? upload.info.media.audioStreams.filter((s) => s.decodable !== false) : []
      const preferred = usable.find((s) => s.isDefault) ?? usable[0]
      if (preferred) options[field.key] = preferred.index
    }
  }
  return options
}
