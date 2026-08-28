import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OutstandingDuesCard } from '@/components/dashboard/OutstandingDuesCard'

vi.mock('@/services/storage', () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  memberPhotoPath: () => '',
  logoPath: () => '',
}))

const ROWS = [
  {
    member: { id: 'm1', name: 'Ayesha Khan', memberNo: 'MEM-0001' },
    plan: { name: '3 Months' },
    planAmount: 5000,
    totalPaid: 3000,
    dueAmount: 2000,
    targetMembershipId: 'ms-old-1',
  },
  {
    member: { id: 'm2', name: 'Rohan Verma', memberNo: 'MEM-0002' },
    plan: { name: 'Annual' },
    planAmount: 12000,
    totalPaid: 4000,
    dueAmount: 8000,
    targetMembershipId: 'ms-old-2',
  },
]

function renderCard(props = {}) {
  const onRecord = vi.fn()
  render(
    <MemoryRouter>
      <OutstandingDuesCard
        rows={ROWS}
        totalDue={10000}
        count={2}
        settings={{ currency: 'INR' }}
        canWrite
        onRecord={onRecord}
        {...props}
      />
    </MemoryRouter>
  )
  return onRecord
}

describe('OutstandingDuesCard', () => {
  it('shows the prominent total due and member count', () => {
    renderCard()
    expect(screen.getByText('Total outstanding due')).toBeInTheDocument()
    expect(screen.getByText('₹10,000')).toBeInTheDocument()
    expect(screen.getByText('Members with dues')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('lists each member with name, member ID, plan and payment figures', () => {
    renderCard()

    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument()
    expect(screen.getByText('MEM-0001')).toBeInTheDocument()
    expect(screen.getByText('3 Months')).toBeInTheDocument()
    expect(screen.getByText('₹5,000')).toBeInTheDocument()
    expect(screen.getByText('₹3,000')).toBeInTheDocument()
    expect(screen.getByText('₹2,000')).toBeInTheDocument()

    expect(screen.getByText('Rohan Verma')).toBeInTheDocument()
    expect(screen.getByText('MEM-0002')).toBeInTheDocument()
    expect(screen.getByText('Annual')).toBeInTheDocument()
    expect(screen.getByText('₹12,000')).toBeInTheDocument()
    expect(screen.getByText('₹4,000')).toBeInTheDocument()
    expect(screen.getByText('₹8,000')).toBeInTheDocument()
  })

  it('links the member to their detail page', () => {
    renderCard()
    const link = screen.getByRole('link', { name: /Ayesha Khan/i })
    expect(link).toHaveAttribute('href', '/members/m1')
  })

  it('calls onRecord with member, due amount AND the target period id (explicit allocation)', () => {
    const onRecord = renderCard()
    const buttons = screen.getAllByRole('button', { name: /Record Payment/i })
    expect(buttons).toHaveLength(2)

    fireEvent.click(buttons[0])
    expect(onRecord).toHaveBeenCalledWith(ROWS[0].member, 2000, 'ms-old-1')

    fireEvent.click(buttons[1])
    expect(onRecord).toHaveBeenCalledWith(ROWS[1].member, 8000, 'ms-old-2')
  })

  it('hides Record Payment buttons when the user cannot write', () => {
    renderCard({ canWrite: false })
    expect(screen.queryByRole('button', { name: /Record Payment/i })).toBeNull()
  })

  it('expands and collapses the member list', () => {
    renderCard()
    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Collapse/i }))
    expect(screen.queryByText('Ayesha Khan')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Expand/i }))
    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument()
  })

  it('shows an empty state when there are no dues', () => {
    renderCard({ rows: [], totalDue: 0, count: 0 })
    expect(screen.getByText('No outstanding dues')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Record Payment/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Collapse/i })).toBeNull()
  })
})
