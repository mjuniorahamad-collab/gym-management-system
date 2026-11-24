#!/usr/bin/env node
/**
 * Post-deploy hosting smoke check — READ ONLY.
 *
 * WHY IT EXISTS
 *   `firebase deploy --only hosting` can report success while the live origin
 *   still serves the previous bundle — a CDN edge that has not rolled over, a
 *   release that did not publish, or a truncated upload. The deploy workflow
 *   then ships the security surface on top of a frontend nobody has looked at.
 *   This check compares the live URL with the bundle in `dist/` that was built
 *   moments earlier, so a stale or broken bundle fails the job instead of going
 *   live silently.
 *
 * WHAT IT CHECKS
 *   1. The build in `dist/` carries the Firebase web config: at least one entry
 *      JavaScript file holds a real `AIza…` api key. The config is inlined at
 *      build time from `VITE_FIREBASE_*`, so a build that ran without those
 *      variables ships `apiKey: void 0` and every user gets the "Firebase is not
 *      configured" login page. This is checked locally, before any request.
 *   2. `<base>/` answers 200 `text/html` for a cache-busted URL.
 *   3. That HTML references the SAME hashed entry files (`/assets/...`) as
 *      `dist/index.html`, i.e. the live site is this build and not an older one.
 *   4. Every entry asset answers 200 with the right content type and hashes to
 *      the same sha256 as the local file (nothing truncated or swapped under the
 *      same name).
 *   5. A deep SPA route (`/login` by default) answers 200 with the app shell,
 *      proving the hosting rewrite is live — otherwise deep links 404 for users.
 *   6. The cache policy `firebase.json` declares is actually applied: the shell
 *      (`/` and the deep route) answers `Cache-Control: no-cache`, and every
 *      `/assets/**` file answers `immutable`. Header rules match the original
 *      request path and the last match wins, so a reordered `headers` array can
 *      silently put the shell back on Hosting's one hour default — which is how
 *      a stale shell survives a deploy and asks for chunks that no longer exist.
 *
 * WHAT IT NEVER DOES
 *   Write, purge, deploy or authenticate. The only traffic is GET requests to
 *   the hosting origin.
 *
 * USAGE
 *   node scripts/smoke-hosting.mjs
 *   node scripts/smoke-hosting.mjs --base-url=https://himalye-wonders-gym.web.app
 *   node scripts/smoke-hosting.mjs --dist=dist --route=/login --attempts=6 --delay-ms=5000
 *
 *   The retries exist because a fresh Hosting release can take a few seconds to
 *   answer on every edge. Defaults: 6 attempts, 5 s apart (~25 s total).
 *
 * EXIT  0 live origin matches the build · 1 mismatch or unreachable · 2 bad usage
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const DEFAULTS = {
  baseUrl: 'https://himalye-wonders-gym.web.app',
  dist: 'dist',
  route: '/login',
  attempts: 6,
  delayMs: 5000,
}

// Only hashed build output: Vite's entry script, modulepreload chunks and CSS.
// A `?query` or `#fragment` suffix is allowed and dropped, so a cache-busting
// parameter on the shell cannot hide the very files this check compares.
const ASSET_RE = /(?:src|href)="(\/assets\/[^"?#]+)(?:[?#][^"]*)?"/g

// A Firebase browser api key, as `src/firebase/config.js` inlines it into the
// entry chunk at build time. Loose on length on purpose: the point is to catch
// `void 0` (no VITE_FIREBASE_* environment), not to validate the key.
const FIREBASE_KEY_RE = /AIza[0-9A-Za-z_-]{30,}/

/** The `/assets/*.js` files in a build that carry a real Firebase api key. */
export function firebaseConfigIn(files) {
  const found = []
  for (const [asset, bytes] of files) {
    if (asset.endsWith('.js') && FIREBASE_KEY_RE.test(bytes.toString('utf8'))) found.push(asset)
  }
  return found
}

/** The `/assets/...` files an index.html references, de-duplicated. */
export function assetsIn(html) {
  return [...new Set([...html.matchAll(ASSET_RE)].map((match) => match[1]))]
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function usage() {
  console.log(
    [
      'Hosting smoke check (read-only) — compares the live site with a local build',
      '',
      '  --base-url=<url>   hosting origin (default https://himalye-wonders-gym.web.app)',
      '  --dist=<dir>       build directory to compare against (default dist)',
      '  --route=<path>     deep link that must serve the app shell (default /login)',
      '  --attempts=<n>     attempts before failing (default 6)',
      '  --delay-ms=<ms>    pause between attempts (default 5000)',
      '  --help',
    ].join('\n')
  )
}

/** CLI flags → the settings `checkOnce` needs. Exported so tests can cover it. */
export function parseArgs(argv) {
  const args = { ...DEFAULTS }
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=')
    const value = rest.join('=')
    if (key === 'help') args.help = true
    else if (key === 'base-url' && value) args.baseUrl = value.replace(/\/+$/, '')
    else if (key === 'dist' && value) args.dist = value
    else if (key === 'route' && value) args.route = value.startsWith('/') ? value : `/${value}`
    else if (key === 'attempts' && value) args.attempts = Number(value)
    else if (key === 'delay-ms' && value) args.delayMs = Number(value)
    else throw new Error(`Unknown option --${key}`)
  }
  if (!Number.isInteger(args.attempts) || args.attempts < 1) {
    throw new Error('--attempts must be a positive integer')
  }
  if (!Number.isInteger(args.delayMs) || args.delayMs < 0) {
    throw new Error('--delay-ms must be a non-negative integer')
  }
  return args
}

async function get(url, asBytes) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`)
  const contentType = (res.headers.get('content-type') || '').toLowerCase()
  const cacheControl = (res.headers.get('cache-control') || '').toLowerCase()
  const body = asBytes ? Buffer.from(await res.arrayBuffer()) : await res.text()
  return { contentType, cacheControl, body }
}

function expectedType(asset) {
  if (asset.endsWith('.js')) return (type) => /javascript|ecmascript/.test(type)
  if (asset.endsWith('.css')) return (type) => type.includes('text/css')
  return () => true
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One full pass. Returns `problems` (empty means pass) and the facts checked. */
export async function checkOnce({ baseUrl, dist, route, nonce }) {
  const problems = []
  const ok = []
  const indexPath = path.join(dist, 'index.html')

  let localHtml
  try {
    localHtml = readFileSync(indexPath, 'utf8')
  } catch {
    return {
      problems: [
        `no local build at ${indexPath} — run \`npm run build\` first (this check compares the live site with it).`,
      ],
      ok,
    }
  }

  const assets = assetsIn(localHtml)
  const entryScript = assets.find((asset) => asset.endsWith('.js'))
  if (!entryScript)
    return { problems: [`${indexPath} references no /assets/*.js entry script.`], ok }

  const local = new Map()
  for (const asset of assets) {
    try {
      local.set(asset, readFileSync(path.join(dist, asset.slice(1))))
    } catch {
      problems.push(`local build is missing ${asset} — rebuild before deploying.`)
    }
  }
  if (problems.length) return { problems, ok }

  // 0. The build itself, before the network: a bundle built without the
  // VITE_FIREBASE_* variables is served perfectly and still cannot sign anyone
  // in, so it must fail here rather than after a release.
  const configured = firebaseConfigIn(local)
  if (configured.length === 0) {
    problems.push(
      `the local build carries no Firebase api key (checked ${assets.filter((asset) => asset.endsWith('.js')).join(', ')}) — ` +
        '`npm run build` ran without the VITE_FIREBASE_* environment, so the deployed site would show ' +
        '"Firebase is not configured" on the login page. Add the VITE_FIREBASE_* repository secrets and pass ' +
        'them to the build step.'
    )
    return { problems, ok }
  }
  ok.push(`the build carries the Firebase web config (${configured.join(', ')})`)

  // 1. The live shell, cache-busted so a cached index.html cannot pass the check.
  const shellUrl = `${baseUrl}/?smoke=${nonce}`
  let shell
  try {
    shell = await get(shellUrl, false)
  } catch (err) {
    return { problems: [`live origin unreachable: ${err.message}`], ok }
  }
  if (!shell.contentType.includes('text/html')) {
    problems.push(
      `${shellUrl} answered content-type "${shell.contentType || '(none)'}", expected text/html — the hosting release or rewrite is wrong.`
    )
  }
  if (!shell.cacheControl.includes('no-cache')) {
    problems.push(
      `GET / answered cache-control "${shell.cacheControl || '(none)'}", expected no-cache — ` +
        'a shell cached for up to an hour keeps pointing at the previous build after a deploy.'
    )
  } else {
    ok.push('the shell is served with Cache-Control: no-cache')
  }

  const liveAssets = assetsIn(shell.body)
  const missing = assets.filter((asset) => !shell.body.includes(asset))
  if (missing.length) {
    problems.push(
      `the live index.html is NOT this build. Missing: ${missing.join(', ')}. ` +
        `Live shell references: ${liveAssets.join(', ') || '(no /assets/ files)'} — ` +
        'a stale CDN edge, a release that did not publish, or the wrong project.'
    )
  } else {
    ok.push(`served index.html references this build's entry files (${assets.join(', ')})`)
  }

  // A different build is already the verdict; hashing its assets against this one
  // would only add noise (and would blame the SPA rewrite for a stale bundle).
  if (problems.length > 0) return { problems, ok }

  // 2. Byte-for-byte: the same hash must be served for the same file name.
  let immutableAssets = 0
  for (const asset of assets) {
    const assetUrl = `${baseUrl}${asset}?smoke=${nonce}`
    let served
    try {
      served = await get(assetUrl, true)
    } catch (err) {
      problems.push(`entry asset not served: ${err.message}`)
      continue
    }
    if (!expectedType(asset)(served.contentType)) {
      problems.push(
        `${asset} served as "${served.contentType || '(none)'}" — the asset is not being served as built.`
      )
    }
    if (!served.cacheControl.includes('immutable')) {
      problems.push(
        `${asset} served cache-control "${served.cacheControl || '(none)'}", expected immutable — ` +
          'hashed build output must not be revalidated on every load.'
      )
    } else {
      immutableAssets += 1
    }
    const localHash = sha256(local.get(asset))
    const servedHash = sha256(served.body)
    if (servedHash !== localHash) {
      problems.push(
        `${asset} does not match the build: served ${served.body.length} bytes (sha256 ${servedHash.slice(0, 12)}), ` +
          `build has ${local.get(asset).length} bytes (sha256 ${localHash.slice(0, 12)}) — truncated upload or a different build under the same name.`
      )
    } else {
      ok.push(
        `${asset} served identically (${served.body.length} bytes, sha256 ${localHash.slice(0, 12)})`
      )
    }
  }

  if (immutableAssets === assets.length) {
    ok.push(`every entry asset is served with Cache-Control: immutable (${assets.length})`)
  }

  // 3. The SPA rewrite, through a real deep link rather than "/".
  const routeUrl = `${baseUrl}${route}?smoke=${nonce}`
  try {
    const deep = await get(routeUrl, false)
    if (!deep.body.includes(entryScript)) {
      problems.push(
        `${routeUrl} did not serve the app shell (no ${entryScript}) — the SPA rewrite is not live, deep links will 404.`
      )
    } else {
      ok.push(`deep link ${route} serves the app shell through the rewrite`)
    }
    if (!deep.cacheControl.includes('no-cache')) {
      problems.push(
        `deep link ${route} answered cache-control "${deep.cacheControl || '(none)'}", expected no-cache — ` +
          'the shell must not be cached on any route, not just "/".'
      )
    } else {
      ok.push(`deep link ${route} is served with Cache-Control: no-cache`)
    }
  } catch (err) {
    problems.push(
      `deep link failed: ${err.message} — the SPA rewrite is not live, deep links will 404.`
    )
  }

  return { problems, ok }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    usage()
    process.exit(2)
  }
  if (args.help) {
    usage()
    return
  }

  const nonce = Date.now().toString(36)
  console.log(`Hosting smoke check — ${args.baseUrl} vs ./${args.dist.replace(/^\.\//, '')}`)

  let problems = []
  let facts = []
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    const result = await checkOnce({ ...args, nonce })
    problems = result.problems
    facts = result.ok
    if (problems.length === 0) break
    if (attempt < args.attempts) {
      console.log(
        `Attempt ${attempt}/${args.attempts} not ready yet:\n  - ${problems.join('\n  - ')}\n` +
          `Retrying in ${args.delayMs / 1000}s…`
      )
      await sleep(args.delayMs)
    }
  }

  if (problems.length > 0) {
    console.error(
      `✗ Hosting smoke check failed after ${args.attempts} attempt(s):\n  - ${problems.join('\n  - ')}\n\n` +
        'The deploy job stops here, so the next stage does not ship on top of an unverified frontend.'
    )
    process.exit(1)
  }

  // Print what passed, so the deploy job's log shows which facts were checked
  // rather than only that nothing failed.
  for (const fact of facts) console.log(`  ✓ ${fact}`)
  console.log(
    '✓ live origin matches this build, a deep link serves the app shell, and the cache policy is applied.'
  )
  console.log('Hosting smoke check passed.')
}

// Imported by tests/tools, which never want the CLI to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nAborted: ${err?.message || err}`)
    process.exit(2)
  })
}
