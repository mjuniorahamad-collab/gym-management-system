import { useMemo, useState } from 'react'
import { CheckCircle2, ClipboardCheck, QrCode, Search, UserCheck } from 'lucide-react'
import { useCollection } from '@/hooks/useFirestore'
import { useToday } from '@/hooks/useToday'
import { createDoc, updateDocById } from '@/services/firestore'
import { logAudit } from '@/services/audit'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { SearchInput } from '@/components/ui/SearchInput'
import { Spinner } from '@/components/ui/Spinner'
import { StatCard } from '@/components/charts/StatCard'
import { formatDateTime, formatNumber } from '@/utils/formatters'
import { parseDate } from '@/utils/dateHelpers'

export default function Attendance() {
  const { can } = useAuth()
  const toast = useToast()

  const { items: attendance, loading } = useCollection('attendance')
  const { items: members } = useCollection('members')

  const [search, setSearch] = useState('')
  const [qrCode, setQrCode] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const todayStart = useToday()

  const memberMap = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members])

  const todaysEntries = useMemo(
    () =>
      attendance
        .filter((a) => parseDate(a.date)?.toDateString() === todayStart)
        .sort((a, b) => String(b.checkIn || b.date).localeCompare(String(a.checkIn || a.date))),
    [attendance, todayStart]
  )

  const checkedInToday = useMemo(() => {
    const set = new Set()
    for (const a of todaysEntries) {
      if (!a.checkOut) set.add(a.memberId)
    }
    return set
  }, [todaysEntries])

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return members.slice(0, 8)
    // Guarded: a legacy or partially written member document without a name
    // would otherwise throw here and take the whole quick check-in card down.
    return members
      .filter(
        (m) =>
          String(m.name || '').toLowerCase().includes(q) ||
          String(m.phone || '').includes(q) ||
          String(m.memberNo || '').toLowerCase().includes(q)
      )
      .slice(0, 8)
  }, [members, search])

  const canWrite = can('attendance.write')

  const handleCheckIn = async (memberId) => {
    if (!memberId || !canWrite) return
    if (checkedInToday.has(memberId)) {
      toast.info('Already checked in today')
      return
    }
    setSubmitting(true)
    try {
      // Stamped at write time, not read from render state: a front-desk tab left
      // open across midnight would otherwise record the check-in against the
      // previous day, corrupting the attendance history it is reporting on.
      const now = new Date().toISOString()
      await createDoc('attendance', {
        memberId,
        date: now,
        checkIn: now,
        checkOut: '',
        source: 'manual',
      })
      await logAudit({ action: 'create', entity: 'attendance', entityId: memberId, details: { checkIn: true } })
      toast.success(`${memberMap[memberId]?.name} checked in`)
    } catch (e) {
      toast.error(e.message || 'Check-in failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCheckOut = async (entry) => {
    setSubmitting(true)
    try {
      await updateDocById('attendance', entry.id, { checkOut: new Date().toISOString() })
      toast.success('Checked out')
    } catch (e) {
      toast.error(e.message || 'Check-out failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleQrCheckIn = async () => {
    const id = qrCode.trim()
    if (!id) return
    const member = members.find((m) => m.id === id) || members.find((m) => m.memberNo === id)
    if (!member) {
      toast.error('Unknown member ID')
      return
    }
    // Keep the scanned ID when the check-in is rejected as a duplicate, or if
    // it fails outright - otherwise staff have to re-scan a member they already
    // scanned correctly.
    if (checkedInToday.has(member.id)) {
      toast.info('Already checked in today')
      return
    }
    const previous = qrCode
    setQrCode('')
    try {
      await handleCheckIn(member.id)
    } catch {
      setQrCode(previous)
    }
  }

  if (loading) return <Spinner label="Loading attendance…" />

  return (
    <div className="space-y-5">
      <PageHeader title="Attendance" subtitle="Check members in and out" />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Today's check-ins" value={formatNumber(todaysEntries.length)} icon={UserCheck} tone="emerald" />
        <StatCard
          title="Currently in the gym"
          value={formatNumber(checkedInToday.size)}
          icon={ClipboardCheck}
          tone="indigo"
        />
        <StatCard
          title="Checked out"
          value={formatNumber(todaysEntries.length - checkedInToday.size)}
          icon={CheckCircle2}
          tone="sky"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Quick check-in" subtitle="Search a member and tap check in" />
          <CardBody className="space-y-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Name or phone…" />
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {filteredMembers.length === 0 && <EmptyState title="No members match" />}
              {filteredMembers.map((m) => {
                const checkedIn = checkedInToday.has(m.id)
                return (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{m.name}</p>
                      <p className="text-xs text-slate-400">{m.phone}</p>
                    </div>
                    {checkedIn ? (
                      <Badge tone="success">In gym</Badge>
                    ) : (
                      <Button size="sm" onClick={() => handleCheckIn(m.id)} loading={submitting}>
                        Check in
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader title="Today's log" subtitle={`${todaysEntries.length} entries`} />
          <CardBody className="p-0">
            {todaysEntries.length === 0 ? (
              <EmptyState
                icon={ClipboardCheck}
                title="No check-ins today"
                description="Check-ins will appear here as members arrive."
              />
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {todaysEntries.map((a) => {
                  const member = memberMap[a.memberId]
                  return (
                    <div key={a.id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="avatar bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                          {member?.name?.slice(0, 1) || '?'}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                            {member?.name || 'Unknown member'}
                          </p>
                          <p className="truncate text-xs text-slate-400">
                            {formatDateTime(a.checkIn)}
                            {a.checkOut && ` → ${formatDateTime(a.checkOut)}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={a.source === 'qr' ? 'indigo' : 'neutral'}>
                          {a.source === 'qr' ? 'QR' : 'Manual'}
                        </Badge>
                        {a.checkOut ? (
                          <Badge tone="neutral">Done</Badge>
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => handleCheckOut(a)} loading={submitting}>
                            Check out
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="QR check-in" subtitle="Paste a member ID scanned from their member card" />
        <CardBody>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[260px] flex-1">
              <QrCode size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={qrCode}
                onChange={(e) => setQrCode(e.target.value)}
                placeholder="Scan or paste member ID…"
                className="input pl-9"
                onKeyDown={(e) => e.key === 'Enter' && handleQrCheckIn()}
              />
            </div>
            <Button onClick={handleQrCheckIn} loading={submitting}>
              <Search size={16} /> Check in
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
