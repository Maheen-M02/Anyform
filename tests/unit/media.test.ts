import { describe, expect, it } from 'vitest'
import { formatFromFilename } from '@/lib/formats'
import { detectFormat, parseProbeJson } from '@/server/media/probe'
import { sanitizeDiagnostics } from '@/server/media/process'
import { sniffBytes } from '@/server/media/sniff'

const bytes = (s: string, prefix: number[] = []) => new Uint8Array([...prefix, ...Buffer.from(s, 'latin1')])

describe('sniffBytes (content, not extension)', () => {
  it('recognises ISO-BMFF (MP4/M4A/MOV) by box type', () => {
    expect(sniffBytes(bytes('ftypisom\0\0\0\0', [0, 0, 0, 0x20]))).toBe('isobmff')
    expect(sniffBytes(bytes('moov\0\0\0\0', [0, 0, 0, 8]))).toBe('isobmff')
  })
  it('recognises WAV', () => {
    expect(sniffBytes(bytes('RIFF\x24\0\0\0WAVEfmt '))).toBe('wav')
    expect(sniffBytes(bytes('RIFF\x24\0\0\0AVI LIST'))).toBe('avi')
  })
  it('recognises MP3', () => {
    expect(sniffBytes(bytes('ID3\x03\0\0\0'))).toBe('mp3')
    expect(sniffBytes(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3')
  })
  it('rejects unrelated data regardless of name', () => {
    expect(sniffBytes(bytes('This is a plain text file'))).toBeNull()
    expect(sniffBytes(new Uint8Array())).toBeNull()
  })
})

describe('detectFormat', () => {
  const mp4Demuxer = 'mov,mp4,m4a,3gp,3g2,mj2'
  it('uses the ISO brand to tell MP4, M4A and MOV apart', () => {
    expect(detectFormat(mp4Demuxer, 'isom')).toBe('mp4')
    expect(detectFormat(mp4Demuxer, 'mp42')).toBe('mp4')
    expect(detectFormat(mp4Demuxer, 'M4A ')).toBe('m4a')
    expect(detectFormat(mp4Demuxer, 'qt  ')).toBe('mov')
  })
  it('does not claim brands it does not support', () => {
    expect(detectFormat(mp4Demuxer, '3gp4')).toBeNull()
    expect(detectFormat(mp4Demuxer, null)).toBeNull()
  })
  it('detects WAV and MP3', () => {
    expect(detectFormat('wav', null)).toBe('wav')
    expect(detectFormat('mp3', null)).toBe('mp3')
    expect(detectFormat('matroska,webm', null)).toBe('mkv')
    expect(detectFormat('asf', null)).toBeNull()
  })
})

describe('parseProbeJson', () => {
  it('extracts audio and video streams with numeric fields', () => {
    const info = parseProbeJson(
      {
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 3.2, bit_rate: 128000, size: 1000, tags: { major_brand: 'isom' } },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360, disposition: { attached_pic: 0 }, sample_rate: null, bit_rate: null, duration: null, start_time: null },
          { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, channel_layout: 'stereo', sample_rate: 48000, bit_rate: 128000, duration: 3.2, start_time: 0, disposition: { default: 1 }, tags: { language: 'und' } },
          { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, sample_rate: 48000, bit_rate: null, duration: 3.2, start_time: 0.5, tags: { language: 'fra', title: 'Commentary' } },
        ],
      },
      'isobmff',
    )
    expect(info.format).toBe('mp4')
    expect(info.videoStreams).toHaveLength(1)
    expect(info.audioStreams.map((s) => [s.index, s.ordinal, s.isDefault, s.language])).toEqual([
      [1, 0, true, null],
      [2, 1, false, 'fra'],
    ])
    expect(info.audioStreams[1]!.title).toBe('Commentary')
    expect(info.audioStreams[1]!.decodable).toBeNull()
  })
})

describe('formatFromFilename', () => {
  it('is display-only and case-insensitive', () => {
    expect(formatFromFilename('Clip.MP4')).toBe('mp4')
    expect(formatFromFilename('song.wav')).toBe('wav')
    expect(formatFromFilename('archive.tar.gz')).toBe('tgz')
    expect(formatFromFilename('notes.docx')).toBeNull()
    expect(formatFromFilename('noext')).toBeNull()
  })
})

describe('sanitizeDiagnostics', () => {
  it('removes absolute paths from tool output', () => {
    const out = sanitizeDiagnostics('file:/var/lib/anyform/objects/uploads/upl_x: Invalid data\nC:\\data\\scratch\\job: error at 192 kb/s')
    expect(out).not.toContain('/var/lib')
    expect(out).not.toContain('C:\\data')
    expect(out).toContain('Invalid data')
    expect(out).toContain('kb/s')
  })
})

describe('sniffBytes for images, documents and archives', () => {
  const pad = (b: Uint8Array, n = 512) => {
    const out = new Uint8Array(n)
    out.set(b)
    return out
  }
  it('recognises every supported family by content', () => {
    expect(sniffBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png')
    expect(sniffBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(sniffBytes(bytes('GIF89a'))).toBe('gif')
    expect(sniffBytes(bytes('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffBytes(bytes('ftypavif\0\0\0\0', [0, 0, 0, 0x1c]))).toBe('avif')
    expect(sniffBytes(bytes('II*\0'))).toBe('tiff')
    expect(sniffBytes(bytes('%PDF-1.7\n'))).toBe('pdf')
    expect(sniffBytes(bytes('PK\x03\x04'))).toBe('zip')
    expect(sniffBytes(new Uint8Array([0x1f, 0x8b, 0x08, 0]))).toBe('gzip')
    const tar = pad(bytes('file.txt'))
    tar.set(Buffer.from('ustar'), 257)
    expect(sniffBytes(tar)).toBe('tar')
    expect(sniffBytes(bytes('fLaC'))).toBe('flac')
    expect(sniffBytes(bytes('OggS'))).toBe('ogg')
    expect(sniffBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe('matroska')
    expect(sniffBytes(bytes('RIFF\0\0\0\0AVI LIST'))).toBe('avi')
  })
  it('does not mistake an archive holding a PDF for a PDF', () => {
    expect(sniffBytes(pad(bytes('PK\x03\x04....%PDF-1.4 stored inside')))).toBe('zip')
  })
  it('tells WebM and Matroska apart from the EBML DocType', async () => {
    const { matroskaDocType } = await import('@/server/media/sniff')
    expect(matroskaDocType(bytes('\x1aE\xdf\xa3\x9fB\x86\x81\x01B\x82\x84webm'))).toBe('webm')
    expect(matroskaDocType(bytes('\x1aE\xdf\xa3\xa3B\x86\x81\x01B\x82\x88matroska'))).toBe('matroska')
    expect(detectFormat('matroska,webm', null, 'webm')).toBe('webm')
    expect(detectFormat('matroska,webm', null, 'matroska')).toBe('mkv')
    expect(detectFormat('flac', null)).toBe('flac')
    expect(detectFormat('avi', null)).toBe('avi')
  })
})
