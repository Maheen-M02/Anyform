import { spawn } from 'node:child_process'

export class ToolError extends Error {
  constructor(
    readonly kind: 'spawn' | 'exit' | 'timeout' | 'aborted',
    message: string,
    readonly stderr = '',
    readonly exitCode: number | null = null,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

/**
 * Environment for child processes that handle untrusted input: enough to run,
 * nothing secret (no SESSION_SECRET, REDIS_URL, tokens…).
 */
export function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR', 'LANG', 'LC_ALL'])
  const env: Record<string, string> = {}
  // Iterate real keys: Windows variable names are case-insensitive (Path vs PATH).
  for (const [k, v] of Object.entries(process.env)) if (keep.has(k.toUpperCase()) && v !== undefined) env[k] = v
  return { ...env, ...extra } as NodeJS.ProcessEnv
}

export interface RunOptions {
  timeoutMs: number
  /** Data written to the child's stdin (stdin is closed afterwards). */
  input?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Stdout is buffered up to this many bytes (default 8 MiB); excess is discarded. */
  maxStdoutBytes?: number
  /** Called for every complete stdout line. When set, stdout is not buffered. */
  onStdoutLine?: (line: string) => void
}

export interface RunResult {
  stdout: string
  stderr: string
}

const STDERR_TAIL_BYTES = 16 * 1024

/**
 * Runs an executable with an argument array (never through a shell), enforcing a
 * wall-clock timeout and honouring an AbortSignal by killing the process.
 */
export function runTool(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ToolError('aborted', `${cmd} aborted before start`))
      return
    }
    const child = spawn(cmd, args, {
      shell: false,
      windowsHide: true,
      env: opts.env ?? minimalEnv(),
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined)
      child.stdin.end(opts.input)
    }
    const maxStdout = opts.maxStdoutBytes ?? 8 * 1024 * 1024
    let stdout = ''
    let stdoutBytes = 0
    let lineBuf = ''
    let stderr = ''
    let settled = false
    let reason: 'timeout' | 'aborted' | null = null

    const kill = (why: 'timeout' | 'aborted') => {
      if (reason) return
      reason = why
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs)
    const onAbort = () => kill('aborted')
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      if (opts.onStdoutLine) {
        lineBuf += chunk
        let nl: number
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          opts.onStdoutLine(lineBuf.slice(0, nl).trimEnd())
          lineBuf = lineBuf.slice(nl + 1)
        }
        return
      }
      if (stdoutBytes < maxStdout) stdout += chunk
      stdoutBytes += chunk.length
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES)
    })

    child.on('error', (err) => finish(() => reject(new ToolError('spawn', `${cmd} could not be started: ${err.message}`))))
    child.on('close', (code) => {
      if (opts.onStdoutLine && lineBuf) opts.onStdoutLine(lineBuf.trimEnd())
      finish(() => {
        if (reason === 'timeout') reject(new ToolError('timeout', `${cmd} timed out`, stderr, code))
        else if (reason === 'aborted') reject(new ToolError('aborted', `${cmd} was cancelled`, stderr, code))
        else if (code !== 0) reject(new ToolError('exit', `${cmd} exited with code ${code}`, stderr, code))
        else resolve({ stdout, stderr })
      })
    })
  })
}

/** Removes absolute paths from tool diagnostics before they are logged. */
export function sanitizeDiagnostics(text: string): string {
  return text
    .replace(/(?:file:)?(?:[A-Za-z]:)?(?:[\\/][^\s'":\\/]+){2,}/g, '<path>')
    .split('\n')
    .slice(-20)
    .join('\n')
    .slice(0, 2000)
}
