import { QRCodeSVG } from 'qrcode.react'
import { MemberPhoto } from '@/components/common/MemberPhoto'
import { StatusBadge } from '@/components/ui/Badge'
import { formatDate } from '@/utils/formatters'

export function MembershipCard({ member, plan, expiry, settings }) {
  if (!member) return null

  return (
    <div className="membership-card" data-member-id={member.id}>
      <div className="membership-card-header">
        <div className="min-w-0">
          <p className="truncate text-lg font-black tracking-wide text-white">
            {settings?.gymName || 'Gym'}
          </p>
          <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/80">
            Membership card
          </p>
        </div>
      </div>

      <div className="membership-card-body">
        <div className="membership-card-main">
          <MemberPhoto member={member} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-bold text-slate-900">{member.name}</p>
            <p className="mt-0.5 font-mono text-[11px] tracking-wide text-slate-400">ID · {member.memberNo || '—'}</p>
            <div className="mt-1.5">
              <StatusBadge status={member.status} />
            </div>
          </div>
          <div className="membership-card-qr shrink-0" data-member-id={member.id}>
            <QRCodeSVG value={member.id} size={104} fgColor="#0f172a" />
          </div>
        </div>

        <div className="membership-card-details">
          <div className="membership-card-field">
            <span>Plan</span>
            <strong>{plan?.name || 'No plan'}</strong>
          </div>
          <div className="membership-card-field">
            <span>Started</span>
            <strong>{formatDate(member.joinDate)}</strong>
          </div>
          <div className="membership-card-field">
            <span>Expires</span>
            <strong>{expiry ? formatDate(expiry) : '—'}</strong>
          </div>
          <div className="membership-card-field">
            <span>Phone</span>
            <strong>{member.phone || '—'}</strong>
          </div>
        </div>
      </div>
    </div>
  )
}
