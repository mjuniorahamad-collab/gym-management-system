#!/usr/bin/env node
/**
 * Release rollback for hosting and Firestore rules — DRY RUN BY DEFAULT.
 *
 * WHY IT EXISTS
 *   A deploy can pass every gate and still be wrong in production: a bundle that
 *   trips the CSP, a rules change that locks staff out of payments. The staged
 *   deploy makes that rarer, not impossible. Rolling back used to be a console
 *   click nobody had rehearsed, and `firebase hosting:rollback` prompts
 *   interactively, so it cannot be read in a diff or run from a job. This script
 *   answers "what exactly would change?" first, and writes only with --apply.
 *
 * WHAT A ROLLBACK IS
 *   Hosting: publishing an older version again. The API creates a NEW release
 *   that points at that version, so history is append-only — nothing is deleted
 *   and the bad release stays in the list for a later diff.
 *   Rules: pointing the live release (`cloud.firestore` by default) at an older
 *   ruleset. Rulesets are immutable, so the script copies the old source into a
 *   new ruleset and moves the release to it; the bad ruleset is kept.
 *
 *   Neither path calls `firebaserules.googleapis.com:test`, the call that 403s
 *   for the deploy service account until it holds roles/firebaserules.admin.
 *   Permissions needed: `firebasehosting.releases.create` (hosting), or
 *   `firebaserules.rulesets.create` + `firebaserules.releases.update` (rules).
 *   Neither path has been exercised against the production project yet: the
 *   first real use must be a dry run, then --apply, then the smoke check.
 *
 * WHAT IT NEVER DOES
 *   - Write anything without --apply. A dry run only calls list/get endpoints.
 *   - Delete a release, a version or a ruleset.
 *   - Touch indexes, storage rules or Cloud Functions.
 *   - Decide a different target than the one it printed: the plan is rendered
 *     first, and the apply uses that same plan.
 *
 * USAGE
 *   node scripts/rollback-release.mjs --target=hosting --project=<id> --access-token=<tok>
 *   node scripts/rollback-release.mjs --target=rules --project=<id> --access-token=<tok> --apply
 *
 *   --target=hosting|rules   what to roll back (default hosting)
 *   --access-token=<tok>     OAuth token for the project (required); CI/local:
 *                            --access-token="$(gcloud auth print-access-token)"
 *   --site=<id>              hosting site (default: the project id)
 *   --release=<name>         rules release to move (default cloud.firestore)
 *   --to=<id>                a specific version / ruleset id from the candidates
 *   --limit=<n>              candidates to print (default 5)
 *   --apply                  actually perform the printed plan
 *   --help
 *
 * EXIT  0 planned (or applied) · 1 nothing safe to roll back · 2 could not run
 */

import process from 'node:process'
import { pathToFileURL } from 'node:url'

const HOSTING_API = 'https://firebasehosting.googleapis.com/v1beta1'
const RULES_API = 'https://firebaserules.googleapis.com/v1'

const DEFAULTS = {
  target: 'hosting',
  project: '',
  token: '',
  site: '',
  release: 'cloud.firestore',
  to: '',
  limit: 5,
  apply: false,
}

function usage() {
  console.log(
    [
      'Release rollback — dry run by default (hosting or Firestore rules)',
      '',
      '  --target=hosting|rules  what to roll back (default hosting)',
      '  --project=<id>          Firebase project id (required)',
      '  --access-token=<tok>    OAuth token (required; gcloud auth print-access-token)',
      '  --site=<id>             hosting site id (default: the project id)',
      '  --release=<name>        rules release to move (default cloud.firestore)',
      '  --to=<id>               pick a version / ruleset from the printed candidates',
      '  --limit=<n>             how many candidates to print (default 5)',
      '  --apply                 perform the plan instead of only printing it',
      '  --help',
    ].join('\n')
  )
}

/** CLI flags → the settings `run` needs. Exported so tests can cover it. */
export function parseArgs(argv) {
  const args = { ...DEFAULTS }
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=')
    const value = rest.join('=')
    if (key === 'help') args.help = true
    else if (key === 'apply') args.apply = true
    else if (key === 'target' && value) args.target = value
    else if (key === 'project' && value) args.project = value
    else if (key === 'access-token' && value) args.token = value
    else if (key === 'site' && value) args.site = value
    else if (key === 'release' && value) args.release = value
    else if (key === 'to' && value) args.to = value
    else if (key === 'limit' && value) args.limit = Number(value)
    else throw new Error(`Unknown option --${key}`)
  }
  if (!['hosting', 'rules'].includes(args.target)) {
    throw new Error(`--target must be hosting or rules (got "${args.target}")`)
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer')
  }
  return args
}

function byTimeDesc(key) {
  return (a, b) => String(b[key] || '').localeCompare(String(a[key] || ''))
}

function versionName(site, value) {
  if (!value) return ''
  return value.startsWith('sites/') ? value : `sites/${site}/versions/${value}`
}

function rulesetName(project, value) {
  if (!value) return ''
  return value.startsWith('projects/') ? value : `projects/${project}/rulesets/${value}`
}

/**
 * The hosting plan: the live release, and the older versions it could point at.
 * A version is offered once even when several releases served it (a rollback
 * re-releases an existing version, so repeats are normal).
 */
export function planHosting({ site, releases = [], to = '', limit = 5 }) {
  const ordered = [...releases].sort(byTimeDesc('releaseTime'))
  const liveRelease = ordered.find((release) => release.type !== 'SITE_DISABLE') || null
  const liveVersion = liveRelease?.version?.name || ''

  const candidates = []
  const seen = new Set(liveVersion ? [liveVersion] : [])
  for (const release of ordered) {
    const name = release.version?.name || ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    candidates.push({
      versionName: name,
      releaseName: release.name || '',
      releaseTime: release.releaseTime || '',
      type: release.type || 'DEPLOY',
    })
  }

  const wanted = versionName(site, to)
  const target = wanted
    ? candidates.find((candidate) => candidate.versionName === wanted)
    : candidates[0]
  let problem = ''
  if (!liveRelease) {
    problem = `site ${site} has no live release to roll back from.`
  } else if (!target) {
    problem = wanted
      ? `${wanted} is not one of the older versions of ${site}.`
      : `no older version of ${site} exists — there is nothing to roll back to.`
  }

  return {
    kind: 'hosting',
    site,
    live: liveRelease
      ? {
          releaseName: liveRelease.name || '',
          versionName: liveVersion,
          releaseTime: liveRelease.releaseTime || '',
          type: liveRelease.type || 'DEPLOY',
        }
      : null,
    candidates,
    shown: candidates.slice(0, limit),
    target: target || null,
    problem,
  }
}

/** The rules plan: the live ruleset of one release, and older rulesets. */
export function planRules({
  project,
  releases = [],
  rulesets = [],
  release = 'cloud.firestore',
  to = '',
  limit = 5,
}) {
  const releaseName = `projects/${project}/releases/${release}`
  const liveRelease = releases.find((entry) => entry.name === releaseName) || null
  const liveRuleset = liveRelease?.rulesetName || ''

  const ordered = [...rulesets].sort(byTimeDesc('createTime'))
  const candidates = ordered
    .filter((ruleset) => ruleset.name && ruleset.name !== liveRuleset)
    .map((ruleset) => ({ rulesetName: ruleset.name, createTime: ruleset.createTime || '' }))

  const wanted = rulesetName(project, to)
  const target = wanted ? candidates.find((entry) => entry.rulesetName === wanted) : candidates[0]
  let problem = ''
  if (!liveRelease) {
    problem = `no release named ${releaseName} — the rules have never been deployed to ${project}.`
  } else if (!target) {
    problem = wanted
      ? `${wanted} is not an older ruleset of ${project}.`
      : `no older ruleset is available — there is nothing to roll back to.`
  }

  return {
    kind: 'rules',
    project,
    releaseName,
    live: liveRelease
      ? {
          releaseName,
          rulesetName: liveRuleset,
          updateTime: liveRelease.updateTime || '',
        }
      : null,
    candidates,
    shown: candidates.slice(0, limit),
    target: target || null,
    problem,
  }
}

/** The plan as the lines a human reads before anything is written. */
export function renderPlan(plan, { apply = false } = {}) {
  const subject =
    plan.kind === 'hosting' ? `hosting site ${plan.site}` : `Firestore rules (${plan.releaseName})`
  const lines = [apply ? `Rollback — ${subject} — APPLY` : `Rollback plan — ${subject} — DRY RUN`]

  if (plan.kind === 'hosting') {
    lines.push(
      plan.live
        ? `  live release : ${plan.live.releaseName} (${plan.live.type}, ${plan.live.releaseTime}) → ${plan.live.versionName}`
        : '  live release : (none)'
    )
    lines.push(
      plan.shown.length
        ? '  older versions (newest first, the live version excluded):'
        : '  older versions (newest first, the live version excluded): none'
    )
    for (const candidate of plan.shown) {
      lines.push(
        `    - ${candidate.versionName}  released ${candidate.releaseTime || '(unknown)'} as ${candidate.releaseName || '(unknown)'} (${candidate.type})`
      )
    }
    if (plan.candidates.length > plan.shown.length) {
      lines.push(`    … ${plan.candidates.length - plan.shown.length} more (raise --limit)`)
    }
    if (plan.target) {
      lines.push('', `  would publish: ${plan.target.versionName} as a new release`)
      lines.push(
        `  request      : POST ${HOSTING_API}/sites/${plan.site}/releases?versionName=${plan.target.versionName}`
      )
    }
  } else {
    lines.push(
      plan.live
        ? `  live release : ${plan.live.releaseName} → ${plan.live.rulesetName} (updated ${plan.live.updateTime || '(unknown)'})`
        : '  live release : (none)'
    )
    lines.push(
      plan.shown.length
        ? '  older rulesets (newest first, the live one excluded):'
        : '  older rulesets (newest first, the live one excluded): none'
    )
    for (const candidate of plan.shown) {
      lines.push(`    - ${candidate.rulesetName}  created ${candidate.createTime || '(unknown)'}`)
    }
    if (plan.candidates.length > plan.shown.length) {
      lines.push(`    … ${plan.candidates.length - plan.shown.length} more (raise --limit)`)
    }
    if (plan.target) {
      lines.push(
        '',
        `  would copy   : the source of ${plan.target.rulesetName} into a new ruleset`,
        `  would move   : ${plan.releaseName} to that new ruleset`,
        `  requests     : POST ${RULES_API}/projects/${plan.project}/rulesets, then PATCH ${RULES_API}/${plan.releaseName}?updateMask=rulesetName`
      )
    }
  }

  if (plan.problem) lines.push('', `Refusing: ${plan.problem}`)
  else if (!apply) {
    lines.push(
      '',
      'Nothing was written. Re-run the same command with --apply to perform this plan.'
    )
  }
  return lines.join('\n')
}

/** The source files of a ruleset, as CreateRuleset accepts them. */
export function rulesFiles(ruleset) {
  return (ruleset?.source?.files || [])
    .filter((file) => typeof file.content === 'string' && file.content.length > 0)
    .map((file) => ({ name: file.name, content: file.content }))
}

/** A token-authenticated JSON client. `fetchImpl` is injected so tests stay offline. */
export function createApi(token, fetchImpl = fetch) {
  const call = async (method, url, body) => {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`${method} ${url} → HTTP ${res.status} ${text.slice(0, 400)}`)
    }
    return text ? JSON.parse(text) : {}
  }
  return {
    get: (url) => call('GET', url),
    post: (url, body = {}) => call('POST', url, body),
    patch: (url, body) => call('PATCH', url, body),
  }
}

async function applyHosting(api, plan) {
  const url = `${HOSTING_API}/sites/${plan.site}/releases?versionName=${plan.target.versionName}`
  const release = await api.post(url, {
    message: `Rollback to ${plan.target.versionName} (scripts/rollback-release.mjs)`,
  })
  return [
    `✓ published ${plan.target.versionName} as ${release.name || '(new release)'}`,
    'Next: npm run smoke:hosting — prove the live origin is the older bundle.',
  ]
}

async function applyRules(api, plan) {
  // Rulesets are immutable, so the old source is copied into a new ruleset and
  // the release is moved to it. GET is required because a ruleset's file
  // contents are omitted from list responses.
  const source = await api.get(`${RULES_API}/${plan.target.rulesetName}`)
  const files = rulesFiles(source)
  if (files.length === 0) {
    throw new Error(`${plan.target.rulesetName} returned no source content to copy.`)
  }
  const created = await api.post(`${RULES_API}/projects/${plan.project}/rulesets`, {
    source: { files },
  })
  await api.patch(`${RULES_API}/${plan.releaseName}?updateMask=rulesetName`, {
    name: plan.releaseName,
    rulesetName: created.name,
  })
  return [
    `✓ created ${created.name} from ${plan.target.rulesetName}`,
    `✓ moved ${plan.releaseName} to ${created.name}`,
    'Next: sign in and open one payment — a rules regression only shows on a real read/write.',
  ]
}

/** Read, plan, print, and only (with apply) write that printed plan. */
export async function run(args, fetchImpl = fetch) {
  const api = createApi(args.token, fetchImpl)
  const site = args.site || args.project

  let plan
  if (args.target === 'hosting') {
    const body = await api.get(`${HOSTING_API}/sites/${site}/releases?pageSize=100`)
    plan = planHosting({ site, releases: body.releases || [], to: args.to, limit: args.limit })
  } else {
    const [releaseBody, rulesetBody] = await Promise.all([
      api.get(`${RULES_API}/projects/${args.project}/releases?pageSize=100`),
      api.get(`${RULES_API}/projects/${args.project}/rulesets?pageSize=100`),
    ])
    plan = planRules({
      project: args.project,
      releases: releaseBody.releases || [],
      rulesets: rulesetBody.rulesets || [],
      release: args.release,
      to: args.to,
      limit: args.limit,
    })
  }

  console.log(renderPlan(plan, { apply: args.apply }))
  if (plan.problem || !args.apply) return { plan, applied: false }

  const lines =
    plan.kind === 'hosting' ? await applyHosting(api, plan) : await applyRules(api, plan)
  for (const line of lines) console.log(`  ${line}`)
  return { plan, applied: true }
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
  if (!args.project || !args.token) {
    usage()
    process.exit(2)
  }

  const { plan, applied } = await run(args)
  if (plan.problem) process.exit(1)
  if (applied) console.log('\nRollback applied.')
}

// Imported by the test file, which never wants the CLI to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nAborted: ${err?.message || err}`)
    process.exit(2)
  })
}
