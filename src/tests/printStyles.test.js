import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8')

function extractBlock(text, header) {
  const start = text.indexOf(header)
  if (start === -1) return null
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

describe('print CSS — receipt isolation', () => {
  it('defines an A4 portrait page with normal print margins', () => {
    const page = extractBlock(css, '@page')
    expect(page, '@page rule is missing from index.css').not.toBeNull()
    expect(page).toMatch(/size:\s*A4\s+portrait/i)
    expect(page).toMatch(/margin:\s*\d+(mm|in|cm|pt)/)
  })

  it('hides the print-only receipt on screen', () => {
    const onScreen = extractBlock(css, '#print-receipt')
    expect(onScreen, 'on-screen #print-receipt rule is missing').not.toBeNull()
    expect(onScreen).toContain('display: none')
  })

  it('hides the whole app shell during print so only the receipt remains', () => {
    const print = extractBlock(css, '@media print')
    expect(print, '@media print block is missing').not.toBeNull()
    expect(print).toMatch(/body:has\(#print-receipt\)\s+#root\s*\{[^}]*display:\s*none\s*!important/)
  })

  it('prints the receipt as a single static, border-box block with no fixed height', () => {
    const print = extractBlock(css, '@media print')
    expect(print).toContain('#print-receipt')
    expect(print).toMatch(/#print-receipt\s*\{[^}]*display:\s*block\s*!important/)
    expect(print).toMatch(/#print-receipt\s*\{[^}]*position:\s*static\s*!important/)
    expect(print).toMatch(/#print-receipt\s*\{[^}]*box-sizing:\s*border-box/)
    expect(print).toMatch(/#print-receipt\s*\{[^}]*min-height:\s*0\s*!important/)
    expect(print).toMatch(/#print-receipt\s*\{[^}]*height:\s*auto\s*!important/)
  })
})

describe('print CSS — membership card isolation', () => {
  it('hides the print-only membership card on screen', () => {
    const onScreen = extractBlock(css, '#print-membership-card')
    expect(onScreen, 'on-screen #print-membership-card rule is missing').not.toBeNull()
    expect(onScreen).toContain('display: none')
  })

  it('hides the whole app shell during print so only the membership card remains', () => {
    const print = extractBlock(css, '@media print')
    expect(print).not.toBeNull()
    expect(print).toMatch(/body:has\(#print-membership-card\)\s+#root\s*\{[^}]*display:\s*none\s*!important/)
  })

  it('prints the membership card as a single static, border-box, card-sized block', () => {
    const print = extractBlock(css, '@media print')
    expect(print).toContain('#print-membership-card')
    expect(print).toMatch(/#print-membership-card\s*\{[^}]*display:\s*block\s*!important/)
    expect(print).toMatch(/#print-membership-card\s*\{[^}]*position:\s*static\s*!important/)
    expect(print).toMatch(/#print-membership-card\s*\{[^}]*box-sizing:\s*border-box/)
    expect(print).toMatch(/#print-membership-card\s*\{[^}]*min-height:\s*0\s*!important/)
    expect(print).toMatch(/#print-membership-card\s*\{[^}]*height:\s*auto\s*!important/)
    expect(print).toMatch(/#print-membership-card\s*\{[^}]*width:\s*88mm/)
  })

  it('keeps the complete card together and avoids viewport-height layouts', () => {
    const print = extractBlock(css, '@media print')
    expect(print).toMatch(/#print-membership-card\s*\{[^}]*page-break-inside:\s*avoid/)
    expect(print).toMatch(/#print-membership-card\s*\{[^}]*break-inside:\s*avoid/)
    expect(print).not.toContain('100vh')
  })

  it('retires the old print-area selector that only printed the QR code', () => {
    expect(css).not.toMatch(/print-area/)
  })
})
