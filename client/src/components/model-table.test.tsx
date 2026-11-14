// @vitest-environment jsdom
// [fork 7/10 follow-up] The monthly-cap badge reads the per-router ceiling the
// server derives from the keys' RPM/TPM/RPD limits. These cases pin the
// aggregation across a group and the two dimensions it can show.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { MonthlyCapBadge } from './model-table'
import type { RateLimitUsageRow } from '@/lib/routing'

let root: Root
let container: HTMLDivElement

function row(overrides: Partial<RateLimitUsageRow> = {}): RateLimitUsageRow {
  return {
    modelDbId: 1,
    platform: 'groq',
    modelId: 'probe',
    rpm: null,
    rpd: null,
    tpm: null,
    monthly: null,
    ...overrides,
  }
}

function render(rows: RateLimitUsageRow[]) {
  act(() => {
    root.render(
      <I18nProvider initialLocale="en">
        <MonthlyCapBadge rows={rows} />
      </I18nProvider>,
    )
  })
  return container.textContent ?? ''
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MonthlyCapBadge', () => {
  it('renders nothing when no key in the group sets a limit', () => {
    expect(render([row(), row({ monthly: null })])).toBe('')
  })

  it('shows both the request and the token ceiling', () => {
    const text = render([row({ monthly: { requests: 2592000, tokens: 43200000 } })])
    expect(text).toContain('2.6M req/mo')
    expect(text).toContain('43.2M tok/mo')
  })

  it('sums the monthly ceiling across every member of the group', () => {
    const text = render([
      row({ monthly: { requests: 100000, tokens: 2000000 } }),
      row({ monthly: { requests: 100000, tokens: 2000000 } }),
    ])
    expect(text).toContain('200.0K req/mo')
    expect(text).toContain('4.0M tok/mo')
  })

  it('omits the dimension the server left unset', () => {
    const text = render([row({ monthly: { requests: 43200, tokens: null } })])
    expect(text).toContain('43.2K req/mo')
    expect(text).not.toContain('tok/mo')
  })

  it('carries the derivation in the tooltip', () => {
    render([row({ monthly: { requests: 43200, tokens: null } })])
    const badge = container.querySelector('span')
    expect(badge?.getAttribute('title')).toContain('RPM')
  })
})
