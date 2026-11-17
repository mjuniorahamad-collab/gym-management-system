import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

/**
 * DATA INTEGRITY CARD.
 *
 * The states matter more than the styling: "no report yet" must never read as
 * "all clear", drift must name what disagrees, and a read failure must not imply
 * health.
 */
const mocks = vi.hoisted(() => ({ fetchDuesDriftReport: vi.fn() }))
vi.mock('@/services/integrity', () => ({ fetchDuesDriftReport: mocks.fetchDuesDriftReport }))

const { IntegrityCard } = await import('@/components/settings/IntegrityCard')

beforeEach(() => {
  mocks.fetchDuesDriftReport.mockReset()
})

describe('IntegrityCard', () => {
  it('says a clean report is clean, with what was scanned', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({
      ok: true,
      report: {
        clean: true,
        membersScanned: 4,
        periodsScanned: 6,
        driftedMembers: 0,
        driftedPeriods: 0,
        generatedAt: '2026-11-17T03:30:00.000Z',
        sample: [],
      },
    })
    render(<IntegrityCard />)

    expect(await screen.findByText('No drift found')).toBeTruthy()
    expect(screen.getByText(/6 membership periods across 4 members/)).toBeTruthy()
  })

  it('names the drifted periods and says nothing was changed', async () => {
    mocks.fetchDuesDriftReport.mockResolvedValue({
      ok: true,
      report: {
        clean: false,
        membersScanned: 1,
        periodsScanned: 1,
        driftedMembers: 1,
        driftedPeriods: 1,
        generatedAt: '2026-11-17T03:30:00.000Z',
        sample: [
          {
            memberId: 'm1',
            memberName: 'Bibek Magar',
            periodId: 'p1',
            fields: ['amountDue', 'paymentStatus'],
            stored: { amountPaid: 0, amountDue: 0, paymentStatus: 'paid' },
            expected: { amountPaid: 0, amountDue: 2500, paymentStatus: 'due' },
          },
        ],
      },
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
      report: {
        complete: false,
        nextCursor: 'member-400',
        membersScanned: 400,
        periodsScanned: 520,
        driftedMembers: 0,
        driftedPeriods: 0,
        generatedAt: '2026-11-17T03:30:00.000Z',
        sample: [],
      },
    })
    render(<IntegrityCard />)

    expect(await screen.findByText(/Partial check/)).toBeTruthy()
    expect(screen.getByText(/not an all-clear/)).toBeTruthy()
    expect(screen.queryByText('No drift found')).toBeNull()
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

    await waitFor(() => expect(screen.getByText(/Available in a deployed environment/)).toBeTruthy())
  })
})
