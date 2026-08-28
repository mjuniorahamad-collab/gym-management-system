import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MembershipCard } from '@/components/common/MembershipCard'

const SETTINGS = { gymName: 'Himalye Wonders Gym', currency: 'INR', receiptPrefix: 'HWG' }

function renderCard(member, plan, expiry) {
  return render(<MembershipCard member={member} plan={plan} expiry={expiry} settings={SETTINGS} />)
}

describe('MembershipCard', () => {
  it('prints the full membership card for an active member (no photo → initials avatar)', () => {
    const member = {
      id: 'A-1001',
      memberNo: 'MEM-0001',
      name: 'Ayesha Khan',
      phone: '9812345678',
      status: 'active',
      joinDate: '2026-01-01',
      photoUrl: '',
    }
    const plan = { id: 'p1', name: '3 Months', durationDays: 90, price: 3500, active: true }
    const expiry = new Date(2026, 2, 1)

    const { container } = renderCard(member, plan, expiry)

    expect(screen.getByText('Himalye Wonders Gym')).toBeInTheDocument()
    expect(screen.getByText('Membership card')).toBeInTheDocument()
    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument()
    expect(screen.getByText('ID · MEM-0001')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('3 Months')).toBeInTheDocument()
    expect(screen.getByText('Jan 1, 2026')).toBeInTheDocument()
    expect(screen.getByText('Mar 1, 2026')).toBeInTheDocument()
    expect(screen.getByText('9812345678')).toBeInTheDocument()
    expect(screen.getByText('AK')).toBeInTheDocument()

    expect(container.querySelector('.membership-card').dataset.memberId).toBe('A-1001')
    expect(container.querySelector('.membership-card-qr').dataset.memberId).toBe('A-1001')
    expect(container.querySelector('.membership-card-qr svg')).not.toBeNull()
  })

  it('prints a distinct membership card for a second member (photo, different plan/status/dates)', () => {
    const member = {
      id: 'B-2042',
      memberNo: 'MEM-0002',
      name: 'Rohan Verma',
      phone: '9876501234',
      status: 'expired',
      joinDate: '2025-06-15',
      photoUrl: 'https://example.com/rohan.jpg',
    }
    const plan = { id: 'p2', name: '12 Months', durationDays: 365, price: 12000, active: true }
    const expiry = new Date(2026, 5, 15)

    const { container } = renderCard(member, plan, expiry)

    expect(screen.getByText('Himalye Wonders Gym')).toBeInTheDocument()
    expect(screen.getByText('Rohan Verma')).toBeInTheDocument()
    expect(screen.getByText('ID · MEM-0002')).toBeInTheDocument()
    expect(screen.getByText('Expired')).toBeInTheDocument()
    expect(screen.getByText('12 Months')).toBeInTheDocument()
    expect(screen.getByText('Jun 15, 2025')).toBeInTheDocument()
    expect(screen.getByText('Jun 15, 2026')).toBeInTheDocument()
    expect(screen.getByText('9876501234')).toBeInTheDocument()

    const img = screen.getByAltText('Rohan Verma')
    expect(img).toHaveAttribute('src', 'https://example.com/rohan.jpg')

    expect(container.querySelector('.membership-card').dataset.memberId).toBe('B-2042')
    expect(container.querySelector('.membership-card-qr').dataset.memberId).toBe('B-2042')
    expect(container.querySelector('.membership-card-qr svg')).not.toBeNull()
  })
})
