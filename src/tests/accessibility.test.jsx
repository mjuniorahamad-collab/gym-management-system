import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { Tabs } from '@/components/ui/Tabs'
import { SearchInput } from '@/components/ui/SearchInput'
import { RevenueChart } from '@/components/charts/RevenueChart'

// vi.mock hoisting is not needed here; recharts is already mocked-safe because
// ResponsiveContainer renders nothing meaningful at zero size in jsdom.
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'light' }) }))

describe('FormField label association', () => {
  // Every control in the app previously had NO accessible name: the label was a
  // bare <label> with no htmlFor, and the control was its sibling rather than
  // its child.
  it('names the input from its label', () => {
    render(
      <FormField label="Gym name">
        <Input />
      </FormField>
    )
    expect(screen.getByLabelText('Gym name')).toBeInTheDocument()
  })

  it('names a select from its label', () => {
    render(
      <FormField label="Currency">
        <Select>
          <option value="INR">INR</option>
        </Select>
      </FormField>
    )
    expect(screen.getByLabelText('Currency')).toBeInTheDocument()
  })

  it('names a textarea from its label', () => {
    render(
      <FormField label="Description">
        <textarea />
      </FormField>
    )
    expect(screen.getByLabelText('Description')).toBeInTheDocument()
  })

  // Login.jsx wraps its Input in a positioned <div> for an icon, so association
  // must not depend on the child being a bare control.
  it('names a control that is wrapped in a div', () => {
    render(
      <FormField label="Gym name">
        <div className="relative">
          <Input />
        </div>
      </FormField>
    )
    expect(screen.getByLabelText('Gym name')).toBeInTheDocument()
  })

  it('excludes the hint from the accessible name', () => {
    render(
      <FormField label="PT surcharge (INR)" hint="Enter 0 to disable PT pricing">
        <Input />
      </FormField>
    )
    expect(screen.getByLabelText('PT surcharge (INR)')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Enter 0 to disable/)).toBeNull()
  })

  it('announces an error and excludes it from the accessible name', () => {
    render(
      <FormField label="Gym name" error="Gym name is required">
        <Input />
      </FormField>
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Gym name is required')
    expect(screen.getByLabelText('Gym name')).toBeInTheDocument()
  })

  it('renders children with no label at all', () => {
    render(
      <FormField>
        <Input aria-label="Unlabelled" />
      </FormField>
    )
    expect(screen.getByLabelText('Unlabelled')).toBeInTheDocument()
  })
})

describe('Modal accessibility', () => {
  it('is labelled by its title', () => {
    render(
      <Modal open onClose={() => {}} title="Member Summary">
        <p>body</p>
      </Modal>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName('Member Summary')
  })

  it('moves focus into the dialog when it opens', () => {
    render(
      <>
        <button type="button">Open</button>
        <Modal open onClose={() => {}} title="Member Summary">
          <p>body</p>
        </Modal>
      </>
    )
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = require('react').useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Summary">
            <p>body</p>
          </Modal>
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })
})

describe('Tabs accessibility', () => {
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'payments', label: 'Payments' },
  ]

  it('exposes a tablist with the active tab selected', () => {
    render(<Tabs tabs={tabs} active="payments" onChange={() => {}} />)
    const list = screen.getByRole('tablist')
    expect(list).toBeInTheDocument()
    expect(within(list).getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false')
  })

  it('reports the clicked tab', async () => {
    const onChange = vi.fn()
    render(<Tabs tabs={tabs} active="overview" onChange={onChange} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Payments' }))
    expect(onChange).toHaveBeenCalledWith('payments')
  })
})

describe('SearchInput accessibility', () => {
  it('has an accessible name rather than only a placeholder', () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Search expenses…" />)
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument()
  })

  it('accepts a custom label', () => {
    render(<SearchInput value="" onChange={() => {}} label="Find a member" />)
    expect(screen.getByRole('searchbox', { name: 'Find a member' })).toBeInTheDocument()
  })
})

describe('Chart accessibility', () => {
  const data = [
    { label: 'Sep', income: 100, expense: 40 },
    { label: 'Oct', income: 150, expense: 60 },
  ]

  it('exposes the chart as a labelled image', () => {
    render(<RevenueChart data={data} />)
    expect(screen.getByRole('img', { name: /Cash flow/i })).toBeInTheDocument()
  })

  // A label alone still hides the numbers; the figures must be reachable.
  it('exposes the underlying figures as a table', () => {
    render(<RevenueChart data={data} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Income' })).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'Sep' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '150' })).toBeInTheDocument()
  })
})