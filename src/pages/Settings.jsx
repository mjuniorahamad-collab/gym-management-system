import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Building2, Database, Dumbbell, Loader2, MessageCircle, ShieldCheck, Upload } from 'lucide-react'
import { settingsSchema, ptSurchargeSchema } from '@/schemas/validationSchemas'
import { useSettings, DEFAULT_SETTINGS } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { uploadGymLogo, isStorageReady } from '@/services/storage'
import { getPtSurcharge, setPtSurcharge as persistPtSurcharge } from '@/services/pt'
import { getWhatsAppLink, setWhatsAppLink } from '@/services/whatsappGroup'
import { loadSampleData } from '@/services/seedService'
import { ensureOriginPeriods } from '@/services/migration'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CURRENCIES, DATE_FORMATS } from '@/utils/constants'
import { formatCurrency } from '@/utils/formatters'
import { COMMON_GYM_TIMEZONES, resolveGymTimezone } from '@/utils/gymTime'
import { useAuth } from '@/context/AuthContext'

export default function Settings() {
  const { settings, updateSettings, error: settingsError } = useSettings()
  const toast = useToast()
  // Tenancy comes from the signed-in users/{uid} profile, the same source
  // storage.rules trusts. Branding writes are owner-only server-side, so the
  // gym id must be the caller's own gym and can never be supplied by the form.
  const gymId = useAuth()?.gymId ?? null

  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [migrateConfirm, setMigrateConfirm] = useState(false)
  const [ptSurcharge, setPtSurcharge] = useState('')
  const [ptLoadError, setPtLoadError] = useState('')
  const [ptSaving, setPtSaving] = useState(false)
  const [ptError, setPtError] = useState('')
  const [whatsAppLink, setWhatsAppLinkLocal] = useState('')
  const [whatsAppSaving, setWhatsAppSaving] = useState(false)
  const [whatsAppError, setWhatsAppError] = useState('')
  const logoRef = useRef(null)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(settingsSchema), defaultValues: DEFAULT_SETTINGS })

  useEffect(() => {
    reset({
      gymName: settings.gymName,
      tagline: settings.tagline,
      currency: settings.currency,
      dateFormat: settings.dateFormat,
      receiptPrefix: settings.receiptPrefix,
      // A gym created before the timezone field existed has no stored value;
      // show the same default every reader falls back to, so saving cannot
      // silently change the gym's day boundaries.
      timezone: resolveGymTimezone(settings.timezone),
    })
  }, [settings, reset])

  useEffect(() => {
    let active = true
    getPtSurcharge()
      .then((value) => {
        if (!active) return
        setPtSurcharge(value === 0 ? '' : String(value))
        setPtLoadError('')
      })
      .catch((e) => {
        if (!active) return
        // An unread surcharge is indistinguishable from a blank field, and
        // ptSurchargeSchema coerces '' to 0. Saving would therefore silently
        // disable PT pricing for this gym and report success. Block the save
        // until the real value has been read instead.
        setPtSurcharge('')
        setPtLoadError(e?.message || 'Could not read the current PT surcharge')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    getWhatsAppLink()
      .then((link) => {
        if (active) setWhatsAppLinkLocal(link)
      })
      .catch(() => {
        // Kept empty on read failure; surfaced when saving.
        if (active) setWhatsAppLinkLocal('')
      })
    return () => {
      active = false
    }
  }, [])

  const handlePtSave = async () => {
    setPtError('')
    if (ptLoadError) return
    setPtSaving(true)
    try {
      const parsed = ptSurchargeSchema.parse(ptSurcharge)
      await persistPtSurcharge(parsed)
      setPtSurcharge(parsed === 0 ? '' : String(parsed))
      toast.success(`PT surcharge set to ${formatCurrency(parsed, settings.currency)}`)
    } catch (e) {
      setPtError(e?.issues?.[0]?.message || e?.message || 'Enter a valid PT surcharge')
    } finally {
      setPtSaving(false)
    }
  }

  const handleWhatsAppSave = async () => {
    setWhatsAppError('')
    setWhatsAppSaving(true)
    try {
      await setWhatsAppLink(whatsAppLink)
      setWhatsAppLinkLocal(whatsAppLink.trim())
      toast.success(whatsAppLink.trim() ? 'WhatsApp group link saved' : 'WhatsApp group link cleared')
    } catch (e) {
      setWhatsAppError(e?.issues?.[0]?.message || e?.message || 'Enter a valid WhatsApp group invite link')
    } finally {
      setWhatsAppSaving(false)
    }
  }

  const handleWhatsAppClear = async () => {
    setWhatsAppError('')
    setWhatsAppSaving(true)
    try {
      await setWhatsAppLink('')
      setWhatsAppLinkLocal('')
      toast.success('WhatsApp group link cleared')
    } catch (e) {
      setWhatsAppError(e?.issues?.[0]?.message || e?.message || 'Could not clear the WhatsApp group link')
    } finally {
      setWhatsAppSaving(false)
    }
  }

  // updateSettings() handles its own success/error toasts and resolves to a
  // boolean. try/finally only guarantees the button can never be left spinning
  // if that contract ever changes.
  const onSubmit = async (values) => {
    setSaving(true)
    try {
      await updateSettings(values)
    } finally {
      setSaving(false)
    }
  }

  const handleLogo = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!isStorageReady()) {
      toast.error('Firebase Storage is not configured')
      return
    }
    if (!gymId) {
      toast.error('Your gym could not be resolved')
      return
    }
    setUploading(true)
    try {
      // One deterministic object per gym (D2). Re-uploading replaces the logo in
      // place, so there is no second object to clean up afterwards — which is
      // precisely why this flow no longer deletes anything. The previous version
      // minted a fresh `logo-${Date.now()}.${ext}` object on every upload and had
      // to delete it again when the settings write failed, because it had
      // stranded a file nothing could reach. storage.rules denies client deletes
      // on branding, and no product flow needs one.
      const { url, path } = await uploadGymLogo(gymId, file)
      // logoPath is persisted beside logoUrl so a future rules-evaluated read is
      // built from the stable object path rather than from a bearer URL.
      //
      // updateSettings reports its own failure and returns false rather than
      // throwing, so its result has to be honoured. Ignoring it showed
      // "Logo uploaded" next to the error it had just raised, telling the
      // operator the new logo was live when the settings document still
      // pointed at the old one.
      const saved = await updateSettings({ logoUrl: url, logoPath: path })
      if (!saved) return
      toast.success('Logo uploaded')
    } catch (err) {
      toast.error(err.message || 'Upload failed')
    } finally {
      setUploading(false)
      if (logoRef.current) logoRef.current.value = ''
    }
  }

  const handleSeed = async () => {
    setSeeding(true)
    try {
      await loadSampleData()
      toast.success('Sample data loaded')
    } catch (e) {
      toast.error(e.message || 'Could not load sample data')
    } finally {
      setSeeding(false)
    }
  }

  const handleMigrate = async () => {
    setMigrating(true)
    try {
      const { created } = await ensureOriginPeriods()
      toast.success(
        created > 0
          ? `Rebuilt ${created} earlier membership period${created === 1 ? '' : 's'}`
          : 'Nothing to rebuild — all membership periods are already recorded'
      )
      setMigrateConfirm(false)
    } catch (e) {
      toast.error(e.message || 'Could not rebuild membership periods')
    } finally {
      setMigrating(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Gym branding, preferences and data tools" />

      {settingsError && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          <p className="font-semibold">Tenant settings could not be loaded</p>
          <p className="mt-1">{settingsError}</p>
          <p className="mt-2">
            Changes saved below will fail until this gym has its own scoped settings document at{' '}
            <code className="whitespace-nowrap">gyms/&#123;gymId&#125;/settings/app</code>. This is
            expected during the per-gym isolation migration &mdash; do not fall back to a shared
            global settings record.
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Personal Training pricing"
            subtitle="Per-gym PT surcharge added on top of a member's plan price"
            actions={<Dumbbell size={16} className="text-slate-400" />}
          />
          <CardBody>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              A Personal Training (PT) member is charged their plan price plus this surcharge. Each
              gym sets its own amount &mdash; it never applies to regular members, and past payment
              records are never changed.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <FormField
                label={`PT surcharge (${settings.currency})`}
                error={ptLoadError || ptError}
                hint={
                  ptLoadError
                    ? undefined
                    : 'Enter 0 to disable PT pricing for this gym'
                }
              >
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={ptSurcharge}
                  disabled={Boolean(ptLoadError)}
                  onChange={(e) => {
                    setPtSurcharge(e.target.value)
                    setPtError('')
                  }}
                />
              </FormField>
              <div className="flex items-end">
                <Button
                  onClick={handlePtSave}
                  loading={ptSaving}
                  disabled={Boolean(ptLoadError)}
                  title={
                    ptLoadError
                      ? 'Saving is disabled until the current surcharge can be read'
                      : undefined
                  }
                >
                  Save PT surcharge
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="WhatsApp Group"
            subtitle="Per-gym invite link to your members' WhatsApp group"
            actions={<MessageCircle size={16} className="text-slate-400" />}
          />
          <CardBody>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Paste your gym&rsquo;s WhatsApp group invite link so staff can offer it to members. Members
              join voluntarily — nothing is ever sent or added automatically. Each gym keeps its own link.
            </p>
            <div className="mt-4 space-y-4">
              <FormField
                label="WhatsApp Group Invite Link"
                error={whatsAppError}
                hint="Leave empty to disable the invite action for this gym"
              >
                <Input
                  type="url"
                  placeholder="https://chat.whatsapp.com/…"
                  value={whatsAppLink}
                  onChange={(e) => { setWhatsAppLinkLocal(e.target.value); setWhatsAppError('') }}
                />
              </FormField>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={handleWhatsAppSave} loading={whatsAppSaving}>
                  Save
                </Button>
                {whatsAppLink.trim() && (
                  <Button variant="outline" onClick={handleWhatsAppClear} disabled={whatsAppSaving}>
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Gym profile"
            subtitle="Shown on login, receipts and member cards"
            actions={<Building2 size={16} className="text-slate-400" />}
          />
          <CardBody>
            <div className="mb-5 flex items-center gap-4">
              {settings.logoUrl ? (
                <img
                  src={settings.logoUrl}
                  alt="Gym logo"
                  className="h-16 w-16 rounded-xl object-cover ring-1 ring-slate-200 dark:ring-slate-700"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-emerald-600 text-white">
                  <Building2 size={26} />
                </div>
              )}
              <div>
                <Button variant="outline" size="sm" onClick={() => logoRef.current?.click()} loading={uploading}>
                  {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  Upload logo
                </Button>
                <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={handleLogo} />
                <p className="mt-1.5 text-xs text-slate-400">PNG or JPG, square works best</p>
              </div>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Gym name" error={errors.gymName?.message} required>
                  <Input error={errors.gymName} {...register('gymName')} />
                </FormField>
                <FormField label="Tagline" error={errors.tagline?.message}>
                  <Input error={errors.tagline} {...register('tagline')} />
                </FormField>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField label="Currency" error={errors.currency?.message}>
                  <Select error={errors.currency} {...register('currency')}>
                    {CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Date format" error={errors.dateFormat?.message}>
                  <Select error={errors.dateFormat} {...register('dateFormat')}>
                    {DATE_FORMATS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Receipt prefix" error={errors.receiptPrefix?.message}>
                  <Input error={errors.receiptPrefix} {...register('receiptPrefix')} />
                </FormField>
                <FormField
                  label="Gym timezone"
                  error={errors.timezone?.message}
                  hint="Used for attendance days, membership expiry, reports and billing months. Attendance is recorded in this zone regardless of a staff device's own clock."
                >
                  <Select error={errors.timezone} {...register('timezone')}>
                    {COMMON_GYM_TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
              <div className="flex justify-end pt-2">
                <Button type="submit" loading={saving}>
                  Save settings
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Data tools"
            subtitle="Development and maintenance utilities"
            actions={<Database size={16} className="text-slate-400" />}
          />
          <CardBody className="space-y-4">
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Load sample data</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Fills empty collections with demo members, plans, payments and classes. Only works when
                collections are empty.
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={handleSeed} loading={seeding}>
                Load sample data
              </Button>
            </div>

            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Rebuild membership periods</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Creates a membership record for members whose earliest payments predate their oldest
                membership record, so historical dues stay visible and payable per period. Safe to
                run anytime — it never modifies existing records.
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setMigrateConfirm(true)} loading={migrating}>
                Rebuild membership periods
              </Button>
            </div>

            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Legacy record ownership
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Records created before per-gym isolation existed carry no gym. They are no longer
                claimable from this app: whichever gym signed in first would otherwise silently absorb
                pre-tenancy data that may belong to another tenant. Re-assigning them is an
                infrastructure task run against a verified backup with a full audit trail.
              </p>
            </div>

            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                <ShieldCheck size={16} className="text-emerald-500" /> Security
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Role-based access is enforced both in the UI and in Firestore security rules, and every
                record is scoped to a gym. A gym&rsquo;s Owner is provisioned on first account creation
                (self-onboarding) or out-of-band, setting up that gym&rsquo;s isolation.
              </p>
            </div>

            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Cloud Functions</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Scheduled membership-expiry reminders and daily Firestore backups are ready in the{' '}
                <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">functions/</code> folder.
                Deploy them to enable automation.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={migrateConfirm}
        onCancel={() => setMigrateConfirm(false)}
        onConfirm={handleMigrate}
        loading={migrating}
        title="Rebuild membership periods?"
        message="This creates membership records for earlier, undocumented membership periods (using each member's current plan price) so historical dues stay tracked per period. Existing records are never modified."
        confirmLabel="Rebuild now"
      />
    </div>
  )
}
