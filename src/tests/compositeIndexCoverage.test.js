/**
 * Every query the app can issue must be satisfiable by a declared index.
 *
 * ## Why this test exists
 *
 * Firestore enforces composite indexes at QUERY time, not at deploy time. A
 * missing index is invisible in review and invisible in CI: the app builds, the
 * lint passes, every unit test passes, and a member presses a filter button in
 * production and gets `failed-precondition`.
 *
 * That is exactly what happened with the Frozen filter. It queries
 * `where('isFrozen', '==', true)` while ordering by `searchName`, which needs a
 * three-field composite. Only the `gymId + status + searchName` index existed, so
 * the filter would have failed for every gym the moment it was deployed — and it
 * was silently returning nothing in the meantime because `frozen` had been
 * unmatchable as a status value all along.
 *
 * This is a static check rather than an emulator test because the emulator does
 * NOT enforce composite indexes. A test suite run against it cannot catch a
 * missing index at all, which is precisely why this one went unnoticed.
 *
 * ## What it does
 *
 * Enumerates the query shapes the codebase can build — from the filter tables in
 * the UI, and from the call sites of the generic fetch path (scanned from source,
 * so a new collection cannot be forgotten here), plus the bounded range-query
 * module — and asserts a declared index satisfies each.
 *
 * ## How Firestore's rule is modelled
 *
 * A composite index's fields must match the query's equality fields and its
 * first orderBy, in that order. Firestore also supports single-field indexes
 * implicitly, so a query on one equality field with no orderBy needs no entry.
 * That single exception is modelled explicitly below rather than being waved
 * through, because over-approximating here would make the test useless.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import indexes from '../../firestore.indexes.json'
import { MEMBER_STATUS_FILTERS } from '@/utils/constants'
import { RANGE_FIELDS } from '@/services/rangeQueries'

/**
 * Declared indexes, reduced to comparable field lists.
 *
 * `fields` keeps the declared order but each entry is split on `:` when compared,
 * so the declared ASC/DESCENDING direction is deliberately NOT part of the
 * comparison — Firestore serves a descending query from an ascending index by
 * scanning it in reverse, so direction differences must not read as a gap.
 */
const DECLARED = indexes.indexes.map((entry) => ({
  collection: entry.collectionGroup,
  fields: entry.fields.map((f) => `${f.fieldPath}:${f.order}`),
}))

/**
 * Does a declared index satisfy this query?
 *
 * Firestore requires the index's field list to be `[...equalities, firstOrderBy]`,
 * matching in ORDER. A prefix match is not enough, but neither is an exact
 * string match: Firestore may scan an index in either direction, so a query
 * ordering `createdAt` descending is served by a declared ASCENDING entry. Only
 * the field SEQUENCE and the equality/order split are significant.
 *
 * @param {string} collection
 * @param {string[]} equalities  equality fields, in query order
 * @param {string} [firstOrderBy]  the single ordered field, if the query orders
 */
function satisfies(collection, equalities, firstOrderBy) {
  const wanted = [...equalities]
  if (firstOrderBy) wanted.push(firstOrderBy)

  if (!firstOrderBy) {
    // No ordering: a single equality rides the single-field index implicitly, so
    // only two or more equalities need a declared composite.
    if (equalities.length <= 1) return true
  }

  return DECLARED.some(
    (entry) =>
      entry.collection === collection &&
      entry.fields.length === wanted.length &&
      entry.fields.every((f, position) => f.split(':')[0] === wanted[position])
  )
}

/** The generic fetch path in services/firestore.js always scopes by gymId. */
const TENANT_SCOPE = 'gymId'

/** Every non-test source file under src/. */
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'tests' || entry === 'test' || entry.includes('.test.')) return []
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(js|jsx)$/.test(entry) ? [path] : []
  })
}

/**
 * Index of the `)` that closes the `(` at `openIndex`, or -1 when unbalanced.
 *
 * A bracket counter rather than a regex because the call options nest:
 * `listAll('payments', { where: { field: 'memberId', value } })`. The argument
 * text here never contains brackets inside string literals, so counting is safe.
 */
function closeParen(source, openIndex) {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The read shapes that carry an orderBy, DERIVED from the call sites.
 *
 * A hand-maintained list is how `leads` shipped with no index: the page was
 * added, the list was not, and nothing failed until a production query. So:
 *
 * - `useCollection(name)` and `subscribeCollection(name)` subscribe with
 *   `orderBy('createdAt', 'desc')` — always an ordered tenant read.
 * - `listAll(name)` adds that ordering only when it is NOT given a `where`
 *   option; with a single equality it deliberately skips the orderBy and rides
 *   the automatic single-field index.
 * - `usePaginatedCollection(name, options)` orders by `options.orderField`
 *   (`createdAt` by default) through `fetchPage`.
 */
function deriveOrderedReads() {
  const reads = new Map()
  const add = (collection, orderBy, file) => {
    const key = `${collection}|${orderBy}`
    if (!reads.has(key)) {
      reads.set(key, { collection, orderBy, source: relative(process.cwd(), file) })
    }
  }
  const argsOf = (source, match) => {
    const openIndex = match.index + match[0].indexOf('(')
    const end = closeParen(source, openIndex)
    return end === -1 ? '' : source.slice(openIndex, end)
  }

  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    const source = readFileSync(file, 'utf8')

    for (const match of source.matchAll(/\b(?:useCollection|subscribeCollection)\(\s*'([A-Za-z0-9_]+)'/g)) {
      add(match[1], 'createdAt', file)
    }

    for (const match of source.matchAll(/\blistAll\(\s*'([A-Za-z0-9_]+)'/g)) {
      if (!/\bwhere\s*:/.test(argsOf(source, match))) add(match[1], 'createdAt', file)
    }

    for (const match of source.matchAll(/\busePaginatedCollection\(\s*'([A-Za-z0-9_]+)'/g)) {
      const orderBy = argsOf(source, match).match(/orderField\s*:\s*'([A-Za-z0-9_]+)'/)?.[1]
      add(match[1], orderBy || 'createdAt', file)
    }
  }

  return [...reads.values()].sort(
    (a, b) => a.collection.localeCompare(b.collection) || a.orderBy.localeCompare(b.orderBy)
  )
}

/**
 * The chained calls that follow a `collection('name')` reference, e.g.
 * `.where('gymId', '==', gymId).orderBy('dueDate')`.
 *
 * Uses a sticky regex rather than \G (which JavaScript does not have) and the
 * bracket counter above to step over each argument list, so the chain can span
 * lines and nest parentheses.
 */
function chainCalls(source, startIndex) {
  const calls = []
  const call = /\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/y
  call.lastIndex = startIndex
  let match = call.exec(source)
  while (match) {
    const openIndex = call.lastIndex - 1
    const end = closeParen(source, openIndex)
    if (end === -1) break
    calls.push({ method: match[1], args: source.slice(openIndex + 1, end) })
    call.lastIndex = end + 1
    match = call.exec(source)
  }
  return calls
}

/** Admin-SDK write methods. A write never needs an index. */
const WRITE_METHODS = new Set(['add', 'set', 'update', 'delete'])

/**
 * The index requirement of one admin-SDK read chain.
 *
 * Firestore serves equality-only queries from single-field indexes (merge
 * join), and every index carries `__name__`, so ordering by document id is free
 * as well. What does need a composite is ordering by a DATA field, or a range /
 * `in` / array filter narrowed by another filter or an ordering.
 *
 * Returns null for a write. A filter or ordering it cannot read is returned with
 * `modelled: false` instead of being assumed harmless: the suite fails on those
 * so a new shape cannot slip through as "no index needed".
 *
 * @param {string} collection
 * @param {{ method: string, args: string }[]} calls
 */
function readShapeOf(collection, calls) {
  if (calls.some((call) => WRITE_METHODS.has(call.method))) return null

  const equalities = []
  let rangeFilters = 0
  let orderBy = null
  let modelled = true

  for (const call of calls) {
    if (call.method === 'where') {
      const parsed = call.args.match(/^\s*'([A-Za-z0-9_.]+)'\s*,\s*'([^']*)'/)
      if (!parsed) {
        modelled = false
      } else if (parsed[2] === '==') {
        equalities.push(parsed[1])
      } else {
        rangeFilters += 1
      }
    } else if (call.method === 'orderBy') {
      const named = call.args.match(/^\s*'([A-Za-z0-9_.]+)'/)
      if (named) orderBy = named[1]
      else if (/FieldPath\s*\.\s*documentId|'__name__'/.test(call.args)) orderBy = '__name__'
      else modelled = false
    }
  }

  const orderedByData = orderBy !== null && orderBy !== '__name__'
  const narrowedFurther = rangeFilters > 0 && (equalities.length > 0 || orderBy !== null)

  return {
    collection,
    equalities,
    orderBy,
    modelled,
    needsComposite: orderedByData || narrowedFurther,
    equalitiesText: equalities.length > 0 ? equalities.join(' + ') : '(no equality)',
  }
}

/** Every admin-SDK read in a snippet of source. */
function readsIn(source, file = 'inline') {
  const reads = []
  for (const match of source.matchAll(/\bcollection\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) {
    const shape = readShapeOf(match[1], chainCalls(source, match.index + match[0].length))
    if (shape) reads.push({ ...shape, source: file })
  }
  return reads
}

/** Every admin-SDK read in functions/, tests excluded. */
function deriveFunctionReads() {
  return sourceFiles(join(process.cwd(), 'functions')).flatMap((file) =>
    readsIn(readFileSync(file, 'utf8'), relative(process.cwd(), file))
  )
}

describe('composite index coverage', () => {
  describe('the members list', () => {
    it('covers the unfiltered list', () => {
      // usePaginatedCollection('members', { orderField: 'searchName' })
      expect(satisfies('members', [TENANT_SCOPE], 'searchName')).toBe(true)
    })

    it('covers every staff status filter', () => {
      for (const filter of MEMBER_STATUS_FILTERS) {
        const field = filter.field ?? 'status'
        expect(
          satisfies('members', [TENANT_SCOPE, field], 'searchName'),
          `missing index for members where ${field} == ${'filterValue' in filter ? filter.filterValue : filter.value}, ordered by searchName`
        ).toBe(true)
      }
    })

    it('covers the Frozen filter specifically', () => {
      // The regression that motivated this file. Asserted separately as well as
      // through the loop above so a future change to the filter table cannot
      // quietly remove this case.
      const frozen = MEMBER_STATUS_FILTERS.find((f) => f.value === 'frozen')
      expect(frozen).toBeDefined()
      expect(frozen.field).toBe('isFrozen')
      expect(frozen.op).toBe('==')
      expect(satisfies('members', [TENANT_SCOPE, 'isFrozen'], 'searchName')).toBe(true)
    })
  })

  describe('the generic list path', () => {
    // Derived from source, not listed by hand: a hand-kept list is exactly how
    // `leads` shipped without an index while CI stayed green.
    const orderedReads = deriveOrderedReads()

    it('derives reads from the call sites instead of a hand-kept list', () => {
      // Guards against a scan that silently stops matching anything and then
      // passes every case below by simply having none.
      expect(orderedReads.length).toBeGreaterThan(0)
      expect(orderedReads.map((read) => read.collection)).toEqual(
        // `leads` is the regression that motivated deriving this.
        expect.arrayContaining(['members', 'payments', 'leads'])
      )
    })

    it.each(orderedReads.map((read) => [read.collection, read.orderBy, read.source]))(
      'covers %s ordered by %s (read in %s)',
      (collection, orderBy) => {
        expect(satisfies(collection, [TENANT_SCOPE], orderBy)).toBe(true)
      }
    )
  })

  describe('bounded report range queries', () => {
    // rangeConstraints() emits gymId == X, field >= from, field <= to,
    // orderBy(field, 'asc'). So the field SEQUENCE is gymId then date.
    //
    // The range bounds are NOT equalities, which matters for how the shape is
    // built: a range field still occupies an index position, and it doubles as
    // the ordered field. Modelling it as an equality would happen to produce the
    // same field list here, but for the wrong reason - and it would silently
    // mis-model a query that ranged one field and ordered by another.
    const rangeShape = (collection, field) =>
      DECLARED.some(
        (entry) =>
          entry.collection === collection &&
          entry.fields.length === 2 &&
          entry.fields[0].split(':')[0] === TENANT_SCOPE &&
          entry.fields[1].split(':')[0] === field
      )

    it.each(Object.entries(RANGE_FIELDS))('%s is ranged on %s', (collection, field) => {
      expect(rangeShape(collection, field)).toBe(true)
    })

    it('confirms the range module is not silently querying an unmapped field', () => {
      // RANGE_FIELDS is the single source of truth for which collection maps to
      // which date field. If a report adds a collection and forgets to map it,
      // fetchRange throws at call time rather than returning a bounded result, so
      // this guards the mapping rather than the index.
      expect(Object.keys(RANGE_FIELDS).sort()).toEqual(['attendance', 'expenses', 'payments'])
    })
  })

  describe('the index file itself', () => {
    it('is well-formed JSON with the expected shape', () => {
      expect(Array.isArray(indexes.indexes)).toBe(true)
      expect(indexes.fieldOverrides).toBeDefined()
      for (const entry of indexes.indexes) {
        expect(typeof entry.collectionGroup).toBe('string')
        expect(entry.queryScope).toBe('COLLECTION')
        expect(entry.fields.length).toBeGreaterThan(0)
      }
    })

    it('has no exact duplicates', () => {
      // A duplicate is not harmful to Firestore but it signals that two features
      // were added independently without noticing they needed the same index,
      // which is the situation this file exists to make visible.
      const seen = new Set()
      const dupes = []
      for (const entry of indexes.indexes) {
        const key = `${entry.collectionGroup}|${entry.fields.map((f) => `${f.fieldPath}:${f.order}`).join('|')}`
        if (seen.has(key)) dupes.push(key)
        seen.add(key)
      }
      expect(dupes).toEqual([])
    })
  })

  describe('Cloud Functions (admin SDK) queries', () => {
    // The projection jobs query Firestore with the admin SDK, which enforces
    // composite indexes exactly like the client SDK. They are deployed by a
    // separate workflow, so a missing index surfaces as a failing sweep in
    // production rather than in the page that added it. Scanned from source for
    // the same reason as the client reads above.
    const functionReads = deriveFunctionReads()
    const needingIndex = functionReads.filter((read) => read.needsComposite)

    it('scans the Cloud Functions sources', () => {
      expect(functionReads.length).toBeGreaterThan(0)
      expect(functionReads.map((read) => read.collection)).toEqual(
        expect.arrayContaining(['members', 'memberships', 'membershipFreezes', 'membershipPlans', 'gyms'])
      )
    })

    it('models every chain it scans, so an unparsed shape fails loudly', () => {
      // A filter or ordering it cannot read must not be waved through as
      // "needs no index": that is how a gap reaches production.
      expect(functionReads.filter((read) => !read.modelled)).toEqual([])
    })

    it('treats a documentId ordering as needing no composite', () => {
      // `orderBy(FieldPath.documentId())` is `__name__`, which every single-field
      // index already carries, so it adds no index requirement.
      const [read] = readsIn("db.collection('members').where('gymId', '==', gymId).orderBy(FieldPath.documentId())")
      expect(read.orderBy).toBe('__name__')
      expect(read.needsComposite).toBe(false)
    })

    it('needs no composite for equality-only reads', () => {
      // Firestore serves multiple equality filters by merging single-field
      // indexes, so no composite entry is required for this shape.
      const [read] = readsIn(
        "db.collection('memberships').where('memberId', '==', memberId).where('gymId', '==', gymId)"
      )
      expect(read.equalities).toEqual(['memberId', 'gymId'])
      expect(read.needsComposite).toBe(false)
    })

    it('flags an ordering by a data field as a gap the index file must close', () => {
      const [read] = readsIn("db.collection('members').where('gymId', '==', gymId).orderBy('dueDate')")
      expect(read.needsComposite).toBe(true)
      // And it really is a gap: no declared index has that shape.
      expect(satisfies(read.collection, read.equalities, read.orderBy)).toBe(false)
    })

    it('skips writes, which never need an index', () => {
      expect(readsIn("db.collection('auditLog').add({ gymId, at })")).toEqual([])
    })

    it.each(needingIndex)(
      'declares an index for $collection ($equalitiesText ordered by $orderBy, from $source)',
      (read) => {
        expect(satisfies(read.collection, read.equalities, read.orderBy)).toBe(true)
      }
    )
  })
})