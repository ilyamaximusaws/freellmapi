// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ThemeProvider } from '@/theme'
import { Sidebar } from './app-navigation'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), logout: vi.fn() }))
vi.mock('@/components/auth-gate', () => ({ ChangeCredentialsModal: () => null }))
vi.mock('@/components/settings-dialog', () => ({ SettingsDialog: () => null }))
vi.mock('@/components/updates-dialog', () => ({ UpdatesDialog: () => null }))

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
})

beforeEach(() => {
  window.localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  vi.mocked(apiFetch).mockReset().mockResolvedValue({ summary: { total: 2 } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <I18nProvider initialLocale="en">
          <MemoryRouter initialEntries={['/models/chat']}><Sidebar /></MemoryRouter>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  ))
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
  document.body.style.overflow = ''
})

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('keeps every destination in the sidebar and marks chat models active', async () => {
  await flush()
  const labels = [...container.querySelectorAll('.app-nav-item')].map(a => a.textContent)
  for (const label of ['Playground', 'Analytics', 'Chat models', 'Image', 'Video', 'Audio', 'Embeddings', 'Decision', 'Search', 'Fusion', 'Keys', 'Agents', 'Logs', 'Premium']) {
    expect(labels.filter(text => text?.startsWith(label)).length).toBe(2) // desktop + mobile drawer
  }
  const active = [...container.querySelectorAll('.app-nav-item.is-active')]
  expect(active).toHaveLength(2)
  expect(active.every(a => a.getAttribute('href') === '/models/chat')).toBe(true)
  expect(container.textContent).toContain('2') // action-needed badge
})

it('opens the mobile drawer, closes on Escape, and restores body scroll', async () => {
  const trigger = container.querySelector('.mobile-nav-bar button[aria-expanded]') as HTMLButtonElement
  const drawer = container.querySelector('.fixed.inset-0') as HTMLElement
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(drawer.getAttribute('aria-hidden')).toBe('true')
  expect(drawer.hasAttribute('inert')).toBe(true)

  await act(async () => { trigger.click() })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(drawer.getAttribute('aria-hidden')).toBe('false')
  expect(drawer.hasAttribute('inert')).toBe(false)
  expect(document.body.style.overflow).toBe('hidden')

  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(drawer.getAttribute('aria-hidden')).toBe('true')
  expect(document.body.style.overflow).toBe('')
})

it('defaults to dark and keeps an explicit theme switch available in the drawer', async () => {
  await flush()
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  const toggles = [...container.querySelectorAll('button[aria-label="Theme"]')] as HTMLButtonElement[]
  expect(toggles).toHaveLength(2)
  await act(async () => { toggles[0].click() })
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  expect(window.localStorage.getItem('theme')).toBe('light')
})
