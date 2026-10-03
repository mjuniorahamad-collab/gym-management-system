/**
 * Bundles the canonical projection engine from `src/utils/` into
 * `functions/vendor/projection.mjs`.
 *
 * ## Why this exists
 *
 * Cloud Functions deploys only the `functions/` directory. A deployed function
 * cannot resolve `../../src/utils/memberProjection.js`, and copying that logic
 * into `functions/` by hand would create a second projection algorithm that
 * could disagree with the one the app's tests cover. So the frontend modules
 * stay canonical and are BUNDLED here.
 *
 * `vendor/projection.mjs` is generated output. It is committed so a deploy does
 * not depend on a build step, and `checkFreshness()` fails the test gate if it
 * has drifted from `src/utils/` — the failure mode being designed against is a
 * deployed function quietly running last month's calculation.
 *
 * ## Determinism
 *
 * The output is byte-stable for a given input and esbuild version, which is
 * what makes the staleness comparison meaningful. Nothing timestamped, no
 * absolute paths, no build metadata.
 *
 * Usage:  node build.mjs           rebuild the bundle
 *         checkFreshness()         compare only, do not write (used by tests)
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, 'projection', 'engine.entry.js')
const OUT = join(HERE, 'vendor', 'projection.mjs')

/** Build the bundle in memory so callers can compare without touching disk. */
export async function buildBundle() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    // Pinned, or esbuild writes each module's `// <path>` comment relative to the
    // caller's cwd and the same source produces two different bundles depending
    // on where the build was invoked — which would make the staleness check
    // below fail for reasons that have nothing to do with drift.
    absWorkingDir: HERE,
  })
  return result.outputFiles[0].text
}

/**
 * True when the committed bundle matches what `src/utils/` produces right now.
 * Exported so the test gate can fail on drift rather than on a stale deploy.
 */
export async function checkFreshness() {
  const expected = await buildBundle()
  let actual = null
  try {
    actual = await readFile(OUT, 'utf8')
  } catch {
    return { fresh: false, reason: 'vendor/projection.mjs is missing — run `npm run build` in functions/' }
  }
  if (actual === expected) return { fresh: true }
  return {
    fresh: false,
    reason:
      'vendor/projection.mjs is STALE — the canonical engine in src/utils/ has changed since the bundle was built. Run `npm run build` in functions/ and commit the result.',
  }
}

async function main() {
  const text = await buildBundle()
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, text, 'utf8')
  const kb = (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)
  console.log(`built vendor/projection.mjs (${kb} kB) from src/utils/`)
}

// `pathToFileURL` rather than string surgery: on Windows `process.argv[1]` is a
// backslash path, and `file://` + that path is not the same string
// `import.meta.url` produces (`file:///`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}