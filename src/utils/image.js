/**
 * Client-side thumbnail generation.
 *
 * WHY THIS EXISTS
 *   Cloud Storage for Firebase needs a billing plan this project does not have,
 *   so photos are stored as small base64 thumbnails inside Firestore documents.
 *   A camera photo is 2-8 MB; an avatar is rendered at 36-128 CSS pixels, so the
 *   original bytes are both unaffordable (a Firestore document is capped at
 *   1 MiB) and unnecessary.
 *
 *   Resizing here also keeps the security story simple: no third-party host, no
 *   public object URL, and no download token that would outlive the access
 *   decision that granted it.
 *
 * WHAT IT IS NOT
 *   An image editor. One square-preserving downscale, one encode. No cropping,
 *   no EXIF handling (the canvas drops metadata), no dependency.
 */

/**
 * Formats we will ATTEMPT to decode. Everything that survives decoding is
 * re-encoded to WebP/JPEG on a canvas, so this list is about what the picker may
 * hand us, not about what gets stored (`image/heic` never reaches Firestore).
 *
 * HEIC/HEIF are here because the iPhone camera roll serves them: Safari decodes
 * them and the canvas converts them to JPEG, which is the whole point. Browsers
 * that cannot decode HEIC (Chrome, Firefox) still pass this gate and fail in
 * `decode` with an instruction the operator can act on, instead of "unsupported
 * image type" for a file the phone itself produced.
 */
export const ALLOWED_SOURCE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]

const HEIC_SOURCE_TYPES = ['image/heic', 'image/heif']

/**
 * True for a HEIC/HEIF upload. The extension is checked as well as the type:
 * iOS and the Files app occasionally hand over a HEIC with an empty or generic
 * MIME type, and a `.HEIC` name is the only remaining evidence.
 */
function isHeicSource(file) {
  const type = String(file?.type || '').toLowerCase()
  const name = String(file?.name || '').toLowerCase()
  return HEIC_SOURCE_TYPES.includes(type) || /\.hei[cf]$/.test(name)
}

/** What to tell someone whose browser cannot open the iPhone's own format. */
export const HEIC_DECODE_MESSAGE =
  'This iPhone photo is in HEIC, which this browser cannot convert. Change Camera → Formats to "Most Compatible", or export/pick a JPG.'

/** Refuse a source file this large before decoding it in memory. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024

/** Mirrors the cap enforced in firestore.rules on the stored string. */
export const MAX_STORED_BYTES = 300 * 1024

/** 128px is the largest avatar the UI renders, so 320px covers 2x displays. */
export const THUMBNAIL_MAX_PX = 320
export const THUMBNAIL_QUALITY = 0.75

/**
 * Returns a human-readable reason the file will be rejected, or null.
 *
 * UX affordance only, exactly like `validateImageFile` in services/storage.js:
 * the browser cannot be the boundary, so the same limits are re-checked where
 * the bytes land (firestore.rules for the stored string).
 */
export function validateSourceFile(file) {
  if (!file) return 'No file selected'
  // iOS sometimes hands over a HEIC with no MIME type (or the generic one), and
  // the `.HEIC` name is the only evidence left. Accepting it here is not a
  // loophole: `decode` still refuses a file it cannot actually read.
  const genericType = !file.type || file.type === 'application/octet-stream'
  const heicByName = genericType && isHeicSource(file)
  if (!ALLOWED_SOURCE_TYPES.includes(file.type) && !heicByName) {
    return `Unsupported image type. Use ${ALLOWED_SOURCE_TYPES.join(', ')}`
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return `Image is too large. Maximum size is ${Math.floor(MAX_SOURCE_BYTES / (1024 * 1024))} MB`
  }
  return null
}

/** Byte length of a base64 data URL's payload (base64 is ASCII: 4 chars = 3 bytes). */
export function base64Bytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4)
}

/**
 * Decodes a File into something drawable.
 *
 * `createImageBitmap` is the fast path; Safari and older browsers fall back to
 * an <img> element. The object URL is revoked as soon as the decode resolves, so
 * a failed decode cannot leak a blob for the lifetime of the document.
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through to the <img> path: some browsers reject a bitmap for
      // formats they can still render in an element.
    }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () =>
        reject(new Error(isHeicSource(file) ? HEIC_DECODE_MESSAGE : 'That image could not be read'))
      image.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Downscales an image file to a base64 data URL no larger than `maxPx` on its
 * longest side.
 *
 * WebP is preferred because it is roughly half the size of JPEG at equal
 * quality. `toDataURL` silently falls back to PNG on browsers without WebP
 * support, so the returned string is inspected and re-encoded as JPEG — a PNG
 * of a photo would blow the size cap for no benefit.
 *
 * @returns {Promise<{dataUrl: string, contentType: string, width: number, height: number, bytes: number}>}
 */
export async function makeThumbnail(
  file,
  { maxPx = THUMBNAIL_MAX_PX, quality = THUMBNAIL_QUALITY } = {}
) {
  const invalid = validateSourceFile(file)
  if (invalid) throw new Error(invalid)

  const source = await decode(file)
  const sourceWidth = Number(source.width) || 0
  const sourceHeight = Number(source.height) || 0
  if (!sourceWidth || !sourceHeight) throw new Error('That image could not be read')

  try {
    const scale = Math.min(1, maxPx / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser cannot resize images')
    context.drawImage(source, 0, 0, width, height)

    let contentType = 'image/webp'
    let dataUrl = canvas.toDataURL(contentType, quality)
    if (!dataUrl.startsWith('data:image/webp')) {
      contentType = 'image/jpeg'
      dataUrl = canvas.toDataURL(contentType, quality)
    }

    return { dataUrl, contentType, width, height, bytes: base64Bytes(dataUrl) }
  } finally {
    // Bitmaps hold decoded pixels outside the JS heap; an un-closed one stays
    // resident until GC, which on a list of uploads is a real leak.
    if (typeof source.close === 'function') source.close()
  }
}
