/**
 * The installable PWA is only as good as its wiring: a manifest that points at
 * a missing icon, an index.html that forgets the manifest, or a worker that
 * caches cross-origin Firebase traffic would each look fine in code review and
 * fail on a phone. These are cheap filesystem assertions, so they run in the
 * normal unit suite (no browser, no hosting).
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const read = (path) => readFileSync(join(ROOT, path), 'utf8')

const manifest = JSON.parse(read('public/manifest.webmanifest'))

function pngSize(path) {
  const bytes = readFileSync(join(ROOT, path))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), signature: bytes.subarray(1, 4).toString('ascii') }
}

describe('web app manifest', () => {
  it('is installable: name, start_url, standalone display and a scope', () => {
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name.length).toBeLessThanOrEqual(12)
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('ships 192, 512 and maskable icons that actually exist as PNGs', () => {
    const any192 = manifest.icons.find((icon) => icon.sizes === '192x192' && icon.purpose === 'any')
    const any512 = manifest.icons.find((icon) => icon.sizes === '512x512' && icon.purpose === 'any')
    const maskable = manifest.icons.find((icon) => icon.purpose === 'maskable')
    expect(any192).toBeTruthy()
    expect(any512).toBeTruthy()
    expect(maskable).toBeTruthy()

    for (const [icon, size] of [
      [any192, 192],
      [any512, 512],
      [maskable, 512],
    ]) {
      const path = `public${icon.src}`
      expect(existsSync(join(ROOT, path)), `${path} missing`).toBe(true)
      expect(statSync(join(ROOT, path)).size).toBeGreaterThan(500)
      const png = pngSize(path)
      expect(png.signature).toBe('PNG')
      expect(png.width).toBe(size)
      expect(png.height).toBe(size)
    }
  })
})

describe('index.html', () => {
  const html = read('index.html')

  it('links the manifest and the Apple touch icon', () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"')
    expect(html).toContain('name="theme-color"')
  })
})

describe('service worker', () => {
  const sw = read('public/sw.js')

  it('precaches the app shell and versions the cache', () => {
    expect(sw).toMatch(/const CACHE = 'gym-shell-v\d+'/)
    expect(sw).toContain("'/index.html'")
    expect(sw).toContain("'/manifest.webmanifest'")
  })

  it('never intercepts cross-origin Firebase traffic', () => {
    expect(sw).toContain('url.origin !== self.location.origin')
    expect(sw).toContain("request.method !== 'GET'")
  })

  /** A cache-first shell would keep serving old HTML after a deploy. */
  it('serves navigation network-first with an offline shell fallback', () => {
    expect(sw).toContain("request.mode === 'navigate'")
    expect(sw).toContain(".catch(() => caches.match('/index.html')")
  })

  it('is registered only in the production build', () => {
    const main = read('src/main.jsx')
    expect(main).toContain('import.meta.env.PROD')
    expect(main).toMatch(/serviceWorker\s*\n?\s*\.register\('\/sw\.js'\)/)
  })

  it('hands the registration to the update watcher', () => {
    const main = read('src/main.jsx')
    expect(main).toContain('pwaUpdates.register(registration)')
  })
})
