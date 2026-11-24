#!/usr/bin/env node
/**
 * Live Firestore rules check — READ ONLY.
 *
 * WHY IT EXISTS
 *   The repository's `firestore.rules` is the reviewed intent. What Firebase
 *   actually enforces is the ruleset the `cloud.firestore` release points at, and
 *   nothing in CI compares the two: the emulator suites prove what this file
 *   *would* enforce, not what production *does*. A deploy can be reported as
 *   successful while the release still points at an older ruleset, a console edit
 *   can drift away from the file, and the first symptom is a user who can read a
 *   gym they do not belong to. This check answers one question: is the live
 *   ruleset byte-for-byte this file?
 *
 * WHAT IT CHECKS
 *   1. The project has a `cloud.firestore` release (or `--release=<name>`).
 *   2. The ruleset that release points at has a Firestore source file.
 *   3. That source, with line endings and trailing whitespace normalised, equals
 *      `firestore.rules` in this checkout — and it prints the first differing
 *      lines, each truncated, when it does not.
 *
 * WHAT IT NEVER DOES
 *   Write, deploy, test or release anything. Only two GET requests are made
 *   (`releases.list`, then `rulesets.get`), so `roles/firebaserules.viewer` is
 *   enough for the account running it. It never calls
 *   `firebaserules.rulesets.test`, the call that needs
 *   `roles/firebaserules.admin` and that blocked deploy run #13.
 *
 * USAGE
 *   node scripts/check-live-rules.mjs --access-token="$(gcloud auth print-access-token)"
 *   node scripts/check-live-rules.mjs --project=himalye-wonders-gym --release=cloud.firestore
 *
 *   --access-token=<tok>   OAuth token (or set GOOGLE_ACCESS_TOKEN)
 *   --project=<id>         project id (default: `projects.default` in .firebaserc)
 *   --release=<name>       rules release (default cloud.firestore)
 *   --rules=<path>         file to compare (default firestore.rules)
 *   --help
 *
 * EXIT  0 live matches this file · 1 differs or never deployed · 2 could not check
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { rulesFiles } from './rollback-release.mjs'

const RULES_API = 'https://firebaserules.googleapis.com/v1'

const DEFAULTS = {
  project: '',
  token: '',
  release: 'cloud.firestore',
  rules: 'firestore.rules',
}

function usage() {
  console.log(
    [
      'Live Firestore rules check (read-only) — compares the deployed ruleset with firestore.rules',
      '',
      '  --access-token=<tok>  OAuth token (or set GOOGLE_ACCESS_TOKEN)',
      '  --project=<id>        project id (default: projects.default in .firebaserc)',
      '  --release=<name>      rules release (default cloud.firestore)',
      '  --rules=<path>        file to compare (default firestore.rules)',
      '  --help',
      '',
      'Needs roles/firebaserules.viewer. Deploys nothing.',
      'Exit 0 = live matches the file · 1 = differs or never deployed · 2 = could not check',
    ].join('\n')
  )
}

/** CLI flags → the settings `checkLiveRules` needs. Exported so tests can cover it. */
export function parseArgs(argv, env = process.env) {
  const args = { ...DEFAULTS, token: env.GOOGLE_ACCESS_TOKEN || '' }
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=')
    const value = rest.join('=')
    if (key === 'help') args.help = true
    else if (key === 'project' && value) args.project = value
    else if (key === 'access-token' && value) args.token = value
    else if (key === 'release' && value) args.release = value
    else if (key === 'rules' && value) args.rules = value
    else throw new Error(`Unknown option --${key}`)
  }
  return args
}

/** `projects.default` from .firebaserc, or '' when the file is missing or unreadable. */
export function defaultProject(read = readFileSync) {
  try {
    const parsed = JSON.parse(read('.firebaserc', 'utf8'))
    return `${parsed?.projects?.default ?? ''}`.trim()
  } catch {
    return ''
  }
}

/**
 * Rules text as Firebase stores it: CRLF is normalised to LF, trailing spaces and
 * tabs are dropped from every line, and trailing blank lines are removed. Without
 * this, a Windows checkout would report every line as different from the same file
 * deployed from Linux.
 */
export function normalizeRules(text) {
  return `${text ?? ''}`
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
}

const SNIPPET_MAX = 120

/** One line of rules, cut to something readable in a job log. */
function snippet(line) {
  if (line === null || line === undefined) return '(no such line)'
  const text = `${line}`
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text
}

/**
 * The first few differing lines of two rules files.
 *
 * Line numbers are the index in each file, so a pure insertion shifts every later
 * line and is reported as one difference at the insertion point rather than as a
 * wall of noise. `differences` is capped so a completely unrelated pair of files
 * does not fill the log.
 */
export function compareRules(localText, liveText, { maxDifferences = 5 } = {}) {
  const local = normalizeRules(localText).split('\n')
  const live = normalizeRules(liveText).split('\n')
  const same = normalizeRules(localText) === normalizeRules(liveText)
  const differences = []
  if (!same) {
    const lines = Math.max(local.length, live.length)
    for (let index = 0; index < lines && differences.length < maxDifferences; index += 1) {
      if (local[index] !== live[index]) {
        differences.push({
          line: index + 1,
          repo: local[index] ?? null,
          live: live[index] ?? null,
        })
      }
    }
  }
  return { same, localLines: local.length, liveLines: live.length, differences }
}

/**
 * The Firestore rules source among a ruleset's files. A deploy from `firebase.json`
 * uploads exactly one file named `firestore.rules`; a console edit can carry a
 * different name, and a multi-file source is not something this file can be
 * compared against, so it is rejected rather than guessed at.
 */
export function pickFirestoreFile(files) {
  const candidates = (files || []).filter((file) => typeof file?.content === 'string')
  return (
    candidates.find((file) => /(^|\/)firestore\.rules$/.test(file.name || '')) ||
    (candidates.length === 1 ? candidates[0] : null)
  )
}

/** What the live release is, and how it differs from `localText`. Never throws. */
export async function checkLiveRules({
  project,
  token,
  localText,
  release = 'cloud.firestore',
  fetchImpl = fetch,
}) {
  // A release's `name` is a resource path without the host: projects/<id>/releases/<r>.
  const resource = `projects/${project}`
  const releaseName = `${resource}/releases/${release}`

  const get = async (url) => {
    let res
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })
    } catch (err) {
      throw new Error(`GET ${url} failed: ${err?.message || err}`)
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : {}
  }

  try {
    const list = await get(`${RULES_API}/${resource}/releases?pageSize=100`)
    const live = (list.releases || []).find((entry) => entry.name === releaseName)
    if (!live) return { status: 'undeployed', project, releaseName }

    const ruleset = await get(`${RULES_API}/${live.rulesetName}`)
    const file = pickFirestoreFile(rulesFiles(ruleset))
    if (!file) {
      return {
        status: 'error',
        project,
        releaseName,
        rulesetName: live.rulesetName,
        problem: `${live.rulesetName} has no single Firestore source file to compare (expected one named firestore.rules).`,
      }
    }

    const comparison = compareRules(localText, file.content)
    return {
      status: comparison.same ? 'match' : 'mismatch',
      project,
      releaseName,
      rulesetName: live.rulesetName,
      updateTime: live.updateTime || '',
      liveFile: file.name || 'firestore.rules',
      ...comparison,
    }
  } catch (err) {
    return { status: 'error', project, releaseName, problem: err?.message || `${err}` }
  }
}

/** The verdict as the lines a human reads. Exported so tests can pin the wording. */
export function renderResult(result, { rulesPath = 'firestore.rules' } = {}) {
  const subject = result.releaseName || `${result.project || '(unknown project)'} · cloud.firestore`

  if (result.status === 'match') {
    return [
      `✓ the live ${subject} matches ${rulesPath} (${result.localLines} lines).`,
      `  ruleset : ${result.rulesetName}`,
      `  release : updated ${result.updateTime || '(unknown)'}`,
      `  source  : ${result.liveFile}`,
    ].join('\n')
  }

  if (result.status === 'mismatch') {
    const lines = [
      `✗ the live ${subject} does NOT match ${rulesPath}.`,
      `  ruleset : ${result.rulesetName} (updated ${result.updateTime || '(unknown)'})`,
      `  ${rulesPath}: ${result.localLines} lines · live: ${result.liveLines} lines`,
      '  first differing lines (same index in each file):',
    ]
    for (const diff of result.differences) {
      lines.push(`    line ${diff.line}`)
      lines.push(`      repo: ${snippet(diff.repo)}`)
      lines.push(`      live: ${snippet(diff.live)}`)
    }
    lines.push(
      '  Production enforces the live ruleset, not this file. Release a reviewed commit with',
      '  `firebase deploy --only firestore:rules` (deploy.yml, deploy_scope=hosting+rules).'
    )
    return lines.join('\n')
  }

  if (result.status === 'undeployed') {
    return [
      `✗ ${result.releaseName} does not exist — Firestore rules have never been released to`,
      `  ${result.project}. The database currently runs the project's default rules.`,
      '  Release a reviewed commit with `firebase deploy --only firestore:rules`',
      '  (deploy.yml, deploy_scope=hosting+rules).',
    ].join('\n')
  }

  const lines = [`✗ could not read the live rules: ${result.problem}`]
  if (/HTTP 403/.test(result.problem || '')) {
    lines.push(
      '  The token lacks access to the Firebase Rules API. The deploy service account needs',
      '  roles/firebaserules.admin to release rules; reading them needs roles/firebaserules.viewer.',
      '  Grant it in the Google Cloud console (IAM → Grant access) and re-run.'
    )
  }
  return lines.join('\n')
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
  if (!args.token) {
    console.error(
      '✗ --access-token is required (or set GOOGLE_ACCESS_TOKEN), e.g.\n' +
        '  node scripts/check-live-rules.mjs --access-token="$(gcloud auth print-access-token)"'
    )
    process.exit(2)
  }

  const project = args.project || defaultProject()
  if (!project) {
    console.error('✗ no project: pass --project=<id> or set projects.default in .firebaserc')
    process.exit(2)
  }

  let localText
  try {
    localText = readFileSync(args.rules, 'utf8')
  } catch (err) {
    console.error(`✗ cannot read ${args.rules}: ${err?.message || err}`)
    process.exit(2)
  }

  const result = await checkLiveRules({
    project,
    token: args.token,
    localText,
    release: args.release,
  })
  console.log(renderResult(result, { rulesPath: args.rules }))

  if (result.status === 'match') return
  process.exit(result.status === 'error' ? 2 : 1)
}

// Imported by tests, which never want the CLI to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nAborted: ${err?.message || err}`)
    process.exit(2)
  })
}
