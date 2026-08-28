import { useState } from 'react'
import { Download } from 'lucide-react'
import { downloadCsv } from '@/services/export'
import { Button } from '@/components/ui/Button'

export function CSVExportButton({ label = 'Export CSV', filename, rows, onExport, className }) {
  const [busy, setBusy] = useState(false)

  const handleClick = async () => {
    setBusy(true)
    try {
      if (onExport) {
        await onExport()
      } else if (rows) {
        downloadCsv(filename || `export-${Date.now()}.csv`, rows)
      }
    } catch (e) {
      console.error('Export failed', e)
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
