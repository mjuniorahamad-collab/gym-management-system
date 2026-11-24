import { describe, expect, it } from 'vitest'
import {
  LEAD_STATUS_VALUES,
  countFollowUps,
  isLeadOpen,
  leadFollowUpState,
  leadStatusLabel,
  matchesLeadFollowUp,
  matchesLeadSearch,
  sortLeads,
} from '@/utils/leads'

const TODAY = '2026-03-10'

function lead(overrides = {}) {
  return {
    id: 'l1',
    name: 'Rahul Sharma',
    phone: '9800000001',
    status: 'new',
    followUpDate: '',
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

describe('leadFollowUpState', () => {
  it('marks a past date overdue and today due today', () => {
    expect(leadFollowUpState(lead({ followUpDate: '2026-03-09' }), TODAY)).toBe('overdue')
    expect(leadFollowUpState(lead({ followUpDate: TODAY }), TODAY)).toBe('today')
    expect(leadFollowUpState(lead({ followUpDate: '2026-03-11' }), TODAY)).toBe('upcoming')
  })

  it('is none when no follow-up date is set', () => {
    expect(leadFollowUpState(lead(), TODAY)).toBe('none')
    expect(leadFollowUpState(null, TODAY)).toBe('none')
  })

  /**
   * A joined or lost lead is finished. Its old date must not keep it in the
   * overdue call list forever, which is exactly what a naive date comparison
   * would do.
   */
  it('treats joined and lost leads as closed regardless of the date', () => {
    expect(leadFollowUpState(lead({ status: 'joined', followUpDate: '2026-01-01' }), TODAY)).toBe('closed')
    expect(leadFollowUpState(lead({ status: 'lost', followUpDate: '2026-01-01' }), TODAY)).toBe('closed')
  })

  it('reads a Firestore timestamp for the follow-up date', () => {
    const stamp = { toDate: () => new Date('2026-03-12T00:00:00.000Z') }
    expect(leadFollowUpState(lead({ followUpDate: stamp }), TODAY)).toBe('upcoming')
  })
})

describe('countFollowUps', () => {
  it('counts only open leads that are due today or overdue', () => {
    const counts = countFollowUps(
      [
        lead({ id: 'a', followUpDate: '2026-03-09' }),
        lead({ id: 'b', followUpDate: TODAY }),
        lead({ id: 'c', followUpDate: '2026-03-12' }),
        lead({ id: 'd', status: 'joined', followUpDate: '2026-03-09' }),
      ],
      TODAY
    )
    expect(counts).toEqual({ today: 1, overdue: 1 })
  })

  it('returns zeros for an empty list', () => {
    expect(countFollowUps([], TODAY)).toEqual({ today: 0, overdue: 0 })
  })
})

describe('matchesLeadFollowUp', () => {
  it('filters by state and passes everything for all', () => {
    const overdue = lead({ followUpDate: '2026-03-01' })
    expect(matchesLeadFollowUp(overdue, 'all', TODAY)).toBe(true)
    expect(matchesLeadFollowUp(overdue, 'overdue', TODAY)).toBe(true)
    expect(matchesLeadFollowUp(overdue, 'today', TODAY)).toBe(false)
  })
})

describe('sortLeads', () => {
  it('puts overdue first, then today, then upcoming, then closed', () => {
    const rows = sortLeads(
      [
        lead({ id: 'closed', status: 'lost', followUpDate: '2026-01-01' }),
        lead({ id: 'upcoming', followUpDate: '2026-03-20' }),
        lead({ id: 'today', followUpDate: TODAY }),
        lead({ id: 'overdue', followUpDate: '2026-03-02' }),
        lead({ id: 'none' }),
      ],
      TODAY
    )
    expect(rows.map((r) => r.id)).toEqual(['overdue', 'today', 'upcoming', 'none', 'closed'])
  })

  it('orders same-state leads by the earliest follow-up date', () => {
    const rows = sortLeads(
      [
        lead({ id: 'later', followUpDate: '2026-03-05' }),
        lead({ id: 'earlier', followUpDate: '2026-03-01' }),
      ],
      TODAY
    )
    expect(rows.map((r) => r.id)).toEqual(['earlier', 'later'])
  })
})

describe('matchesLeadSearch', () => {
  it('matches name and phone, case-insensitively', () => {
    expect(matchesLeadSearch(lead(), 'rahul')).toBe(true)
    expect(matchesLeadSearch(lead(), '9800')).toBe(true)
    expect(matchesLeadSearch(lead(), 'priya')).toBe(false)
    expect(matchesLeadSearch(lead(), '  ')).toBe(true)
  })
})

describe('lead status helpers', () => {
  it('exposes the canonical status list used by the form, rules and filters', () => {
    expect(LEAD_STATUS_VALUES).toEqual(['new', 'contacted', 'trial', 'joined', 'lost'])
    expect(leadStatusLabel('trial')).toBe('Trial')
    expect(leadStatusLabel('weird')).toBe('weird')
  })

  it('treats joined and lost as the only closed states', () => {
    expect(isLeadOpen(lead({ status: 'trial' }))).toBe(true)
    expect(isLeadOpen(lead({ status: 'joined' }))).toBe(false)
    expect(isLeadOpen(lead({ status: 'lost' }))).toBe(false)
  })
})
