import { useMemo, useState } from 'react'
import { Pencil, Plus, Receipt as ReceiptIcon, Trash2, TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import { useCollection } from '@/hooks/useFirestore'
import { createDoc, removeDoc, updateDocById } from '@/services/firestore'
import { logAudit } from '@/services/audit'
import { exportExpensesToCsv } from '@/services/export'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { ExpenseForm } from '@/components/common/ExpenseForm'
import { CSVExportButton } from '@/components/common/CSVExportButton'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatCard } from '@/components/charts/StatCard'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pagination } from '@/components/ui/Pagination'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { EXPENSE_CATEGORIES } from '@/utils/constants'
import { formatCurrency, formatDate } from '@/utils/formatters'
import { monthKey, parseDate } from '@/utils/dateHelpers'

const PAGE_SIZE = 20

export default function Expenses() {
  const { can } = useAuth()
  const { settings } = useSettings()
  const toast = useToast()

  const { items: expenses, loading } = useCollection('expenses')

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [visible, setVisible] = useState(PAGE_SIZE)

  const canWrite = can('finance.write')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return [...expenses]
      .filter((e) => {
        if (category !== 'all' && e.category !== category) return false
        // Guarded: a legacy or partially written expense without a title or
        // category would otherwise throw here and take the whole page down.
        if (
          q &&
          !String(e.title || '').toLowerCase().includes(q) &&
          !String(e.category || '').toLowerCase().includes(q)
        )
          return false
        return true
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
  }, [expenses, search, category])

  const summary = useMemo(() => {
    const current = monthKey(new Date())
    const total = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0)
    // Deliberately NOT `filtered`: these cards summarise the books, so the
    // figure must not change because someone typed in the search box or picked
    // a category. It also disagreed with the "Total expenses" card above it,
    // which already used the unfiltered list.
    const thisMonth = expenses
      .filter((e) => monthKey(parseDate(e.date)) === current)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0)
    return { total, thisMonth }
  }, [expenses])

  const handleSubmit = async (values) => {
    setSubmitting(true)
    try {
      if (editing) {
        await updateDocById('expenses', editing.id, values)
        await logAudit({ action: 'update', entity: 'expenses', entityId: editing.id, details: { title: values.title } })
        toast.success('Expense updated')
      } else {
        const id = await createDoc('expenses', values)
        await logAudit({ action: 'create', entity: 'expenses', entityId: id, details: { title: values.title, amount: values.amount } })
        toast.success('Expense added')
      }
      setFormOpen(false)
      setEditing(null)
    } catch (e) {
      toast.error(e.message || 'Could not save expense')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    setSubmitting(true)
    try {
      await removeDoc('expenses', deleting.id)
      await logAudit({ action: 'delete', entity: 'expenses', entityId: deleting.id, details: { title: deleting.title } })
      toast.success('Expense deleted')
      setDeleting(null)
    } catch (e) {
      toast.error(e.message || 'Could not delete expense')
    } finally {
      setSubmitting(false)
    }
  }

  const shown = filtered.slice(0, visible)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Expenses"
        subtitle="Track gym operating costs"
        actions={
          canWrite && (
            <Button
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <Plus size={16} /> Add expense
            </Button>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Total expenses" value={formatCurrency(summary.total, settings.currency)} icon={Wallet} tone="rose" />
        <StatCard title="This month" value={formatCurrency(summary.thisMonth, settings.currency)} icon={TrendingDown} tone="amber" />
        <StatCard title="Expense entries" value={expenses.length} icon={TrendingUp} tone="indigo" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search expenses…" className="w-full sm:w-72" />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-44">
          <option value="all">All categories</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <div className="ml-auto">
          <CSVExportButton onExport={() => exportExpensesToCsv(filtered)} />
        </div>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <TableSkeleton rows={6} cols={4} />
        ) : shown.length === 0 ? (
          <EmptyState icon={ReceiptIcon} title="No expenses recorded" description="Add your first expense to start tracking." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="th">Date</th>
                    <th className="th">Title</th>
                    <th className="th hidden sm:table-cell">Category</th>
                    <th className="th">Amount</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {shown.map((e) => (
                    <tr key={e.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="td whitespace-nowrap">{formatDate(e.date)}</td>
                      <td className="td">
                        <p className="font-medium text-slate-900 dark:text-slate-100">{e.title}</p>
                        {e.note && <p className="text-xs text-slate-400">{e.note}</p>}
                      </td>
                      <td className="td hidden sm:table-cell">
                        <Badge tone="neutral">{e.category}</Badge>
                      </td>
                      <td className="td font-semibold text-rose-600">{formatCurrency(e.amount, settings.currency)}</td>
                      <td className="td">
                        <div className="flex items-center justify-end gap-1">
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => {
                                setEditing(e)
                                setFormOpen(true)
                              }}
                            >
                              <Pencil size={16} />
                            </Button>
                          )}
                          {can('settings.write') && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                              title="Delete"
                              onClick={() => setDeleting(e)}
                            >
                              <Trash2 size={16} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              hasMore={visible < filtered.length}
              loading={loading}
              onLoadMore={() => setVisible((v) => v + PAGE_SIZE)}
              showing={shown.length}
              total={filtered.length}
            />
          </>
        )}
      </div>

      <ExpenseForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        initial={editing}
        submitting={submitting}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
        loading={submitting}
        title="Delete expense?"
        message={`This will permanently remove "${deleting?.title}".`}
        confirmLabel="Delete expense"
      />
    </div>
  )
}
