import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '@/server/config'
import { inspectArchive } from '@/sandbox/archives'
import { convertFails, convertOk, TestClient } from '../helpers/client'
import { ensureFixtures, fixture } from '../helpers/fixtures'

beforeAll(() => ensureFixtures())

function saveTemp(buf: Buffer, name: string) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'anyform-out-')), name)
  writeFileSync(file, buf)
  return file
}

const limits = { maxEntries: 1000, maxUnpackedBytes: 1e9 }

describe('PDF', () => {
  it('is inspected for pages, title and permissions', async () => {
    const { upload } = await new TestClient().prepare(fixture('text.pdf'))
    expect(upload!.info).toMatchObject({ kind: 'pdf', format: 'pdf', pdf: { pages: 3, title: 'ANYFORM fixture', permissions: { copy: true, print: true } } })
    expect(upload!.outputs.map((o) => o.format).sort()).toEqual(['jpg', 'pdf', 'png', 'txt'])
  })

  it('PDF → TXT extracts the text of every page', async () => {
    const { job, data, headers } = await convertOk(new TestClient(), fixture('text.pdf'), 'txt')
    const text = data.toString('utf8')
    for (const n of [1, 2, 3]) expect(text).toContain(`ANYFORM test document page ${n}`)
    expect(text).toContain('quick brown fox')
    expect(job.output?.details.pages).toBe(3)
    expect(headers.get('content-type')).toContain('text/plain')
  })

  it('PDF → TXT explains when a PDF has no text (scanned)', async () => {
    const r = await convertFails(new TestClient(), fixture('scanned.pdf'), 'txt')
    expect(r).toMatchObject({ stage: 'job', code: 'NO_TEXT_CONTENT', status: 'failed' })
  })

  it('PDF → PNG renders the first page at the chosen DPI', async () => {
    const { data, job } = await convertOk(new TestClient(), fixture('text.pdf'), 'png', { dpi: 72 })
    const m = await sharp(data).metadata()
    expect([m.format, m.width, m.height]).toEqual(['png', 612, 792])
    expect(job.output?.format).toBe('png')
  })

  it('PDF → JPG with all pages produces a verified ZIP', async () => {
    const { data, job } = await convertOk(new TestClient(), fixture('text.pdf'), 'jpg', { pages: 'all', dpi: 72 })
    expect(job.output?.format).toBe('zip')
    expect(job.output?.filename).toBe('text.zip')
    const info = await inspectArchive(saveTemp(data, 'pages.zip'), 'zip', limits)
    expect(info.files).toBe(3)
  })
})

describe('images → PDF', () => {
  it('PNG → PDF (A4)', async () => {
    const { job, data } = await convertOk(new TestClient(), fixture('alpha.png'), 'pdf', { pageSize: 'a4' })
    expect(data.subarray(0, 5).toString()).toBe('%PDF-')
    expect(job.output?.details.pages).toBe(1)
  })

  it('animated GIF → PDF gives one page per frame', async () => {
    const { job } = await convertOk(new TestClient(), fixture('animated.gif'), 'pdf')
    expect(job.output?.details.pages).toBe(10)
  })

  it('a converted PDF can be converted again (round trip)', async () => {
    const pdf = await convertOk(new TestClient(), fixture('photo.webp'), 'pdf')
    const again = await convertOk(new TestClient(), saveTemp(pdf.data, 'roundtrip.pdf'), 'png', { dpi: 72 })
    expect((await sharp(again.data).metadata()).format).toBe('png')
  })
})

describe('archives', () => {
  afterEach(() => {
    delete process.env.MAX_ARCHIVE_UNPACKED_MB
    resetConfig()
  })

  it.each([
    ['bundle.zip', 'tgz', 'gzip'],
    ['bundle.zip', 'tar', 'tar'],
    ['bundle.tar', 'zip', 'zip'],
    ['bundle.tar.gz', 'zip', 'zip'],
    ['bundle.tar.gz', 'tar', 'tar'],
  ] as const)('%s → %s preserves every file byte-for-byte', async (file, format, family) => {
    const { upload, job, data } = await convertOk(new TestClient(), fixture(file), format)
    const src = upload.info!.kind === 'archive' ? upload.info!.archive : null
    const out = await inspectArchive(saveTemp(data, `out.${format === 'tgz' ? 'tar.gz' : format}`), family, limits)
    expect(out.files).toBe(src!.files)
    expect(out.unpackedBytes).toBe(src!.unpackedBytes)
    expect(job.output?.details.files).toBe(4) // the fixture holds 4 files and 1 folder
  })

  it('skips symbolic links and says so', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('bundle.tar.gz'))
    expect(upload!.warnings.join(' ')).toMatch(/1 special entry/)
    const { job } = await convertOk(client, fixture('bundle.tar.gz'), 'zip')
    expect(job.output?.details.skipped).toBe(1)
  })

  it('rejects archives with path traversal entries', async () => {
    const { upload } = await new TestClient().prepare(fixture('traversal.zip'))
    expect(upload!.status).toBe('rejected')
    expect(upload!.error?.code).toBe('UNSAFE_ARCHIVE')
  })

  it('rejects encrypted archives', async () => {
    const { upload } = await new TestClient().prepare(fixture('encrypted.zip'))
    expect(upload!.error?.code).toBe('PROTECTED_FILE')
  })

  it('recognises Office documents instead of treating them as ZIPs', async () => {
    const { upload } = await new TestClient().prepare(fixture('document.docx'))
    expect(upload!.status).toBe('rejected')
    expect(upload!.error?.message).toMatch(/Office document/)
  })

  it('rejects plain gzip files that are not tar archives', async () => {
    const { upload } = await new TestClient().prepare(fixture('plain.gz'))
    expect(upload!.status).toBe('rejected')
    expect(upload!.error?.message).toMatch(/tar\.gz/)
  })

  it('stops zip bombs at the unpacked-size limit', async () => {
    process.env.MAX_ARCHIVE_UNPACKED_MB = '1'
    resetConfig()
    const { upload } = await new TestClient().prepare(fixture('bomb.zip'))
    expect(upload!.status).toBe('rejected')
    expect(upload!.error?.code).toBe('ARCHIVE_LIMIT')
  })
})
