import { existsSync } from 'node:fs'
import path from 'node:path'
import { getConfig } from './config'
import { AppError, ERROR_CODES, type ErrorCode } from './errors'
import { logger } from './logger'
import { minimalEnv, runTool, sanitizeDiagnostics, ToolError } from './media/process'

/**
 * How to start the sandbox process. Production uses the bundled
 * `dist/sandbox.mjs`; development runs the TypeScript source through tsx.
 * ANYFORM_SANDBOX_ENTRY overrides both (used by the test suite).
 */
function sandboxArgs(): string[] {
  const override = process.env.ANYFORM_SANDBOX_ENTRY
  if (override) return [override]
  const root = process.cwd()
  const bundled = path.join(/*turbopackIgnore: true*/ root, 'dist', 'sandbox.mjs')
  if (getConfig().isProduction || !existsSync(path.join(/*turbopackIgnore: true*/ root, 'src', 'sandbox', 'cli.ts'))) return [bundled]
  return ['--import', 'tsx', path.join(/*turbopackIgnore: true*/ root, 'src', 'sandbox', 'cli.ts')]
}

/** Whether the sandbox entry point exists (used by the readiness probe). */
export function sandboxAvailable(): boolean {
  const args = sandboxArgs()
  return existsSync(/*turbopackIgnore: true*/ args[args.length - 1]!)
}

export interface SandboxOptions {
  timeoutMs: number
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code)
}

/**
 * Runs one operation in a fresh sandbox process. The process is killed on
 * timeout or abort (ToolError kind 'timeout' / 'aborted' propagates).
 */
export async function runSandbox<T>(op: string, args: unknown, opts: SandboxOptions): Promise<T> {
  const cfg = getConfig()
  type Outcome = { ok: true; value: T } | { ok: false; code: string; message: string }
  // Held in an object so TypeScript does not narrow it across the callback.
  const state: { result: Outcome | null } = { result: null }
  try {
    await runTool(process.execPath, [`--max-old-space-size=${cfg.sandboxMemoryMb}`, ...sandboxArgs()], {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      input: JSON.stringify({ op, args }),
      env: minimalEnv({ NODE_ENV: cfg.isProduction ? 'production' : 'development', UV_THREADPOOL_SIZE: String(Math.max(2, cfg.ffmpegThreads)) }),
      onStdoutLine: (line) => {
        if (line.startsWith('@@progress ')) opts.onProgress?.(Number(line.slice(11)))
        else if (line.startsWith('@@result ')) state.result = { ok: true, value: JSON.parse(line.slice(9)) as T }
        else if (line.startsWith('@@error ')) state.result = { ok: false, ...(JSON.parse(line.slice(8)) as { code: string; message: string }) }
      },
    })
  } catch (err) {
    if (!(err instanceof ToolError) || err.kind !== 'exit' || !state.result) {
      if (err instanceof ToolError && err.kind === 'spawn') {
        throw new AppError('SERVICE_UNAVAILABLE', 'The processing sandbox could not be started.', { retryable: true })
      }
      if (err instanceof ToolError && err.kind === 'exit') {
        // Crashed without reporting (e.g. out of memory on a hostile file).
        logger.warn('sandbox crashed', { op, exitCode: err.exitCode, diagnostics: sanitizeDiagnostics(err.stderr) })
        throw new AppError('CORRUPT_MEDIA', 'This file could not be processed safely. It may be damaged or too complex.')
      }
      throw err
    }
  }
  const r = state.result
  if (!r) throw new AppError('INTERNAL_ERROR', 'The processing sandbox returned no result.', { retryable: true })
  if (r.ok) return r.value
  if (r.code === 'INTERNAL_ERROR' || !isErrorCode(r.code)) {
    logger.error('sandbox operation failed', { op, diagnostics: sanitizeDiagnostics(r.message) })
    throw new AppError('INTERNAL_ERROR', 'Something went wrong while processing this file.', { retryable: true })
  }
  throw new AppError(r.code, r.message)
}
