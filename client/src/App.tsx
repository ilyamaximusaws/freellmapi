import type { ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthGate } from '@/components/auth-gate'
import { CommandPalette } from '@/components/command-palette'
import { ErrorBoundary } from '@/components/error-boundary'
import { Toaster } from '@/components/toaster'
import { UpdateReminder } from '@/components/update-reminder'
import { NewBuildPrompt } from '@/components/new-build-prompt'
import { Sidebar, Topbar } from '@/components/app-navigation'
import { isMacDesktop } from '@/lib/desktop'
import { I18nProvider } from '@/i18n'
import { toast } from '@/lib/toast'
import { ThemeProvider } from '@/theme'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import ModelDetailPage from '@/pages/ModelDetailPage'
import FusionPage from '@/pages/FusionPage'
import EmbeddingsPage from '@/pages/EmbeddingsPage'
import ImagePage from '@/pages/ImagePage'
import VideoPage from '@/pages/VideoPage'
import AudioPage from '@/pages/AudioPage'
import SearchPage from '@/pages/SearchPage'
import DecisionPage from '@/pages/DecisionPage'
import MediaDetailPage from '@/pages/MediaDetailPage'
import EmbeddingDetailPage from '@/pages/EmbeddingDetailPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import LogsPage from '@/pages/LogsPage'
import PremiumPage from '@/pages/PremiumPage'
import NotFoundPage from '@/pages/NotFoundPage'
import AgentsPage from '@/pages/AgentsPage'

// Every failed mutation surfaces as an error toast, so no action fails
// silently. A page that already shows the failure inline can opt out with
// `meta: { silenceToast: true }` on the mutation.
const queryClient = new QueryClient({
  // Cached data renders immediately; background refetches are deduped across
  // page mounts. Poller intervals and explicit mutation invalidation still apply.
  defaultOptions: { queries: { staleTime: 30_000 } },
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silenceToast) return
      toast.error(error instanceof Error ? error.message : String(error))
    },
  }),
})

// Keyed by pathname so navigating away from a crashed page resets the boundary.
function PageBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
}

// Playground owns the remaining viewport and scrolls its own transcript. All
// other routes share a wider, stable workspace with a short route transition.
const FULL_BLEED_ROUTES = new Set(['/playground'])

function PageContainer({ children }: { children: ReactNode }) {
  const location = useLocation()
  const fullBleed = FULL_BLEED_ROUTES.has(location.pathname)
  return (
    <main
      key={location.pathname}
      className={fullBleed ? 'flex min-h-0 flex-1 flex-col' : 'page-enter mx-auto w-full max-w-[1440px] px-4 py-7 sm:px-6 lg:px-8 lg:py-9'}
    >
      {children}
    </main>
  )
}

function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const fullBleed = FULL_BLEED_ROUTES.has(location.pathname)
  return (
    <div className={`app-shell flex flex-col lg:flex-row ${fullBleed ? 'h-dvh overflow-hidden' : 'min-h-screen'} ${isMacDesktop ? 'desktop-backdrop' : 'bg-background'}`}>
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar />
        {children}
      </div>
    </div>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL}>
            <AuthGate>
              <AppShell>
                <PageContainer>
                  <PageBoundary>
                    <Routes>
                      <Route path="/" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/models/chat" element={<FallbackPage />} />
                      <Route path="/models/chat/:id" element={<ModelDetailPage />} />
                      <Route path="/models/fusion" element={<FusionPage />} />
                      <Route path="/models/embeddings" element={<EmbeddingsPage />} />
                      <Route path="/models/embeddings/:id" element={<EmbeddingDetailPage />} />
                      <Route path="/models/image" element={<ImagePage />} />
                      <Route path="/models/image/:id" element={<MediaDetailPage modality="image" />} />
                      <Route path="/models/video" element={<VideoPage />} />
                      <Route path="/models/video/:id" element={<MediaDetailPage modality="video" />} />
                      <Route path="/models/audio" element={<AudioPage />} />
                      <Route path="/models/audio/:id" element={<MediaDetailPage modality="audio" />} />
                      <Route path="/models/transcription/:id" element={<MediaDetailPage modality="transcription" />} />
                      <Route path="/models/search" element={<SearchPage />} />
                      <Route path="/models/decision" element={<DecisionPage />} />
                      <Route path="/playground" element={<PlaygroundPage />} />
                      <Route path="/keys" element={<KeysPage />} />
                      <Route path="/agents" element={<AgentsPage />} />
                      <Route path="/fallback" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/analytics" element={<AnalyticsPage />} />
                      <Route path="/logs" element={<LogsPage />} />
                      <Route path="/premium" element={<PremiumPage />} />
                      <Route path="/test" element={<Navigate to="/playground" replace />} />
                      <Route path="/health" element={<Navigate to="/keys" replace />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Routes>
                  </PageBoundary>
                </PageContainer>
                <Toaster />
                <CommandPalette />
                <UpdateReminder />
                <NewBuildPrompt />
              </AppShell>
            </AuthGate>
          </BrowserRouter>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

export default App
