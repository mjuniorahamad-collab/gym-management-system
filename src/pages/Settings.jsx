import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Building2, Database, Loader2, ShieldCheck, Upload } from 'lucide-react'
import { settingsSchema } from '@/schemas/validationSchemas'
import { useSettings, DEFAULT_SETTINGS } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { uploadFile, logoPath, isStorageReady } from '@/services/storage'
import { loadSampleData } from '@/services/seedService'
import { ensureOriginPeriods, ensureGymTenancy } from '@/services/migration'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CURRENCIES, DATE_FORMATS } from '@/utils/constants'

export default function Settings() {
  const { settings, updateSettings } = useSettings()
  const toast = useToast()

  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [tenancySyncing, setTenancySyncing] = useState(false)
  const [migrateConfirm, setMigrateConfirm] = useState(false)
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
    })
  }, [settings, reset])

  const onSubmit = async (values) => {
    setSaving(true)
    await updateSettings(values)
    setSaving(false)
  }

  const handleLogo = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!isStorageReady()) {
      toast.error('Firebase Storage is not configured')
      return
    }
    setUploading(true)
    try {
      const url = await uploadFile(file, logoPath(`logo-${Date.now()}.${file.name.split('.').pop()}`))
      await updateSettings({ logoUrl: url })
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

  const handleTenancySync = async () => {
    setTenancySyncing(true)
    try {
      const result = await ensureGymTenancy()
      if (result.status === 'no-gym') {
        toast.error('No gym is assigned yet. Provision the gyms/{gymId} owner record first.')
      } else if (result.tagged === 0) {
        toast.success('Tenancy is up to date — all records already carry a gym.')
      } else {
        toast.success(`Tenancy synced: tagged ${result.tagged} record${result.tagged === 1 ? '' : 's'} with the gym.`)
      }
    } catch (e) {
      toast.error(e.message || 'Could not sync gym tenancy')
    } finally {
      setTenancySyncing(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Gym branding, preferences and data tools" />

      <div className="grid gap-5 lg:grid-cols-2">
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
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Re-sync gym tenancy</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Tags any existing records that are missing a gym with yours, keeping multi-gym data
                isolated. Idempotent and safe to run anytime &mdash; it never overwrites an existing gym
                or destroys data.
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={handleTenancySync} loading={tenancySyncing}>
                Re-sync gym tenancy
              </Button>
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
