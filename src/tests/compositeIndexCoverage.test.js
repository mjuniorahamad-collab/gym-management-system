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
 * the UI, the generic fetch path, and the bounded range-query module — and
 * asserts a declared index satisfies each.
 *
 * ## How Firestore's rule is modelled
 *
 * A composite index's fields must match the query's equality fields and its
 * first orderBy, in that order. Firestore also supports single-field indexes
 * implicitly, so a query on one equality field with no orderBy needs no entry.
 * That single exception is modelled explicitly below rather than being waved
 * through, because over-approximating here would make the test useless.
 */
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
    // Every collection read through useCollection/fetchPage orders by createdAt
    // within the tenant scope. This is the single most common query shape in the
    // app, so it is checked as a block.
    const TENANT_SCOPED_COLLECTIONS = [
      'members',
      'membershipPlans',
      'membershipFreezes',
      'memberships',
      'payments',
      'expenses',
      'attendance',
      'classes',
      'bookings',
      'trainers',
      'auditLog',
      'counters',
      'weightRecords',
    ]

    it.each(TENANT_SCOPED_COLLECTIONS)('covers %s ordered by createdAt', (collection) => {
      expect(satisfies(collection, [TENANT_SCOPE], 'createdAt')).toBe(true)
    })
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
})