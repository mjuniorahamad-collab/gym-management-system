/**
 * Unit tests for `scripts/smoke-hosting.mjs`.
 *
 * The smoke check runs once, after a Hosting release. A broken asset parser or
 * option handler there would only surface when a deploy is already half done —
 * exactly when nobody wants to debug it. These tests cover the two pure pieces
 * (asset discovery and argument parsing) on every `npm test`, i.e. in the CI
 * `app` job, so a regression fails before it can reach the deploy workflow.
 *
 * The network half is exercised against a loopback HTTP server (`node:http`) that
 * stands in for Hosting: no credentials, no deploy, but the same verdict logic the
 * deploy job depends on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assetsIn, checkOnce, parseArgs } from './smoke-hosting.mjs'

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

// ---------------------------------------------------------------------------
// The verdict itself: `checkOnce` against a loopback origin.
//
// The deploy job stops on this function's `problems` array, so each way a release
// can be wrong gets a test with a real HTTP response rather than a stub: a stale
// edge, a truncated upload, an asset served under the wrong content type, and a
// missing SPA rewrite are the four failures that have actually happened or been
// feared. Nothing here touches a network other than 127.0.0.1.
// ---------------------------------------------------------------------------

const BUILD_JS = 'console.log("build one")\n'
const BUILD_CSS = '.app{color:#111}\n'

const BUILD_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <script type="module" crossorigin src="/assets/index-one.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-one.css" />
  </head>
  <body><div id="root"></div></body>
</html>
`

const tempDirs = []
const servers = []

afterAll(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve))
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway build directory shaped like what `npm run build` leaves in `dist/`. */
function writeBuild({
  index = BUILD_INDEX,
  files = { 'assets/index-one.js': BUILD_JS, 'assets/index-one.css': BUILD_CSS },
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-hosting-'))
  tempDirs.push(dir)
  writeFileSync(path.join(dir, 'index.html'), index)
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

/**
 * A loopback origin standing in for Hosting. `routes` maps a pathname to
 * `{ body, type, status }`; `rewrite` serves the shell for any path that is not an
 * asset, which is what the SPA rewrite in `firebase.json` does.
 */
async function serve(routes, { rewrite = false } = {}) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1')
    const target =
      routes[pathname] || (rewrite && !pathname.startsWith('/assets/') ? routes['/'] : undefined)
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(target.status || 200, { 'content-type': target.type })
    res.end(target.body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

/** The healthy origin both the pass case and each broken case are built from. */
async function serveBuild(overrides = {}) {
  return serve(
    {
      '/': { body: BUILD_INDEX, type: 'text/html; charset=utf-8' },
      '/assets/index-one.js': { body: BUILD_JS, type: 'text/javascript' },
      '/assets/index-one.css': { body: BUILD_CSS, type: 'text/css' },
      ...overrides,
    },
    { rewrite: true }
  )
}

const run = (baseUrl, dist, route = '/login') => checkOnce({ baseUrl, dist, route, nonce: 'test' })

describe('checkOnce', () => {
  it('passes when the origin serves this build and the SPA rewrite', async () => {
    const { problems, ok } = await run(await serveBuild(), writeBuild())

    expect(problems).toEqual([])
    expect(ok.join('\n')).toContain('references this build')
    expect(ok.join('\n')).toContain('/assets/index-one.js served identically')
    expect(ok.join('\n')).toContain('deep link /login serves the app shell')
  })

  it('fails a stale release, and blames the shell instead of the rewrite', async () => {
    const stale = BUILD_INDEX.replaceAll('index-one', 'index-old')
    const baseUrl = await serve(
      {
        '/': { body: stale, type: 'text/html' },
        '/assets/index-old.js': { body: BUILD_JS, type: 'text/javascript' },
        '/assets/index-old.css': { body: BUILD_CSS, type: 'text/css' },
      },
      { rewrite: true }
    )

    const { problems, ok } = await run(baseUrl, writeBuild())

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('the live index.html is NOT this build')
    expect(problems[0]).toContain('/assets/index-one.js')
    expect(problems[0]).toContain('/assets/index-old.js')
    // A stale shell short-circuits: the rewrite is not blamed as a second reason.
    expect(ok).toEqual([])
  })

  it('fails when an asset is a truncated copy of the build', async () => {
    const baseUrl = await serveBuild({
      '/assets/index-one.js': { body: BUILD_JS.slice(0, 11), type: 'text/javascript' },
    })

    const { problems } = await run(baseUrl, writeBuild())

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('/assets/index-one.js does not match the build')
    expect(problems[0]).toContain(`served ${BUILD_JS.slice(0, 11).length} bytes`)
    expect(problems[0]).toContain(`build has ${BUILD_JS.length} bytes`)
    expect(problems[0]).toContain('truncated upload')
  })

  it('fails when an asset is served under the wrong content type', async () => {
    const baseUrl = await serveBuild({
      '/assets/index-one.js': { body: BUILD_JS, type: 'text/html' },
    })

    const { problems } = await run(baseUrl, writeBuild())

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('/assets/index-one.js served as "text/html"')
    expect(problems[0]).toContain('not being served as built')
  })

  it('fails when the SPA rewrite is missing, so a deep link 404s', async () => {
    const baseUrl = await serve({
      '/': { body: BUILD_INDEX, type: 'text/html' },
      '/assets/index-one.js': { body: BUILD_JS, type: 'text/javascript' },
      '/assets/index-one.css': { body: BUILD_CSS, type: 'text/css' },
    })

    const { problems, ok } = await run(baseUrl, writeBuild(), '/members/42')

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/deep link failed: GET .*\/members\/42.* HTTP 404/)
    expect(problems[0]).toContain('SPA rewrite is not live')
    expect(ok.join('\n')).toContain('/assets/index-one.js served identically')
  })

  it('fails before any request when there is no local build', async () => {
    const missing = path.join(tmpdir(), 'smoke-hosting-no-such-build')

    const { problems } = await run('http://127.0.0.1:1', missing)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('no local build at')
    expect(problems[0]).toContain('npm run build')
  })
})
