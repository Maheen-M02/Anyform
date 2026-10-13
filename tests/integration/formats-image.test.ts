import { beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { convertFails, convertOk, TestClient } from '../helpers/client'
import { ensureFixtures, fixture } from '../helpers/fixtures'

beforeAll(() => ensureFixtures())

const meta = (buf: Buffer) => sharp(buf).metadata()

describe('image detection', () => {
  it.each([
    ['alpha.png', 'png', 320, 200],
    ['rotated.jpg', 'jpg', 200, 300],
    ['photo.webp', 'webp', 320, 200],
    ['photo.avif', 'avif', 320, 200],
    ['photo.tiff', 'tiff', 320, 200],
    ['animated.gif', 'gif', 80, 60],
  ])('%s → %s %i×%i (orientation applied)', async (file, format, w, h) => {
    const { upload } = await new TestClient().prepare(fixture(file))
    expect(upload!.status).toBe('validated')
    expect(upload!.info).toMatchObject({ kind: 'image', format, image: { width: w, height: h } })
    // Every image can become every image format (including itself, for resizing) and PDF.
    expect(upload!.outputs.map((o) => o.format).sort()).toEqual(['avif', 'gif', 'jpg', 'pdf', 'png', 'tiff', 'webp'])
  })

  it('refuses decompression bombs before decoding', async () => {
    const { upload } = await new TestClient().prepare(fixture('huge-header.png'))
    expect(upload!.status).toBe('rejected')
    expect(upload!.error?.code).toBe('IMAGE_TOO_LARGE')
  })
})

describe('image conversions', () => {
  it.each(['jpg', 'webp', 'avif', 'gif', 'tiff', 'png'])('PNG → %s', async (format) => {
    const { job, data } = await convertOk(new TestClient(), fixture('alpha.png'), format)
    const m = await meta(data)
    expect(m.format === 'heif' ? 'avif' : m.format === 'jpeg' ? 'jpg' : m.format).toBe(format)
    expect([m.width, m.height]).toEqual([320, 200])
    expect(job.output?.details.dimensions).toBe('320×200')
  })

  it('PNG → JPG flattens transparency onto white', async () => {
    const { data } = await convertOk(new TestClient(), fixture('alpha.png'), 'jpg')
    expect((await meta(data)).hasAlpha).toBe(false)
    const { data: px } = await sharp(data).raw().toBuffer({ resolveWithObject: true })
    // 50 % blue over white is a light blue, not a dark one.
    expect(px[0]!).toBeGreaterThan(100)
  })

  it('applies EXIF orientation and strips metadata', async () => {
    const { data } = await convertOk(new TestClient(), fixture('rotated.jpg'), 'png')
    const m = await meta(data)
    expect([m.width, m.height]).toEqual([200, 300])
    expect(m.orientation).toBeUndefined()
    expect(m.exif).toBeUndefined()
  })

  it('WebP → PNG with resizing (aspect ratio kept)', async () => {
    const { data } = await convertOk(new TestClient(), fixture('photo.webp'), 'png', { width: 160 })
    const m = await meta(data)
    expect([m.format, m.width, m.height]).toEqual(['png', 160, 100])
  })

  it('PNG → PNG resizes in place and never enlarges', async () => {
    const small = await convertOk(new TestClient(), fixture('alpha.png'), 'png', { width: 100, height: 100 })
    const m = await meta(small.data)
    expect([m.width, m.height]).toEqual([100, 63])
    const big = await convertOk(new TestClient(), fixture('alpha.png'), 'png', { width: 5000 })
    expect((await meta(big.data)).width).toBe(320)
  })

  it('animated GIF → WebP stays animated; → PNG keeps the first frame', async () => {
    const anim = await convertOk(new TestClient(), fixture('animated.gif'), 'webp')
    expect((await sharp(anim.data, { animated: true }).metadata()).pages).toBe(10)
    expect(anim.job.output?.details.frames).toBe(10)
    const still = await convertOk(new TestClient(), fixture('animated.gif'), 'png')
    expect((await meta(still.data)).pages ?? 1).toBe(1)
  })

  it('AVIF → JPG and TIFF → WebP', async () => {
    expect((await meta((await convertOk(new TestClient(), fixture('photo.avif'), 'jpg')).data)).format).toBe('jpeg')
    expect((await meta((await convertOk(new TestClient(), fixture('photo.tiff'), 'webp')).data)).format).toBe('webp')
  })

  it('rejects invalid resize options', async () => {
    const r = await convertFails(new TestClient(), fixture('alpha.png'), 'png', { width: -5 })
    expect(r).toMatchObject({ stage: 'request', code: 'INVALID_OPTIONS' })
  })
})
