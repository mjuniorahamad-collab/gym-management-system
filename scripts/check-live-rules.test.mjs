/**
 * Unit tests for `scripts/check-live-rules.mjs`.
 *
 * The check is the only thing that can tell a reviewer whether production
 * enforces the reviewed `firestore.rules` or an older ruleset. A false "match"
 * here would be a silent security claim, so every verdict — match, mismatch,
 * never deployed, unreadable — is covered, plus the CRLF normalisation that keeps
 * a Windows checkout from reporting the whole file as different, on every
 * `npm test` (the CI `app` job).
 *
 * The Rules API is stubbed: no credentials, no network, no deploy.
 */

import { describe, expect, it } from 'vitest'
import {
  checkLiveRules,
  compareRules,
  normalizeRules,
  parseArgs,
  pickFirestoreFile,
  renderResult,
} from './check-live-rules.mjs'

const PROJECT = 'himalye-wonders-gym'
const RELEASES_URL = `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases?pageSize=100`
const RULESET_URL = `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets/live-1`

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /members/{id} {
      allow read: if request.auth != null;
    }
  }
}
`

/** Stub fetch: `routes` maps a URL to `{ status?, body }`; records every call. */
function stubFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) return { ok: false, status: 404, text: async () => `no stub for ${url}` }
    const status = route.status ?? 200
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {})
    return { ok: status < 400, status, text: async () => body }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** A live release pointing at a ruleset that serves `content`. */
function liveProject(content = RULES, extra = {}) {
  return {
    [RELEASES_URL]: {
      body: {
        releases: [
          {
            name: `projects/${PROJECT}/releases/cloud.storage`,
            rulesetName: 'projects/x/rulesets/s1',
          },
          {
            name: `projects/${PROJECT}/releases/cloud.firestore`,
            rulesetName: `projects/${PROJECT}/rulesets/live-1`,
            updateTime: '2026-09-30T10:00:00Z',
            ...extra,
          },
        ],
      },
    },
    [RULESET_URL]: {
      body: {
        name: `projects/${PROJECT}/rulesets/live-1`,
        source: { files: [{ name: 'firestore.rules', content }] },
      },
    },
  }
}

const check = (routes, localText = RULES) =>
  checkLiveRules({ project: PROJECT, token: 'test-token', localText, fetchImpl: stubFetch(routes) })

describe('normalizeRules', () => {
  it('treats CRLF, trailing whitespace and a missing final newline as equal', () => {
    const windows = RULES.replaceAll('\n', '\r\n').replace(
      'allow read: if request.auth != null;',
      'allow read: if request.auth != null;   '
    )
    expect(normalizeRules(windows)).toBe(normalizeRules(RULES))
  })

  it('keeps inner blank lines, only trailing ones go', () => {
    expect(normalizeRules('a\n\nb\n\n\n')).toBe('a\n\nb')
  })

  it('handles null and undefined as empty', () => {
    expect(normalizeRules(null)).toBe('')
    expect(normalizeRules(undefined)).toBe('')
  })
})

describe('compareRules', () => {
  it('reports a match with the line count', () => {
    const result = compareRules(RULES, RULES)

    expect(result).toMatchObject({ same: true, differences: [] })
    expect(result.localLines).toBe(normalizeRules(RULES).split('\n').length)
  })

  it('reports the line number and both sides of each difference', () => {
    const live = RULES.replace('allow read: if request.auth != null;', 'allow read: if true;')
    const result = compareRules(RULES, live)

    expect(result.same).toBe(false)
    expect(result.differences).toHaveLength(1)
    expect(result.differences[0].line).toBe(5)
    expect(result.differences[0].repo).toContain('request.auth != null')
    expect(result.differences[0].live).toContain('if true')
  })

  it('treats an insertion as one difference, not a shifted wall of noise', () => {
    const live = RULES.replace(
      'service cloud.firestore {',
      '// added in the console\nservice cloud.firestore {'
    )
    const result = compareRules(RULES, live)

    expect(result.same).toBe(false)
    expect(result.liveLines).toBe(result.localLines + 1)
    expect(result.differences[0]).toMatchObject({ line: 2 })
    expect(result.differences[0].repo).toBe('service cloud.firestore {')
    expect(result.differences[0].live).toBe('// added in the console')
  })

  it('reports a missing trailing line instead of skipping it', () => {
    const live = normalizeRules(RULES).split('\n').slice(0, -1).join('\n')
    const result = compareRules(RULES, live)

    expect(result.same).toBe(false)
    expect(result.differences.at(-1)).toEqual({ line: 8, repo: '}', live: null })
  })

  it('caps the number of differences it prints', () => {
    const result = compareRules('a\nb\nc\nd\ne\nf\n', '1\n2\n3\n4\n5\n6\n', { maxDifferences: 3 })

    expect(result.differences).toHaveLength(3)
  })
})

describe('pickFirestoreFile', () => {
  it('prefers the file named firestore.rules', () => {
    const file = pickFirestoreFile([
      { name: 'storage.rules', content: 'a' },
      { name: 'firestore.rules', content: 'b' },
    ])

    expect(file).toEqual({ name: 'firestore.rules', content: 'b' })
  })

  it('accepts a full path that ends in firestore.rules', () => {
    expect(pickFirestoreFile([{ name: 'acme/firestore.rules', content: 'b' }]).content).toBe('b')
  })

  it('falls back to a single unnamed file', () => {
    expect(pickFirestoreFile([{ name: '', content: 'only' }]).content).toBe('only')
  })

  it('refuses several files when none is firestore.rules', () => {
    expect(
      pickFirestoreFile([
        { name: 'a.rules', content: 'a' },
        { name: 'b.rules', content: 'b' },
      ])
    ).toBeNull()
  })

  it('ignores entries without content', () => {
    expect(pickFirestoreFile([{ name: 'firestore.rules' }])).toBeNull()
  })
})

describe('checkLiveRules', () => {
  it('matches when the live ruleset is this file', async () => {
    const result = await check(liveProject())

    expect(result.status).toBe('match')
    expect(result.rulesetName).toBe(`projects/${PROJECT}/rulesets/live-1`)
    expect(result.updateTime).toBe('2026-09-30T10:00:00Z')
  })

  it('matches a Windows checkout against the same file deployed from Linux', async () => {
    const windows = RULES.replaceAll('\n', '\r\n')
    expect((await check(liveProject(), windows)).status).toBe('match')
  })

  it('follows only the cloud.firestore release, not another service’s', async () => {
    const routes = liveProject()
    const result = await check(routes)

    expect(result.rulesetName).not.toContain('cloud.storage')
    expect(routes[RULESET_URL].body.name).toContain('live-1')
  })

  it('reports a mismatch with the differing lines', async () => {
    const live = RULES.replace('allow read: if request.auth != null;', 'allow read: if true;')
    const result = await check(liveProject(live))

    expect(result.status).toBe('mismatch')
    expect(result.differences[0].line).toBe(5)
    expect(result.differences[0].live).toContain('if true')
  })

  it('reports rules that were never released instead of pretending they match', async () => {
    const result = await check({ [RELEASES_URL]: { body: { releases: [] } } })

    expect(result.status).toBe('undeployed')
    expect(renderResult(result)).toContain('never been released')
  })

  it('reports a 403 as "could not check" and names the role', async () => {
    const routes = liveProject()
    routes[RELEASES_URL] = { status: 403, body: '{"error":{"status":"PERMISSION_DENIED"}}' }
    const result = await check(routes)

    expect(result.status).toBe('error')
    expect(result.problem).toContain('HTTP 403')
    expect(renderResult(result)).toContain('roles/firebaserules.viewer')
  })

  it('reports an unreachable API without throwing', async () => {
    const fetchImpl = async () => {
      throw new Error('getaddrinfo ENOTFOUND firebaserules.googleapis.com')
    }
    const result = await checkLiveRules({
      project: PROJECT,
      token: 't',
      localText: RULES,
      fetchImpl,
    })

    expect(result.status).toBe('error')
    expect(result.problem).toContain('ENOTFOUND')
  })

  it('refuses a ruleset with no readable source', async () => {
    const routes = liveProject()
    routes[RULESET_URL] = { body: { name: 'x', source: { files: [] } } }
    const result = await check(routes)

    expect(result.status).toBe('error')
    expect(result.problem).toContain('no single Firestore source file')
  })

  it('only issues GET requests — it must never deploy, test or release', async () => {
    const routes = liveProject()
    const fetchImpl = stubFetch(routes)
    await checkLiveRules({ project: PROJECT, token: 't', localText: RULES, fetchImpl })

    expect(fetchImpl.calls).toHaveLength(2)
    for (const call of fetchImpl.calls) {
      expect(call.init?.method ?? 'GET').toBe('GET')
      expect(call.init?.body).toBeUndefined()
      expect(call.url).not.toContain(':test')
    }
  })
})

describe('renderResult', () => {
  it('states a match with the ruleset and release time', () => {
    const text = renderResult(
      {
        status: 'match',
        releaseName: `projects/${PROJECT}/releases/cloud.firestore`,
        rulesetName: `projects/${PROJECT}/rulesets/live-1`,
        updateTime: '2026-09-30T10:00:00Z',
        localLines: 9,
        liveFile: 'firestore.rules',
      },
      { rulesPath: 'firestore.rules' }
    )

    expect(text).toContain('matches firestore.rules (9 lines)')
    expect(text).toContain('rulesets/live-1')
    expect(text).toContain('2026-09-30T10:00:00Z')
  })

  it('truncates a very long differing line', () => {
    const text = renderResult({
      status: 'mismatch',
      releaseName: 'projects/p/releases/cloud.firestore',
      rulesetName: 'projects/p/rulesets/live-1',
      localLines: 2,
      liveLines: 2,
      differences: [{ line: 1, repo: `repo ${'x'.repeat(400)}`, live: 'live' }],
    })

    expect(text).toContain('…')
    expect(text.length).toBeLessThan(1200)
  })
})

describe('parseArgs', () => {
  it('uses the documented defaults and .firebaserc-independent empty project', () => {
    expect(parseArgs([], {})).toEqual({
      project: '',
      token: '',
      release: 'cloud.firestore',
      rules: 'firestore.rules',
    })
  })

  it('reads the token from GOOGLE_ACCESS_TOKEN', () => {
    expect(parseArgs([], { GOOGLE_ACCESS_TOKEN: 'env-token' }).token).toBe('env-token')
  })

  it('lets a flag override the environment token', () => {
    expect(parseArgs(['--access-token=flag'], { GOOGLE_ACCESS_TOKEN: 'env' }).token).toBe('flag')
  })

  it('accepts a token containing "="', () => {
    expect(parseArgs(['--access-token=ya29.a=b=c'], {}).token).toBe('ya29.a=b=c')
  })

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--tokens=abc'], {})).toThrow(/Unknown option --tokens/)
  })
})
