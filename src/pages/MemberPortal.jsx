import { Construction } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/Card'
import { PageHeader } from '@/components/layout/PageHeader'

export default function MemberPortal() {
  return (
    <div className="space-y-5">
      <PageHeader title="Member Portal" subtitle="Self-service for gym members" />
      <Card>
        <CardBody className="flex flex-col items-center gap-4 py-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
            <Construction size={28} />
          </div>
          <div className="max-w-md">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Coming soon in v2
            </h3>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Members will sign in with their own account to view their membership status,
              payment history and class bookings. The data model already supports this — each
              member profile has a <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">memberUid</code>{' '}
              field ready to link accounts.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
