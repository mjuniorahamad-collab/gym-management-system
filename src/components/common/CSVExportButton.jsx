import { useState } from 'react'
import { Download } from 'lucide-react'
import { downloadCsv } from '@/services/export'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/context/ToastContext'

export function CSVExportButton({ label = 'Export CSV', filename, rows, onExport, className }) {
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const handleClick = async () => {
    setBusy(true)
    try {
      const done = onExport ? await onExport() : downloadCsv(filename || `export-${Date.now()}.csv`, rows)
      // A failed export used to be console-only, so a staff member clicked the
      // button, saw nothing happen, and had no way to know it failed.
      if (done === false) toast.error('Nothing to export')
    } catch (e) {
      toast.error(e?.message || 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} loading={busy} className={className}>
      <Download size={14} />
      {label}
    </Button>
  )
}
