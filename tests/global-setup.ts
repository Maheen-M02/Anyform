import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * Bundles the sandbox once, exactly as production does, so tests exercise the
 * real artifact (and avoid per-call TypeScript compilation).
 */
export default function setup() {
  const root = path.resolve(__dirname, '..')
  const out = path.join(root, 'node_modules', '.cache', 'anyform-test', 'sandbox.mjs')
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      'src/sandbox/cli.ts', '--bundle', '--platform=node', '--target=node20', '--format=esm',
      '--packages=external', `--outfile=${out}`, '--tsconfig=tsconfig.json', '--log-level=warning',
    ],
    { cwd: root, stdio: 'inherit' },
  )
  process.env.ANYFORM_SANDBOX_ENTRY = out
}
