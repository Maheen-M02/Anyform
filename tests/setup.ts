import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Each test file gets an isolated data directory and permissive local limits.
process.env.ANYFORM_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'anyform-test-'))
process.env.MIN_FREE_DISK_MB = '0'
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'
process.env.CLEANUP_INTERVAL_SECONDS = '3600'
process.env.RATE_LIMIT_UPLOADS_PER_HOUR = '1000'
process.env.RATE_LIMIT_REQUESTS_PER_MINUTE = '100000'
delete process.env.REDIS_URL
// Bundled by tests/global-setup.ts; set here too in case workers do not inherit it.
process.env.ANYFORM_SANDBOX_ENTRY ??= path.resolve(__dirname, '..', 'node_modules', '.cache', 'anyform-test', 'sandbox.mjs')
