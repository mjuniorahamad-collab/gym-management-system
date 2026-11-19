/**
 * Unit tests for `scripts/smoke-hosting.mjs`.
 *
 * The smoke check runs once, after a Hosting release. A broken asset parser or
 * option handler there would only surface when a deploy is already half done —
 * exactly when nobody wants to debug it. These tests cover the two pure pieces
 * (asset discovery and argument parsing) on every `npm test`, i.e. in the CI
 * `app` job, so a regression fails before it can reach the deploy workflow.
 *
 * The network half is deliberately not tested here: it would need a live origin.
 */

import { describe, expect, it } from 'vitest'
import { assetsIn, parseArgs } from './smoke-hosting.mjs'

// Shaped like a real Vite index.html: entry script, stylesheet, a modulepreload
// chunk, one non-asset href and one external URL.
const VITE_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <script type="module" crossorigin src="/assets/index-Bl8hJKzx.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-BrspUv4k.css" />
    <link rel="modulepreload" crossorigin href="/assets/vendor-Ck2q9x1a.js" />
    <link rel="stylesheet" href="https://fonts.example.com/font.css" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

describe('assetsIn', () => {
  it('collects every /assets/ reference in document order', () => {
    expect(assetsIn(VITE_INDEX)).toEqual([
      '/assets/index-Bl8hJKzx.js',
      '/assets/index-BrspUv4k.css',
      '/assets/vendor-Ck2q9x1a.js',
    ])
  })

  it('ignores non-asset hrefs, external URLs and inline scripts', () => {
    const html = `
      <link rel="icon" href="/favicon.svg" />
      <a href="/login">Log in</a>
      <link rel="stylesheet" href="https://cdn.example.com/app.css" />
      <script>window.__CONFIG__ = { asset: '/assets/inline.js' }</script>
      <script src="/assets/app.js"></script>
    `
    expect(assetsIn(html)).toEqual(['/assets/app.js'])
  })

  it('de-duplicates a file referenced more than once', () => {
    const html = `
      <link rel="modulepreload" href="/assets/index-a.js" />
      <script src="/assets/index-a.js"></script>
      <link rel="stylesheet" href="/assets/index-a.css" />
      <link rel="stylesheet" href="/assets/index-a.css" />
    `
    expect(assetsIn(html)).toEqual(['/assets/index-a.js', '/assets/index-a.css'])
  })

  it('drops query strings and fragments from the file name', () => {
    const html = `
      <script src="/assets/index-a.js?v=2"></script>
      <link rel="stylesheet" href="/assets/index-a.css#app" />
    `
    expect(assetsIn(html)).toEqual(['/assets/index-a.js', '/assets/index-a.css'])
  })

  it('returns nothing for a shell that references no build output', () => {
    expect(assetsIn('<html><body><div id="root"></div></body></html>')).toEqual([])
  })
})

describe('parseArgs', () => {
  it('uses the documented defaults', () => {
    expect(parseArgs([])).toEqual({
      baseUrl: 'https://himalye-wonders-gym.web.app',
      dist: 'dist',
      route: '/login',
      attempts: 6,
      delayMs: 5000,
    })
  })

  it('does not leak one call’s options into the next', () => {
    parseArgs(['--dist=out', '--attempts=1'])
    expect(parseArgs([]).dist).toBe('dist')
    expect(parseArgs([]).attempts).toBe(6)
  })

  it('strips trailing slashes from the base URL', () => {
    expect(parseArgs(['--base-url=https://gym.example.com///']).baseUrl).toBe(
      'https://gym.example.com'
    )
  })

  it('keeps a path in the base URL intact', () => {
    expect(parseArgs(['--base-url=https://gym.example.com/app/']).baseUrl).toBe(
      'https://gym.example.com/app'
    )
  })

  it('accepts a deep-link route with or without a leading slash', () => {
    expect(parseArgs(['--route=login']).route).toBe('/login')
    expect(parseArgs(['--route=/members/12']).route).toBe('/members/12')
  })

  it('keeps "=" inside a value instead of splitting on it', () => {
    expect(parseArgs(['--route=/search?q=a=b']).route).toBe('/search?q=a=b')
  })

  it('parses numeric retry settings', () => {
    const args = parseArgs(['--attempts=1', '--delay-ms=0'])
    expect(args.attempts).toBe(1)
    expect(args.delayMs).toBe(0)
  })

  it('reports --help without touching the defaults', () => {
    expect(parseArgs(['--help']).help).toBe(true)
  })

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--base-url-x=https://gym.example.com'])).toThrow(
      /Unknown option --base-url-x/
    )
  })

  it('rejects an attempts value that is not a positive integer', () => {
    for (const value of ['0', '-1', '1.5', 'many']) {
      expect(() => parseArgs([`--attempts=${value}`])).toThrow(
        /--attempts must be a positive integer/
      )
    }
  })

  it('rejects a delay that is not a non-negative integer', () => {
    for (const value of ['-1', '0.5', 'soon']) {
      expect(() => parseArgs([`--delay-ms=${value}`])).toThrow(
        /--delay-ms must be a non-negative integer/
      )
    }
  })
})
