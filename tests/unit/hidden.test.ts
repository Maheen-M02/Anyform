import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { avHidden, dedupeHidden, formatPdfDate, hiddenItem, parseIso6709, removedHidden } from '@/server/inspect/hidden'
import { exifHidden, iptcHidden, pngTextHidden, xmpHidden } from '@/sandbox/exif'
import { convertImage, inspectImage } from '@/sandbox/images'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'anyform-hidden-'))

describe('audio/video tags', () => {
  it('reads phone locations in ISO 6709 and ignores toolchain stamps', () => {
    const items = avHidden([
      { key: 'location', value: '+37.7749-122.4194+010.000/', stream: null },
      { key: 'location-eng', value: '+37.7749-122.4194+010.000/', stream: null },
      { key: 'com.apple.quicktime.model', value: 'iPhone 15 Pro', stream: null },
      { key: 'encoder', value: 'Lavf61.7.100', stream: null },
      { key: 'major_brand', value: 'isom', stream: null },
      { key: 'title', value: 'SoundHandler', stream: 1 },
      { key: 'TITLE', value: 'Birthday', stream: null },
    ])
    expect(items).toEqual([
      hiddenItem('location', 'GPS location', '37.77490, -122.41940', 'high'),
      hiddenItem('device', 'Device model', 'iPhone 15 Pro', 'medium'),
      hiddenItem('description', 'Title', 'Birthday', 'low'),
    ])
  })

  it('parses ISO 6709 and rejects nonsense', () => {
    expect(parseIso6709('-33.8688+151.2093/')).toEqual({ lat: -33.8688, lon: 151.2093 })
    expect(parseIso6709('+95.0+10.0/')).toBeNull()
    expect(parseIso6709('somewhere')).toBeNull()
  })
})

describe('helpers', () => {
  it('formats PDF dates', () => {
    expect(formatPdfDate("D:20240102153000+01'00'")).toBe('2024-01-02 15:30')
    expect(formatPdfDate('D:2024')).toBe('2024-01-01')
  })

  it('truncates values, strips control characters and dedupes', () => {
    const long = hiddenItem('people', 'Author', `a\u0000b${'x'.repeat(500)}`, 'medium')
    expect(long.value.length).toBeLessThanOrEqual(120)
    expect(long.value.startsWith('a b')).toBe(true)
    const a = hiddenItem('people', 'Author', 'Jane', 'medium')
    expect(dedupeHidden([a, a, hiddenItem('people', 'Author', '', 'low')])).toEqual([a])
  })

  it('reports what an output no longer contains', () => {
    const gps = hiddenItem('location', 'GPS location', '1, 2', 'high')
    const sw = hiddenItem('software', 'Software', 'X', 'low')
    expect(removedHidden([gps, sw], [sw])).toEqual([gps])
  })
})

describe('image metadata', () => {
  it('finds GPS, camera, serial number and owner in EXIF, and conversion removes them all', async () => {
    const dir = tmp()
    const src = path.join(dir, 'gps.jpg')
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#486' } })
      .jpeg()
      .withExif({
        IFD0: { Make: 'Canon', Model: 'EOS R5', Artist: 'Jane Doe', Software: 'Lightroom 13' },
        IFD2: { DateTimeOriginal: '2024:05:01 10:20:30', BodySerialNumber: '0123456789' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 46/1 2964/100', GPSLongitudeRef: 'W', GPSLongitude: '122/1 25/1 948/100' },
      })
      .toFile(src)
    const { hidden } = await inspectImage(src, 1e8)
    const byLabel = Object.fromEntries(hidden.map((i) => [i.label, i]))
    expect(byLabel['GPS location']).toMatchObject({ risk: 'high', category: 'location' })
    // 37° 46′ 29.64″ N, 122° 25′ 9.48″ W
    expect(byLabel['GPS location']!.value).toBe('37.77490, -122.41930')
    expect(byLabel['Camera maker']!.value).toBe('Canon')
    expect(byLabel['Camera model']!.value).toBe('EOS R5')
    expect(byLabel['Artist']!.value).toBe('Jane Doe')
    expect(byLabel['Camera serial number']).toMatchObject({ value: '0123456789', risk: 'high' })
    expect(byLabel['Taken']!.value).toBe('2024:05:01 10:20:30')
    // High-risk items come first.
    expect(hidden[0]!.risk).toBe('high')

    const out = path.join(dir, 'clean.jpg')
    await convertImage({ input: src, output: out, format: 'jpg', quality: 90, animated: false, maxPixels: 1e8 })
    expect((await inspectImage(out, 1e8)).hidden).toEqual([])
  })

  it('survives malformed EXIF blocks', () => {
    expect(exifHidden(Buffer.from('Exif\0\0MM\0*\0\0\0\x08\xff\xff', 'latin1'))).toEqual([])
    expect(exifHidden(Buffer.alloc(3))).toEqual([])
    // An IFD whose entry points far outside the block.
    const tiff = Buffer.alloc(26)
    tiff.write('II', 0, 'latin1')
    tiff.writeUInt16LE(42, 2)
    tiff.writeUInt32LE(8, 4)
    tiff.writeUInt16LE(1, 8)
    tiff.writeUInt16LE(0x010f, 10)
    tiff.writeUInt16LE(2, 12)
    tiff.writeUInt32LE(40, 14)
    tiff.writeUInt32LE(0xfffffff0, 18)
    expect(exifHidden(tiff)).toEqual([])
  })

  it('reads XMP edit history, IPTC by-lines and PNG text chunks', () => {
    const xmp = Buffer.from(
      '<x:xmpmeta><rdf:RDF><rdf:Description xmp:CreatorTool="Adobe Photoshop 25.0" xmpMM:OriginalDocumentID="xmp.did:abc">' +
        '<dc:creator><rdf:Seq><rdf:li>Jane &amp; Co</rdf:li></rdf:Seq></dc:creator>' +
        '<xmpMM:History><rdf:Seq><rdf:li stEvt:action="created"/><rdf:li stEvt:action="saved"/></rdf:Seq></xmpMM:History>' +
        '</rdf:Description></rdf:RDF></x:xmpmeta>',
    )
    const labels = xmpHidden(xmp).map((i) => `${i.label}=${i.value}`)
    expect(labels).toEqual(
      expect.arrayContaining(['Creator=Jane & Co', 'Editing software=Adobe Photoshop 25.0', 'Original document ID=xmp.did:abc', 'Edit history=2 recorded editing steps']),
    )

    const name = Buffer.from('Jane Doe')
    const iptc = Buffer.concat([Buffer.from([0x1c, 0x02, 80, 0, name.length]), name, Buffer.from([0x1c, 0x02, 90, 0, 5]), Buffer.from('Paris')])
    expect(iptcHidden(iptc).map((i) => i.label)).toEqual(['By-line', 'City'])
    // A length running past the end stops the scan instead of over-reading.
    expect(iptcHidden(Buffer.from([0x1c, 0x02, 80, 0x7f, 0xff, 0x41]))).toEqual([])

    expect(pngTextHidden([{ keyword: 'parameters', text: 'a cat, steps: 30' }, { keyword: 'Author', text: 'Jane' }]).map((i) => i.label)).toEqual([
      'Generation settings',
      'Author',
    ])
  })
})
