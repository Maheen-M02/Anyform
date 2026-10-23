import type { FormatId } from '@/lib/formats'
import type { FileInfo } from '../inspect/types'

export type RequiredTool = 'ffmpeg' | 'ffprobe' | 'sandbox'

/** Declarative description of an option, used by the API and UI to render controls. */
export type OptionField =
  | {
      key: string
      label: string
      type: 'select'
      choices: { value: number | string; label: string }[]
      default: number | string
      help?: string
    }
  | { key: string; label: string; type: 'number'; min: number; max: number; placeholder?: string; unit?: string; help?: string }
  | { key: string; label: string; type: 'audioStream'; help?: string }

export interface ConvertContext<O> {
  inputPath: string
  outputPath: string
  info: FileInfo
  options: O
  signal: AbortSignal
  timeoutMs: number
  /** Reports conversion progress in [0, 1]. Only call with reliable data. */
  onProgress: (fraction: number) => void
}

export interface VerifyContext<O> {
  outputPath: string
  info: FileInfo
  options: O
  signal: AbortSignal
  timeoutMs: number
}

/** One independent check that the output passed (failed checks throw instead). */
export interface VerificationCheck {
  label: string
  detail: string
}

export interface VerifiedOutput {
  /** Actual format produced (may differ from the plan target, e.g. a ZIP of rendered pages). */
  format: FormatId
  sizeBytes: number
  durationSec: number | null
  /** Facts about the output shown to the user (bitrate, dimensions, pages…). */
  details: Record<string, string | number>
  /** What was checked, in order, for the verification report. */
  checks: VerificationCheck[]
}

export interface ResourceEstimate {
  /** Rough upper bound for output size, used for disk-space admission. */
  outputBytes: number
  /** Rough CPU-seconds of work, used for logging. */
  cpuSeconds: number
}

/**
 * A single, directly executable conversion. Orchestration (jobs, storage,
 * retries, cancellation) never depends on a specific adapter.
 */
export interface ConversionAdapter<O = Record<string, unknown>> {
  id: string
  label: string
  inputFormats: readonly FormatId[]
  outputFormat: FormatId
  /** Same-format transforms (e.g. resizing a PNG) are allowed only when set. */
  allowSameFormat?: boolean
  /**
   * When false, this adapter is only ever the last step of a plan: its output
   * would make a poor input for further steps (e.g. a rendered page).
   */
  chainable?: boolean
  requiredTools: readonly RequiredTool[]
  /** True when information is discarded (e.g. lossy re-encoding). */
  lossy: boolean
  /** Limitations shown to users before they convert. */
  notes: readonly string[]
  optionFields(info: FileInfo | null): OptionField[]
  /** Throws an AppError when the input cannot be converted by this adapter. */
  validateInput(info: FileInfo): void
  /** Parses untrusted options into a typed value or throws INVALID_OPTIONS. */
  validateOptions(raw: unknown, info: FileInfo): O
  estimate(info: FileInfo, options: O): ResourceEstimate
  convert(ctx: ConvertContext<O>): Promise<void>
  /** Inspects the produced file; throws VERIFICATION_FAILED when unacceptable. */
  verifyOutput(ctx: VerifyContext<O>): Promise<VerifiedOutput>
}
