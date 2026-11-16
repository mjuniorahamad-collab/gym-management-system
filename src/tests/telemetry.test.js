import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetErrorReporter,
  reportError,
  setErrorReporter,
} from '@/services/telemetry'

afterEach(() => {
  __resetErrorReporter()
  vi.restoreAllMocks()
})

describe('reportError', () => {
  it('sends the error and its context to the installed reporter', () => {
    const reporter = vi.fn()
    setErrorReporter(reporter)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const error = new Error('boom')
    const payload = reportError(error, { source: 'ErrorBoundary' })

    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter.mock.calls[0][0].error).toBe(error)
    expect(reporter.mock.calls[0][0].message).toBe('boom')
    expect(reporter.mock.calls[0][0].context).toMatchObject({ source: 'ErrorBoundary' })
    expect(typeof reporter.mock.calls[0][0].context.at).toBe('string')
    expect(payload.message).toBe('boom')
  })

  it('never throws when the reporter itself throws', () => {
    setErrorReporter(() => {
      throw new Error('provider down')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => reportError(new Error('original'))).not.toThrow()
  })

  it('still logs when no provider is installed, so development is unchanged', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportError('string failure')
    expect(logged).toHaveBeenCalled()
    expect(logged.mock.calls[0][1]).toBe('string failure')
  })

  it('treats a non-function reporter as "no provider"', () => {
    expect(setErrorReporter('nope')).toBeNull()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => reportError(new Error('x'))).not.toThrow()
  })
})
