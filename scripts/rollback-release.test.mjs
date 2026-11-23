/**
 * Unit tests for `scripts/rollback-release.mjs`.
 *
 * A rollback script is used under pressure, on live infrastructure, and the one
 * mistake that matters is writing when it should only have planned. So these
 * tests pin the two guarantees the README promises:
 *
 *   1. Without `--apply` the script issues GET requests only — no POST, no PATCH.
 *   2. With `--apply` the writes are the ones it printed: a hosting rollback
 *      re-releases the previous *version* (never the live one), and a rules
 *      rollback copies the old source into a new ruleset before moving the
 *      release pointer.
 *
 * `fetch` is injected, so nothing here touches Google's APIs.
 */

import { describe, expect, it } from 'vitest'
import {
  parseArgs,
  planHosting,
  planRules,
  renderPlan,
  rulesFiles,
  run,
} from './rollback-release.mjs'

const HOSTING_RELEASES = [
  {
    name: 'sites/gym/releases/live',
    type: 'DEPLOY',
    releaseTime: '2026-11-23T02:54:00Z',
    version: { name: 'sites/gym/versions/v3' },
  },
  {
    // A rollback re-released v1; v1 must not be offered twice.
    name: 'sites/gym/releases/rollback',
    type: 'ROLLBACK',
    releaseTime: '2026-11-22T10:00:00Z',
    version: { name: 'sites/gym/versions/v1' },
  },
  {
    name: 'sites/gym/releases/v1',
    type: 'DEPLOY',
    releaseTime: '2026-11-21T10:00:00Z',
    version: { name: 'sites/gym/versions/v1' },
  },
  {
    name: 'sites/gym/releases/disabled',
    type: 'SITE_DISABLE',
    releaseTime: '2026-11-20T10:00:00Z',
  },
]

const RULES_RELEASES = [
  {
    name: 'projects/gym/releases/cloud.firestore',
    rulesetName: 'projects/gym/rulesets/live',
    updateTime: '2026-11-23T03:00:00Z',
  },
]
const RULES_RULESETS = [
  { name: 'projects/gym/rulesets/live', createTime: '2026-11-23T02:59:00Z' },
  { name: 'projects/gym/rulesets/previous', createTime: '2026-11-22T09:00:00Z' },
  { name: 'projects/gym/rulesets/older', createTime: '2026-11-20T09:00:00Z' },
]

/** A fetch stand-in that records every call and answers from a route table. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const method = init.method || 'GET'
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined })
    const route = routes[method] || routes['*']
    const match = Object.entries(route || {}).find(([fragment]) => url.includes(fragment))
    const payload = match ? match[1] : {}
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    }
  }
  return { impl, calls, writes: () => calls.filter((call) => call.method !== 'GET') }
}

const HOSTING_ARGS = {
  target: 'hosting',
  project: 'gym',
  token: 'test-token',
  site: '',
  release: 'cloud.firestore',
  to: '',
  limit: 5,
  apply: false,
}

describe('parseArgs', () => {
  it('defaults to a hosting dry run', () => {
    expect(parseArgs([])).toMatchObject({ target: 'hosting', apply: false, limit: 5 })
  })

  it('treats --apply as a flag and keeps the rest of the plan', () => {
    expect(parseArgs(['--target=rules', '--apply'])).toMatchObject({
      target: 'rules',
      apply: true,
    })
  })

  it('rejects an unknown target and a non-positive limit', () => {
    expect(() => parseArgs(['--target=indexes'])).toThrow(/must be hosting or rules/)
    expect(() => parseArgs(['--limit=0'])).toThrow(/positive integer/)
  })
})

describe('planHosting', () => {
  it('offers the previous version, never the live one, and de-duplicates repeats', () => {
    const plan = planHosting({ site: 'gym', releases: HOSTING_RELEASES })
    expect(plan.live).toMatchObject({ versionName: 'sites/gym/versions/v3', type: 'DEPLOY' })
    expect(plan.candidates.map((candidate) => candidate.versionName)).toEqual([
      'sites/gym/versions/v1',
    ])
    // The SITE_DISABLE entry carries no version and must not become a candidate.
    expect(plan.candidates.some((candidate) => !candidate.versionName)).toBe(false)
    expect(plan.problem).toBe('')
  })

  it('refuses when there is no older version to go back to', () => {
    const plan = planHosting({ site: 'gym', releases: [HOSTING_RELEASES[0]] })
    expect(plan.target).toBeNull()
    expect(plan.problem).toMatch(/nothing to roll back to/)
  })

  it('refuses a --to that is not an older version', () => {
    const plan = planHosting({ site: 'gym', releases: HOSTING_RELEASES, to: 'v9' })
    expect(plan.target).toBeNull()
    expect(plan.problem).toMatch(/not one of the older versions/)
  })
})

describe('planRules', () => {
  it('offers the newest older ruleset and excludes the live one', () => {
    const plan = planRules({
      project: 'gym',
      releases: RULES_RELEASES,
      rulesets: RULES_RULESETS,
    })
    expect(plan.live.rulesetName).toBe('projects/gym/rulesets/live')
    expect(plan.target.rulesetName).toBe('projects/gym/rulesets/previous')
  })

  it('accepts a bare ruleset id for --to', () => {
    const plan = planRules({
      project: 'gym',
      releases: RULES_RELEASES,
      rulesets: RULES_RULESETS,
      to: 'older',
    })
    expect(plan.target.rulesetName).toBe('projects/gym/rulesets/older')
  })

  it('refuses when the rules were never released', () => {
    const plan = planRules({ project: 'gym', releases: [], rulesets: RULES_RULESETS })
    expect(plan.problem).toMatch(/never been deployed/)
  })
})

describe('run — dry run by default', () => {
  it('issues GET requests only and prints the plan', async () => {
    const fake = fakeFetch({ '*': { '/releases': { releases: HOSTING_RELEASES } } })
    const result = await run(HOSTING_ARGS, fake.impl)

    expect(result.applied).toBe(false)
    expect(fake.writes()).toEqual([])
    expect(fake.calls.every((call) => call.method === 'GET')).toBe(true)
    expect(result.plan.target.versionName).toBe('sites/gym/versions/v1')
  })

  it('does not write even when the plan is bad', async () => {
    const fake = fakeFetch({ '*': { '/releases': { releases: [HOSTING_RELEASES[0]] } } })
    const result = await run(HOSTING_ARGS, fake.impl)
    expect(result.plan.problem).toBeTruthy()
    expect(fake.writes()).toEqual([])
  })

  it('renders a dry run that says nothing was written', () => {
    const plan = planHosting({ site: 'gym', releases: HOSTING_RELEASES })
    const text = renderPlan(plan)
    expect(text).toContain('DRY RUN')
    expect(text).toContain('Nothing was written')
  })
})

describe('run — apply does exactly the printed plan', () => {
  it('re-releases the previous hosting version with a single POST', async () => {
    const fake = fakeFetch({
      '*': { '/releases': { releases: HOSTING_RELEASES } },
      POST: { '/releases?versionName=': { name: 'sites/gym/releases/new' } },
    })
    const result = await run({ ...HOSTING_ARGS, apply: true }, fake.impl)

    expect(result.applied).toBe(true)
    expect(fake.writes()).toHaveLength(1)
    expect(fake.writes()[0]).toMatchObject({ method: 'POST' })
    expect(fake.writes()[0].url).toContain('/sites/gym/releases?versionName=sites/gym/versions/v1')
  })

  it('copies the old rules source into a new ruleset, then moves the release', async () => {
    const fake = fakeFetch({
      GET: {
        '/releases': { releases: RULES_RELEASES },
        '/rulesets?': { rulesets: RULES_RULESETS },
        '/rulesets/previous': {
          name: 'projects/gym/rulesets/previous',
          source: {
            files: [{ name: 'firestore.rules', content: 'rules_version = "2";' }],
          },
        },
      },
      POST: { '/rulesets': { name: 'projects/gym/rulesets/copied' } },
      PATCH: { '/releases/cloud.firestore': { name: 'projects/gym/releases/cloud.firestore' } },
    })
    const result = await run({ ...HOSTING_ARGS, target: 'rules', apply: true }, fake.impl)

    expect(result.applied).toBe(true)
    const [created, moved] = fake.writes()
    expect(created).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/projects/gym/rulesets'),
      body: { source: { files: [{ name: 'firestore.rules', content: 'rules_version = "2";' }] } },
    })
    expect(moved).toMatchObject({
      method: 'PATCH',
      url: expect.stringContaining('updateMask=rulesetName'),
      body: {
        name: 'projects/gym/releases/cloud.firestore',
        rulesetName: 'projects/gym/rulesets/copied',
      },
    })
  })

  it('refuses an empty ruleset source instead of moving the release to it', async () => {
    const fake = fakeFetch({
      GET: {
        '/releases': { releases: RULES_RELEASES },
        '/rulesets?': { rulesets: RULES_RULESETS },
        '/rulesets/previous': { name: 'projects/gym/rulesets/previous', source: { files: [] } },
      },
      POST: { '/rulesets': { name: 'projects/gym/rulesets/copied' } },
    })

    await expect(run({ ...HOSTING_ARGS, target: 'rules', apply: true }, fake.impl)).rejects.toThrow(
      /no source content/
    )
    expect(fake.writes()).toEqual([])
  })
})

describe('rulesFiles', () => {
  it('keeps only files with content, dropping the read-only fingerprint', () => {
    expect(
      rulesFiles({
        source: {
          files: [
            {
              name: 'firestore.rules',
              content: 'match /x { allow read: true; }',
              fingerprint: 'abc',
            },
            { name: 'empty.rules', content: '' },
          ],
        },
      })
    ).toEqual([{ name: 'firestore.rules', content: 'match /x { allow read: true; }' }])
  })
})
