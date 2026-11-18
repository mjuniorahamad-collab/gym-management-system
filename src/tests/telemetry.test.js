import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportError, setErrorReporter } from '@/services/telemetry'

afterEach(() => {
  setErrorReporter(null)
  vi.restoreAllMocks()
})

describe('reportError', () => {
  it('sends the error and its context to the installed reporter', () => {
    const reporter = vi.fn()
    setErrorReporter(reporter)

    const error = new Error('boom')
    const payload = reportError(error, { source: 'ErrorBoundary' })

    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter.mock.calls[0][0].error).toBe(error)
    expect(reporter.mock.calls[0][0].message).toBe('boom')
    expect(reporter.mock.calls[0][0].context).toMatchObject({ source: 'ErrorBoundary' })
    expect(typeof reporter.mock.calls[0][0].context.at).toBe('string')
    expect(payload.message).toBe('boom')
  })

  it('does not also log to the console when a provider is installed', () => {
    setErrorReporter(() => {})
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    reportError(new Error('once only'))
    expect(logged).not.toHaveBeenCalled()
  })

  it('falls back to the console when the provider throws, instead of swallowing the error', () => {
    setErrorReporter(() => {
      throw new Error('provider down')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => reportError(new Error('original'))).not.toThrow()
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0][1]).toBe('original')
  })

  it('still logs when no provider is installed, so development is unchanged', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportError('string failure')
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0][1]).toBe('string failure')
  })

  it('treats a non-function reporter as "no provider"', () => {
    expect(setErrorReporter('nope')).toBeNull()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => reportError(new Error('x'))).not.toThrow()
    expect(logged).toHaveBeenCalledTimes(1)
  })
})
