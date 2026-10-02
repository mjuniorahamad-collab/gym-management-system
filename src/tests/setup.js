import '@testing-library/jest-dom/vitest'

// jsdom does not implement ResizeObserver, which recharts' ResponsiveContainer
// requires. Without this stub any test that renders a chart throws
// "ResizeObserver is not defined".
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}