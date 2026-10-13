import type { FormatId, FormatKind } from './formats'
import type { JobStatus, UploadStatus } from './states'

// Client-side mirrors of the API response shapes (kept free of server imports).

export interface AudioStream {
  index: number
  ordinal: number
  codec: string
  channels: number
  channelLayout: string | null
  sampleRate: number
  bitRate: number | null
  durationSec: number | null
  language: string | null
  title: string | null
  isDefault: boolean
  decodable: boolean | null
}

export interface Media {
  format: FormatId | null
  formatName: string
  durationSec: number | null
  audioStreams: AudioStream[]
  videoStreams: {
    index: number
    codec: string
    width: number | null
    height: number | null
    frameRate: number | null
    isAttachedPicture: boolean
    decodable: boolean | null
  }[]
}

interface InfoBase {
  format: FormatId | null
  sizeBytes: number
}

/** Mirror of the server's FileInfo: what the file really contains. */
export type FileInfo =
  | (InfoBase & { kind: 'av'; media: Media })
  | (InfoBase & { kind: 'image'; image: { format: FormatId; width: number; height: number; frames: number; hasAlpha: boolean; colorSpace: string | null } })
  | (InfoBase & { kind: 'pdf'; pdf: { pages: number; title: string | null; permissions: { copy: boolean; print: boolean } } })
  | (InfoBase & {
      kind: 'archive'
      archive: { format: FormatId | null; files: number; directories: number; skipped: number; unpackedBytes: number; encrypted: boolean }
    })

export type OptionField =
  | { key: string; label: string; type: 'select'; choices: { value: number | string; label: string }[]; default: number | string; help?: string }
  | { key: string; label: string; type: 'number'; min: number; max: number; placeholder?: string; unit?: string; help?: string }
  | { key: string; label: string; type: 'audioStream'; help?: string }

export interface OutputChoice {
  format: FormatId
  label: string
  kind: FormatKind
  sameFormat: boolean
  lossy: boolean
  notes: string[]
  options: OptionField[]
}

export interface Upload {
  id: string
  filename: string
  sizeBytes: number
  origin: { kind: 'file' } | { kind: 'url'; host: string }
  status: UploadStatus
  extensionFormat: FormatId | null
  expiresAt: number
  info: FileInfo | null
  error: ApiErrorBody | null
  outputs: OutputChoice[]
  warnings: string[]
}

export interface Job {
  id: string
  uploadId: string
  status: JobStatus
  progress: number | null
  inputName: string
  inputFormat: FormatId
  outputFormat: FormatId
  options: Record<string, unknown>
  error: ApiErrorBody | null
  output: { filename: string; format: FormatId; sizeBytes: number; durationSec: number | null; details: Record<string, string | number> } | null
  downloadUrl: string | null
  previewUrl: string | null
  createdAt: number
  finishedAt: number | null
  expiresAt: number | null
}

export interface Capabilities {
  inputs: FormatId[]
  conversions: { id: string; label: string; inputFormats: FormatId[]; outputFormat: FormatId; lossy: boolean }[]
  limits: { maxUploadBytes: number; maxDurationSeconds: number; uploadTtlMinutes: number; resultTtlMinutes: number }
}

export interface ApiErrorBody {
  code: string
  message: string
  requestId?: string
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
  }
}

const CSRF = { 'x-anyform-request': '1' }

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? (method === 'GET' ? {} : CSRF) : { ...CSRF, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('NETWORK', 'Could not reach ANYFORM. Check your connection and try again.', 0)
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = data?.error as ApiErrorBody | undefined
    throw new ApiError(err?.code ?? 'UNKNOWN', err?.message ?? 'Unexpected server response.', res.status, err?.requestId)
  }
  return data as T
}

export const api = {
  capabilities: () => request<Capabilities>('GET', '/api/v1/formats'),
  /** Asks the server to download a file from a public link. */
  importUrl: (url: string) => request<{ upload: Upload }>('POST', '/api/v1/imports', { url }).then((r) => r.upload),
  validate: (uploadId: string) => request<{ upload: Upload }>('POST', '/api/v1/validate', { uploadId }).then((r) => r.upload),
  convert: (uploadId: string, outputFormat: FormatId, options: Record<string, unknown>) =>
    request<{ job: Job }>('POST', '/api/v1/conversions', { uploadId, outputFormat, options }).then((r) => r.job),
  job: (id: string) => request<{ job: Job }>('GET', `/api/v1/conversions/${id}`).then((r) => r.job),
  cancel: (id: string) => request<{ job: Job }>('POST', `/api/v1/conversions/${id}/cancel`).then((r) => r.job),
  remove: (id: string) => request<void>('DELETE', `/api/v1/conversions/${id}`),
  history: () => request<{ jobs: Job[] }>('GET', '/api/v1/conversions').then((r) => r.jobs),

  /**
   * Streams the raw file to the server with real upload progress (XHR is the
   * only browser API that reports request-body progress).
   */
  upload(file: File, onProgress: (fraction: number) => void): { promise: Promise<Upload>; abort: () => void } {
    const xhr = new XMLHttpRequest()
    const promise = new Promise<Upload>((resolve, reject) => {
      xhr.open('POST', '/api/v1/uploads')
      xhr.setRequestHeader('x-anyform-request', '1')
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name))
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
      xhr.onload = () => {
        let data: { upload?: Upload; error?: ApiErrorBody } | null = null
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          // fall through
        }
        if (xhr.status === 201 && data?.upload) resolve(data.upload)
        else reject(new ApiError(data?.error?.code ?? 'UPLOAD_FAILED', data?.error?.message ?? 'The upload failed.', xhr.status, data?.error?.requestId))
      }
      xhr.onerror = () => reject(new ApiError('NETWORK', 'The upload was interrupted. Check your connection and try again.', 0))
      xhr.onabort = () => reject(new ApiError('ABORTED', 'Upload cancelled.', 0))
      xhr.send(file)
    })
    return { promise, abort: () => xhr.abort() }
  },
}
