/**
 * Sandbox process for parsing untrusted images, PDFs and archives.
 *
 * Runs as a separate, killable Node process with a capped heap and a minimal
 * environment (no secrets). Reads one JSON request from stdin and reports on
 * stdout using a line protocol:
 *   @@progress <0..1>
 *   @@result <json>
 *   @@error <json {code, message}>
 * Library chatter on console.* is redirected to stderr so it cannot corrupt
 * the protocol.
 */
import { convertArchive, inspectArchive } from './archives'
import { SandboxError } from './errors'
import { convertImage, inspectImage } from './images'
import { cleanPdf, countPdfPages, imagesToPdf, inspectPdf, pdfToImages, pdfToText } from './pdf'

const out = process.stdout.write.bind(process.stdout)
for (const method of ['log', 'info', 'warn', 'debug'] as const) {
  console[method] = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')
}

const progress = (fraction: number) => out(`@@progress ${Math.max(0, Math.min(1, fraction)).toFixed(4)}\n`)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OPS: Record<string, (args: any) => Promise<unknown>> = {
  'inspect-image': (a) => inspectImage(a.path, a.maxPixels),
  'convert-image': (a) => convertImage(a),
  'inspect-pdf': (a) => inspectPdf(a.path, a.maxPages),
  'pdf-pages': (a) => countPdfPages(a.path),
  'pdf-to-text': (a) => pdfToText(a.input, a.output, progress),
  'pdf-to-images': (a) => pdfToImages(a, progress),
  'images-to-pdf': (a) => imagesToPdf(a, progress),
  'clean-pdf': (a) => cleanPdf(a),
  'inspect-archive': (a) => inspectArchive(a.path, a.family, a.limits),
  'convert-archive': (a) => convertArchive(a, progress),
}

async function readStdin(): Promise<string> {
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  return data
}

async function main() {
  const { op, args } = JSON.parse(await readStdin()) as { op: string; args: unknown }
  const fn = OPS[op]
  if (!fn) throw new SandboxError('INTERNAL_ERROR', `Unknown sandbox operation: ${op}`)
  const result = await fn(args)
  out(`@@result ${JSON.stringify(result ?? null)}\n`)
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const payload =
      err instanceof SandboxError
        ? { code: err.code, message: err.message }
        : { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) }
    out(`@@error ${JSON.stringify(payload)}\n`, () => process.exit(2))
  })
