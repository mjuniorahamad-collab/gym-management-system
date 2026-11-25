/**
 * Generates the PWA icons without adding a dependency.
 *
 * Chrome's install prompt wants raster icons at 192 and 512 (SVG alone is not
 * enough on every Android build), and a maskable 512 for the adaptive icon
 * shape. Drawing them here — indigo→emerald gradient with the same three white
 * bars as `public/favicon.svg` — keeps the repository free of a build-time image
 * toolchain and makes the icons reproducible: `node scripts/generate-pwa-icons.mjs`.
 *
 * PNG encoding is done by hand (IHDR/IDAT/IEND + zlib) because Node already
 * ships zlib and a canvas library would be a new dependency for three files.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function lerp(a, b, t) {
  return a.map((value, i) => Math.round(value + (b[i] - value) * t))
}

/** Capsule (rounded bar) hit test, in fractions of the icon size. */
function inCapsule(x, y, cx, y0, y1, halfWidth) {
  const clampedY = Math.min(Math.max(y, y0 + halfWidth), y1 - halfWidth)
  const dx = x - cx
  const dy = y - clampedY
  return dx * dx + dy * dy <= halfWidth * halfWidth
}

function drawIcon(size, { maskable = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4)
  const radius = maskable ? 0 : size * 0.22
  const barCenters = [0.3, 0.5, 0.7]
  const barHalfWidth = size * 0.045
  const barTop = size * (maskable ? 0.36 : 0.28)
  const barBottom = size * (maskable ? 0.64 : 0.72)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5
      const py = y + 0.5
      let alpha = 255

      if (radius > 0) {
        // Rounded-rect coverage: transparent outside the four corner circles.
        const nearX = Math.min(Math.max(px, radius), size - radius)
        const nearY = Math.min(Math.max(py, radius), size - radius)
        const dx = px - nearX
        const dy = py - nearY
        if (dx * dx + dy * dy > radius * radius) alpha = 0
      }

      let color = alpha === 0 ? [0, 0, 0] : lerp([79, 70, 229], [16, 185, 129], (x + y) / (2 * size))
      for (const cx of barCenters) {
        if (inCapsule(px, py, cx * size, barTop, barBottom, barHalfWidth)) color = [255, 255, 255]
      }

      const offset = (y * size + x) * 4
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
      pixels[offset + 3] = alpha
    }
  }

  return encodePng(size, pixels)
}

mkdirSync(OUT_DIR, { recursive: true })

for (const [file, size, options] of [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
]) {
  writeFileSync(join(OUT_DIR, file), drawIcon(size, options))
  console.log(`wrote public/icons/${file}`)
}
