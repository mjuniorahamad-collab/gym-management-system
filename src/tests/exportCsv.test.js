import { describe, expect, it } from 'vitest'
import { duesExportRows, exportFileName, toCsv } from '@/services/export'

/**
 * Decodes the FIRST data cell of a CSV the way a spreadsheet would, so the
 * assertions below check the value a user actually ends up with in the cell
 * rather than the raw bytes on disk.
 */
function firstCell(row) {
  if (!row.startsWith('"')) return row
  return row
    .slice(1, row.lastIndexOf('"'))
    .replace(/""/g, '"')
}

const dataRows = (csv) => csv.split('\n').slice(1)

describe('toCsv spreadsheet formula injection', () => {
  // A member name, expense title or note is free-text user input. If exported
  // verbatim, Excel / LibreOffice / Google Sheets evaluate it as a formula when
  // the file is opened. The apostrophe forces the cell to be literal text.
  it.each([
    ['=HYPERLINK("http://evil.example","click")'],
    ['=cmd|\'/c calc\'!A1'],
    ['+1+1'],
    ['@SUM(A1:A9)'],
    ['-2+3'],
    ['\tcmd'],
    ['\rcmd'],
  ])('neutralises a leading trigger in %j', (value) => {
    const cell = firstCell(dataRows(toCsv([{ Name: value }]))[0])
    expect(cell.startsWith("'")).toBe(true)
    expect(cell.slice(1)).toBe(value)
  })

  it('neutralises a formula that also needs quoting', () => {
    const value = '=cmd|\'/c calc\'!A1, with comma'
    const row = dataRows(toCsv([{ Title: value }]))[0]
    // Quoted because it contains a comma, and still apostrophe-prefixed so the
    // spreadsheet treats it as text rather than a command.
    expect(row.startsWith('"')).toBe(true)
    expect(row.endsWith('"')).toBe(true)
    expect(firstCell(row)).toBe(`'${value}`)
  })

  it('neutralises a formula that contains both a quote and a comma', () => {
    const value = '=SUM(A1,"x"),y'
    const row = dataRows(toCsv([{ Title: value }]))[0]
    expect(row).toContain('""')
    expect(firstCell(row)).toBe(`'${value}`)
  })

  it('leaves ordinary text untouched', () => {
    const csv = toCsv([{ Name: 'Ayesha Khan', Note: 'Paid in cash' }])
    expect(csv).toBe('Name,Note\nAyesha Khan,Paid in cash')
  })

  it('leaves a leading digit or letter untouched', () => {
    const csv = toCsv([{ Name: '1st place' }, { Name: 'Aaron' }])
    expect(csv).toBe('Name\n1st place\nAaron')
  })

  // Negative and decimal amounts must stay numeric, not become text.
  it('keeps numbers numeric, including negatives', () => {
    const csv = toCsv([{ Amount: -50 }, { Amount: 1234.56 }])
    expect(csv).toBe('Amount\n-50\n1234.56')
  })

  it('keeps the RFC 4180 quoting behaviour', () => {
    const csv = toCsv([
      { Note: 'has, comma' },
      { Note: 'has "quotes"' },
      { Note: 'has\nnewline' },
    ])
    expect(csv).toBe('Note\n"has, comma"\n"has ""quotes"""\n"has\nnewline"')
  })

  it('keeps headers intact and orders every row by the first row', () => {
    const csv = toCsv([
      { A: '1', B: '2' },
      { B: '4', A: '3' },
    ])
    expect(csv.split('\n')[0]).toBe('A,B')
    expect(csv).toBe('A,B\n1,2\n3,4')
  })

  it('renders null and undefined as empty cells', () => {
    expect(toCsv([{ A: null, B: undefined, C: '' }])).toBe('A,B,C\n,,')
  })

  it('returns an empty string when there is nothing to export', () => {
    expect(toCsv([])).toBe('')
    expect(toCsv(null)).toBe('')
  })
})

describe('accountant export', () => {
  it('names a ranged file after the range, so monthly files stay apart', () => {
    expect(exportFileName('payments', '2026-03-01', '2026-03-31')).toBe(
      'payments-2026-03-01_to_2026-03-31.csv'
    )
    expect(exportFileName('expenses', '2026-04-01', '2026-04-30')).toBe(
      'expenses-2026-04-01_to_2026-04-30.csv'
    )
  })

  it('falls back to today for an unranged (whole-history) export', () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(exportFileName('dues')).toBe(`dues-${today}.csv`)
  })

  /**
   * The dues export copies the ledger's own figures. Recomputing them here
   * would let the CSV disagree with the dashboard; this asserts the columns
   * are a straight projection, including the oldest open period as "pending
   * since".
   */
  it('maps dues rows from the canonical ledger without recomputing', () => {
    const rows = duesExportRows([
      {
        member: { name: 'Ayesha Khan', memberNo: 'MEM-0001', phone: '9800000001' },
        plan: { name: '3 Months' },
        planAmount: 5000,
        totalPaid: 3000,
        dueAmount: 2000,
        periods: [
          { startDate: new Date('2026-02-01T12:00:00'), due: 2000 },
          { startDate: new Date('2026-05-01T12:00:00'), due: 0 },
        ],
      },
    ])

    expect(rows[0]).toMatchObject({
      Member: 'Ayesha Khan',
      MemberNo: 'MEM-0001',
      Phone: '9800000001',
      Plan: '3 Months',
      Billed: 5000,
      Paid: 3000,
      Due: 2000,
    })
    expect(rows[0].OldestOpenPeriod).toContain('2026')
  })

  it('produces an empty table for no dues and tolerates a sparse row', () => {
    expect(duesExportRows([])).toEqual([])
    const [row] = duesExportRows([{ dueAmount: 500 }])
    expect(row).toMatchObject({ Member: '', MemberNo: '', Plan: '', Due: 500 })
  })
})