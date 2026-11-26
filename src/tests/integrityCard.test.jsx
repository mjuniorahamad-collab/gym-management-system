import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

/**
 * DATA INTEGRITY CARD.
 *
 * The states matter more than the styling: "no report yet" must never read as
 * "all clear", drift must name what disagrees, a read failure must not imply
 * health, and a partial cycle must keep coverage and evidence visibly separate.
 */
const mocks = vi.hoisted(() => ({ fetchDuesDriftReport: vi.fn() }))
vi.mock('@/services/integrity', () => ({ fetchDuesDriftReport: mocks.fetchDuesDriftReport }))

const { IntegrityCard } = await import('@/components/settings/IntegrityCard')

const report = (over = {}) => ({
  gymId: 'g1',
  complete: true,
  generatedAt: '2026-11-17T03:30:00.000Z',
  coverage: { membersScanned: 4, periodsScanned: 6 },
  evidence: { scope: 'cycle', members: 0, periods: 0, sample: [] },
  clean: true,
  ...over,
})

const driftedRow = {
  memberId: 'm1',
  memberName: 'Bibek Magar',
  periodId: 'p1',
  fields: ['amountDue', 'paymentStatus'],
  stored: { amountPaid: 0, amountDue: 0, paymentStatus: 'paid' },
  expected: { amountPaid: 0, amountDue: 2500, paymentStatus: 'due' },
}

beforeEach(() => {
  mocks.fetchDuesDriftReport.mockReset()
})

describe('IntegrityCard', () => {
  it('says a clean report is clean, with what was covered', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({ ok: true, report: report() })
    render(<IntegrityCard />)

    expect(await screen.findByText('No drift found')).toBeTruthy()
    expect(screen.getByText(/6 membership periods across 4 members/)).toBeTruthy()
  })

  it('names the drifted periods and says nothing was changed', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({
      ok: true,
      report: report({
        clean: false,
        evidence: { scope: 'cycle', members: 1, periods: 1, sample: [driftedRow] },
      }),
    })
    render(<IntegrityCard />)

    expect(await screen.findByText(/1 period disagree with the ledger/)).toBeTruthy()
    expect(screen.getByText('Bibek Magar')).toBeTruthy()
    expect(screen.getByText(/deliberate price edit is not drift/)).toBeTruthy()
    // One line per disagreeing field: stored → ledger.
    expect(screen.getByText('amountDue: 0 → 2500')).toBeTruthy()
    expect(screen.getByText('paymentStatus: paid → due')).toBeTruthy()
  })

  it('never presents a partial (large-gym) check as clean', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({
      ok: true,
      report: report({
        complete: false,
        clean: undefined,
        nextCursor: 'member-400',
        coverage: { membersScanned: 400, periodsScanned: 520 },
        evidence: { scope: 'page', members: 0, periods: 0, sample: [] },
      }),
    })
    render(<IntegrityCard />)

    expect(await screen.findByText(/Partial check/)).toBeTruthy()
    expect(screen.getByText(/not an all-clear/)).toBeTruthy()
    expect(screen.queryByText('No drift found')).toBeNull()
  })

  it('labels coverage and evidence separately on a partial cycle', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({
      ok: true,
      report: report({
        complete: false,
        clean: undefined,
        nextCursor: 'member-400',
        coverage: { membersScanned: 400, periodsScanned: 520 },
        evidence: { scope: 'page', members: 1, periods: 2, sample: [driftedRow] },
      }),
    })
    render(<IntegrityCard />)

    // Coverage is cumulative, evidence is this page — the card must not blend them.
    expect(await screen.findByText(/400 members scanned so far/)).toBeTruthy()
    expect(screen.getByText(/this run’s page only/)).toBeTruthy()
    expect(screen.getByText(/2 periods disagree with the ledger/)).toBeTruthy()
  })

  it('does not present a missing report as healthy', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({ ok: true, report: null })
    render(<IntegrityCard />)

    expect(await screen.findByText(/No report yet/)).toBeTruthy()
    expect(screen.getByText(/not the same as/)).toBeTruthy()
    expect(screen.queryByText('No drift found')).toBeNull()
  })

  it('reports a read failure instead of implying health', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({ ok: false, reason: 'permission-denied' })
    render(<IntegrityCard />)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/could not be read/)).toBeTruthy()
    expect(screen.queryByText('No drift found')).toBeNull()
  })

  it('explains that demo mode has no reconciliation job', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({ ok: false, reason: 'offline-mode' })
    render(<IntegrityCard />)

    await waitFor(() => expect(screen.getByText(/Not running in this environment/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The callables are not deployed for this project (Functions v2 needs a billing
  // plan), so the card must say that plainly. A red "could not be read" panel read
  // as broken data at handover and made Settings look unhealthy.
  it('says the job is not deployed instead of showing a red error', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({ ok: false, reason: 'not-deployed' })
    render(<IntegrityCard />)

    await waitFor(() => expect(screen.getByText(/Not running in this environment/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })

  it('treats a missing callable as "not deployed", not as a data failure', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({ ok: false, reason: 'functions/not-found' })
    render(<IntegrityCard />)

    await waitFor(() => expect(screen.getByText(/Not running in this environment/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still reports a real refusal as an error', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({ ok: false, reason: 'functions/permission-denied' })
    render(<IntegrityCard />)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/could not be read/)).toBeTruthy()
  })
})
