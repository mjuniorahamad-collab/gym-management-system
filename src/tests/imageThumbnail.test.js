/**
 * THUMBNAIL GENERATION
 *
 * Photos are stored as base64 strings in Firestore, so the resize step is the
 * only thing standing between a 6 MB camera photo and a document that can never
 * be written (1 MiB cap, 300 KB enforced by the rules). These tests pin the
 * three behaviours that would otherwise fail silently:
 *
 *   - the longest side is capped and small images are NOT upscaled
 *   - a browser without WebP support is re-encoded as JPEG instead of leaving a
 *     PNG of a photo that blows the cap
 *   - the validation gate runs before anything is decoded
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { base64Bytes, makeThumbnail, MAX_SOURCE_BYTES, validateSourceFile } from '@/utils/image'

const file = (bytes = 1024, type = 'image/jpeg', name = 'photo.jpg') =>
  new File([new Uint8Array(bytes)], name, { type })

const WEBP = 'data:image/webp;base64,' + 'A'.repeat(400) // 300 bytes

describe('makeThumbnail', () => {
  let bitmap
  let drawImage
  let toDataURL
  let canvasEl
  let createImageBitmap

  beforeEach(() => {
    bitmap = { width: 1600, height: 1200, close: vi.fn() }
    createImageBitmap = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', createImageBitmap)

    drawImage = vi.fn()
    canvasEl = null
    // `function` (not an arrow) so `this` is the canvas the implementation was
    // called on, which is how the resulting dimensions are asserted.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      canvasEl = this
      return { drawImage }
    })
    toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(WEBP)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('caps the longest side and keeps the aspect ratio', async () => {
    const result = await makeThumbnail(file())

    expect(result.width).toBe(320)
    expect(result.height).toBe(240)
    expect(canvasEl.width).toBe(320)
    expect(canvasEl.height).toBe(240)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 320, 240)
    expect(result.contentType).toBe('image/webp')
    expect(result.dataUrl).toBe(WEBP)
    expect(result.bytes).toBe(300)
  })

  it('never upscales an image that is already small', async () => {
    bitmap.width = 200
    bitmap.height = 100

    const result = await makeThumbnail(file())

    expect(result.width).toBe(200)
    expect(result.height).toBe(100)
  })

  it('uses portrait orientation for a tall image', async () => {
    bitmap.width = 900
    bitmap.height = 1800

    const result = await makeThumbnail(file())

    expect(result.width).toBe(160)
    expect(result.height).toBe(320)
  })

  // toDataURL falls back to PNG when the browser has no WebP encoder. A PNG of
  // a photo is several times larger, so it must be re-encoded rather than kept.
  it('re-encodes as JPEG when the browser cannot produce WebP', async () => {
    const jpeg = 'data:image/jpeg;base64,' + 'B'.repeat(400)
    toDataURL.mockReturnValueOnce('data:image/png;base64,' + 'C'.repeat(400)).mockReturnValueOnce(jpeg)

    const result = await makeThumbnail(file())

    expect(result.contentType).toBe('image/jpeg')
    expect(result.dataUrl).toBe(jpeg)
    expect(toDataURL).toHaveBeenCalledTimes(2)
    expect(toDataURL.mock.calls[1][0]).toBe('image/jpeg')
  })

  it('releases the decoded bitmap so its pixels do not stay resident', async () => {
    await makeThumbnail(file())
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('rejects an unsupported type before decoding anything', async () => {
    await expect(makeThumbnail(file(1024, 'image/gif', 'a.gif'))).rejects.toThrow(/Unsupported image type/)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('rejects an oversized source before decoding anything', async () => {
    await expect(makeThumbnail(file(MAX_SOURCE_BYTES + 1))).rejects.toThrow(/too large/)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('fails loudly when the browser cannot give a 2d context', async () => {
    HTMLCanvasElement.prototype.getContext.mockReturnValue(null)
    await expect(makeThumbnail(file())).rejects.toThrow(/cannot resize images/)
  })

  it('passes the requested quality to the encoder', async () => {
    await makeThumbnail(file(), { quality: 0.5, maxPx: 128 })
    expect(toDataURL.mock.calls[0][1]).toBe(0.5)
    expect(canvasEl.width).toBe(128)
  })
})

describe('base64Bytes', () => {
  it('counts the payload, not the prefix', () => {
    expect(base64Bytes('data:image/webp;base64,AAAA')).toBe(3)
    expect(base64Bytes('')).toBe(0)
    expect(base64Bytes(null)).toBe(0)
  })
})

describe('validateSourceFile', () => {
  it('accepts only the formats the rules allow', () => {
    expect(validateSourceFile(file(10, 'image/jpeg'))).toBeNull()
    expect(validateSourceFile(file(10, 'image/png'))).toBeNull()
    expect(validateSourceFile(file(10, 'image/webp'))).toBeNull()
    expect(validateSourceFile(file(10, 'image/svg+xml'))).toMatch(/Unsupported image type/)
  })

  it('reports a missing file and an oversized one', () => {
    expect(validateSourceFile(null)).toBe('No file selected')
    expect(validateSourceFile(file(MAX_SOURCE_BYTES + 1))).toMatch(/Maximum size is 10 MB/)
  })
})
