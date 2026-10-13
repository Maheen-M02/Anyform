import { getConfig } from './config'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

/** Keys whose values must never reach the logs. */
const REDACT = /token|secret|password|authorization|cookie|signature|url$/i

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    if (REDACT.test(k)) out[k] = '[redacted]'
    else if (v instanceof Error) out[k] = { name: v.name, message: v.message }
    else out[k] = v
  }
  return out
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

function make(base: Record<string, unknown>): Logger {
  const emit = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < ORDER[getConfig().logLevel]) return
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...scrub({ ...base, ...fields }) })
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => make({ ...base, ...f }),
  }
}

export const logger = make({ service: 'anyform' })
