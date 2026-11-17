import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AudioLines,
  Bot,
  Boxes,
  ChartColumn,
  Clapperboard,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Layers,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  RefreshCw,
  Scale,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Sun,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { ChangeCredentialsModal } from '@/components/auth-gate'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { openCommandPalette } from '@/components/command-palette-state'
import { SettingsDialog } from '@/components/settings-dialog'
import { UpdatesDialog } from '@/components/updates-dialog'
import { usePremium } from '@/hooks/use-premium'
import { useI18n } from '@/i18n'
import { apiFetch, logout } from '@/lib/api'
import { isDesktopApp, isMac, isMacDesktop } from '@/lib/desktop'
import { OPEN_UPDATES_EVENT } from '@/lib/updates'
import { useTheme } from '@/theme-context'
import { cn } from '@/lib/utils'

interface NavEntry {
  to: string
  labelKey: string
  icon: LucideIcon
}

const primaryItems: NavEntry[] = [
  { to: '/playground', labelKey: 'nav.playground', icon: SquareTerminal },
  { to: '/analytics', labelKey: 'nav.analytics', icon: ChartColumn },
]

const modelItems: NavEntry[] = [
  { to: '/models/chat', labelKey: 'models.chatModelsTab', icon: Boxes },
  { to: '/models/image', labelKey: 'models.imageTab', icon: ImageIcon },
  { to: '/models/video', labelKey: 'models.videoTab', icon: Clapperboard },
  { to: '/models/audio', labelKey: 'models.audioTab', icon: AudioLines },
  { to: '/models/embeddings', labelKey: 'models.embeddingsTab', icon: Layers },
  { to: '/models/decision', labelKey: 'decision.tab', icon: Scale },
  { to: '/models/search', labelKey: 'search.tab', icon: Globe },
  { to: '/models/fusion', labelKey: 'models.fusionTab', icon: Zap },
]

const systemItems: NavEntry[] = [
  { to: '/keys', labelKey: 'nav.keys', icon: KeyRound },
  { to: '/agents', labelKey: 'nav.agents', icon: Bot },
  { to: '/logs', labelKey: 'nav.logs', icon: ChartColumn },
  { to: '/premium', labelKey: 'nav.premium', icon: Sparkles },
]

function useActionNeededCount(): number {
  const { data } = useQuery<{ summary: { total: number } }>({
    queryKey: ['action-needed', 'count'],
    queryFn: () => apiFetch('/api/keys/action-needed'),
    refetchInterval: 60000,
  })
  return data?.summary.total ?? 0
}

export function Brand({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  return (
    <Link to="/" onClick={onNavigate} className="brand-mark group inline-flex items-center gap-2.5 rounded-lg" aria-label="FreeLLMAPI">
      <span className="brand-symbol" aria-hidden="true">
        <span />
        <span />
      </span>
      {!compact && (
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold leading-none tracking-[-0.025em]">FreeLLMAPI</span>
          <span className="mt-1.5 block text-[9px] font-medium uppercase leading-none tracking-[0.16em] text-muted-foreground">LLM router</span>
        </span>
      )}
    </Link>
  )
}

function Navigation({ onNavigate, badge }: { onNavigate?: () => void; badge: number }) {
  const { t } = useI18n()

  function renderGroup({ labelKey, items }: { labelKey?: string; items: NavEntry[] }) {
    return (
      <div className="nav-group">
        {labelKey && <p className="nav-group-label">{t(labelKey)}</p>}
        <div className="space-y-0.5">
          {items.map(item => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) => cn('app-nav-item', isActive && 'is-active')}
              >
                <Icon aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                {item.to === '/keys' && badge > 0 && (
                  <span className="nav-badge" aria-label={String(badge)}>{badge}</span>
                )}
              </NavLink>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <nav className="flex flex-col gap-6" aria-label={t('nav.openMenu')}>
      {renderGroup({ items: primaryItems })}
      {renderGroup({ labelKey: 'nav.models', items: modelItems })}
      {renderGroup({ labelKey: 'nav.settings', items: systemItems })}
    </nav>
  )
}

export function Sidebar() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { resolvedDark, setTheme } = useTheme()
  const badge = useActionNeededCount()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [credentialsMode, setCredentialsMode] = useState<'password' | 'email' | null>(null)

  useEffect(() => {
    if (!mobileOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', close)
    }
  }, [mobileOpen])

  function renderFooter() {
    return (
      <>
        <button type="button" onClick={() => { setMobileOpen(false); openCommandPalette() }} className="sidebar-search">
          <Search aria-hidden="true" />
          <span className="flex-1 text-left">{t('palette.title')}</span>
          <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setTheme(resolvedDark ? 'light' : 'dark')}
            aria-label={t('settings.theme')}
            title={t(resolvedDark ? 'settings.themeLight' : 'settings.themeDark')}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'flex-1 border border-border/60')}
          >
            {resolvedDark ? <Sun /> : <Moon />}
            {t(resolvedDark ? 'settings.themeLight' : 'settings.themeDark')}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'flex-1 border border-border/60')}>
              <Settings />
              {t('nav.settings')}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-52">
              <AccountMenuItems
                showUpgrade={false}
                onUpgrade={() => navigate('/premium')}
                onOpenSettings={() => { setMobileOpen(false); setSettingsOpen(true) }}
                onOpenUpdates={() => { setMobileOpen(false); setUpdatesOpen(true) }}
                onChangeEmail={() => { setMobileOpen(false); setCredentialsMode('email') }}
                onChangePassword={() => { setMobileOpen(false); setCredentialsMode('password') }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </>
    )
  }

  return (
    <>
      <aside
        className={cn('app-sidebar hidden lg:flex', isMacDesktop && 'pt-10')}
        style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
      >
        <div className="flex h-[72px] shrink-0 items-center px-5" style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}>
          <Brand />
        </div>
        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-2">
          <Navigation badge={badge} />
        </div>
        <div className="border-t border-sidebar-border px-5 py-4">
          {renderFooter()}
        </div>
      </aside>

      <div className="mobile-nav-bar sticky top-0 z-40 flex h-14 items-center justify-between border-b bg-background/85 px-4 backdrop-blur-xl lg:hidden">
        <Brand />
        <button
          type="button"
          aria-label={t('nav.openMenu')}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
          className={buttonVariants({ variant: 'ghost', size: 'icon' })}
        >
          <Menu />
        </button>
      </div>

      <div
        className={cn('fixed inset-0 z-[65] lg:hidden', mobileOpen ? 'pointer-events-auto' : 'pointer-events-none')}
        aria-hidden={!mobileOpen}
        inert={!mobileOpen}
      >
        <button
          type="button"
          aria-label={t('common.dismiss')}
          onClick={() => setMobileOpen(false)}
          className={cn('absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200', mobileOpen ? 'opacity-100' : 'opacity-0')}
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label={t('nav.openMenu')}
          className={cn('app-sidebar mobile-sidebar absolute inset-y-0 left-0 flex w-[min(86vw,320px)] transition-transform duration-300 ease-out', mobileOpen ? 'translate-x-0' : '-translate-x-full')}
        >
          <div className="flex h-[72px] shrink-0 items-center justify-between px-5">
            <Brand onNavigate={() => setMobileOpen(false)} />
            <button type="button" onClick={() => setMobileOpen(false)} aria-label={t('common.dismiss')} className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
              <X />
            </button>
          </div>
          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-2">
            <Navigation badge={badge} onNavigate={() => setMobileOpen(false)} />
          </div>
          <div className="border-t border-sidebar-border px-5 py-4">
            {renderFooter()}
          </div>
        </aside>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UpdatesDialog open={updatesOpen} onOpenChange={setUpdatesOpen} />
      {credentialsMode && <ChangeCredentialsModal mode={credentialsMode} onClose={() => setCredentialsMode(null)} />}
    </>
  )
}

function AccountMenuItems({
  showUpgrade,
  onUpgrade,
  onOpenSettings,
  onOpenUpdates,
  onChangeEmail,
  onChangePassword,
}: {
  showUpgrade: boolean
  onUpgrade: () => void
  onOpenSettings: () => void
  onOpenUpdates: () => void
  onChangeEmail: () => void
  onChangePassword: () => void
}) {
  const { t } = useI18n()
  return (
    <>
      {showUpgrade && (
        <DropdownMenuItem onClick={onUpgrade}>
          <Sparkles />
          {t('nav.upgrade')}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={onOpenSettings}>
        <Settings />
        {t('nav.settings')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onOpenUpdates}>
        <RefreshCw />
        {t('settings.checkForUpdates')}
      </DropdownMenuItem>
      {!isDesktopApp && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onChangeEmail}>
            <span className="flex size-4 items-center justify-center font-serif text-xs font-bold">@</span>
            {t('auth.changeEmail')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onChangePassword}>
            <KeyRound />
            {t('auth.changePassword')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => logout()}>
            <LogOut />
            {t('nav.signOut')}
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

export function Topbar() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const { resolvedDark, setTheme } = useTheme()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [credentialsMode, setCredentialsMode] = useState<'password' | 'email' | null>(null)
  const { data: premium, licensed, isLoading: premiumLoading, isError: premiumError } = usePremium()
  const showUpgrade = Boolean(premium) && !licensed && !premiumLoading && !premiumError

  useEffect(() => {
    const open = () => setUpdatesOpen(true)
    window.addEventListener(OPEN_UPDATES_EVENT, open)
    return () => window.removeEventListener(OPEN_UPDATES_EVENT, open)
  }, [])

  const current = [...primaryItems, ...modelItems, ...systemItems].find(item =>
    location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  )

  return (
    <>
      <header
        className="app-topbar sticky top-0 z-30 hidden h-[72px] items-center gap-4 border-b bg-background/75 px-6 backdrop-blur-xl lg:flex xl:px-8"
        style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
      >
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">FreeLLMAPI</p>
          <p className="mt-1 truncate text-sm font-medium">{current ? t(current.labelKey) : 'FreeLLMAPI'}</p>
        </div>
        <button type="button" onClick={openCommandPalette} className="topbar-search" style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}>
          <Search aria-hidden="true" />
          <span className="flex-1 text-left">{t('palette.placeholder')}</span>
          <kbd>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
        </button>
        <div className="flex items-center gap-1" style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}>
          <button
            type="button"
            onClick={() => setTheme(resolvedDark ? 'light' : 'dark')}
            aria-label={t('settings.theme')}
            title={t(resolvedDark ? 'settings.themeLight' : 'settings.themeDark')}
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
          >
            {resolvedDark ? <Sun /> : <Moon />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon' })} aria-label={t('nav.openMenu')}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <AccountMenuItems
                showUpgrade={showUpgrade}
                onUpgrade={() => navigate('/premium')}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenUpdates={() => setUpdatesOpen(true)}
                onChangeEmail={() => setCredentialsMode('email')}
                onChangePassword={() => setCredentialsMode('password')}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UpdatesDialog open={updatesOpen} onOpenChange={setUpdatesOpen} />
      {credentialsMode && <ChangeCredentialsModal mode={credentialsMode} onClose={() => setCredentialsMode(null)} />}
    </>
  )
}
