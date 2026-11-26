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
          {/* White mat so the avatar keeps a clean edge on paper as well as on
              screen, where the card itself has no background to separate them. */}
          <div className="shrink-0 rounded-full bg-white p-0.5 shadow-sm ring-1 ring-slate-200">
            <MemberPhoto member={member} size="lg" />
          </div>
          <div className="min-w-0 flex-1">
            {/* The QR and the avatar leave this column roughly 90px wide, so a
                truncate cut "Ayesha Khan" down to "Ayesh…" on the printed card.
                Wrapping keeps the whole name; the card has no fixed height. */}
            <p className="break-words text-lg font-bold leading-tight text-slate-900">{member.name}</p>
            <p className="mt-0.5 whitespace-nowrap font-mono text-[11px] tracking-wide text-slate-400">
              ID · {member.memberNo || '—'}
            </p>
            {member.status && (
              <div className="mt-1.5">
                <StatusBadge status={member.status} />
              </div>
            )}
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
