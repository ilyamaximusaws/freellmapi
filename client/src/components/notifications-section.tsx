import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, Loader2, Plus, Send, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

/** [fork 9/10] Notification channels and per-event toggles. */

const EVENTS = [
  'key_error', 'cap_soft', 'cap_hard', 'provider_no_keys',
  'ready_upstreams_low', 'action_needed', 'key_expiring',
] as const

interface Channel {
  id: number
  kind: 'webhook' | 'telegram'
  name: string
  url: string | null
  botToken: string | null
  chatId: string | null
  events: Record<string, boolean>
  enabled: boolean
}

interface NsSettings {
  events: Record<string, boolean>
  webhookTimeoutMs: number
  cooldownMs: number
  maxAttempts: number
  backoffBaseMs: number
  readyUpstreamsMin: number
}

export function NotificationsSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const settingsQ = useQuery({ queryKey: ['notifications-settings'], queryFn: () => apiFetch<NsSettings>('/api/notifications/settings') })
  const channelsQ = useQuery({ queryKey: ['notifications-channels'], queryFn: () => apiFetch<{ channels: Channel[] }>('/api/notifications/channels') })

  const [draft, setDraft] = useState<NsSettings | null>(null)
  const settings = draft ?? settingsQ.data ?? { events: {}, webhookTimeoutMs: 10000, cooldownMs: 1800000, maxAttempts: 3, backoffBaseMs: 5000, readyUpstreamsMin: 0 }

  const [newKind, setNewKind] = useState<'webhook' | 'telegram'>('webhook')
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newBotToken, setNewBotToken] = useState('')
  const [newChatId, setNewChatId] = useState('')

  const saveSettings = useMutation({
    mutationFn: (body: Partial<NsSettings>) => apiFetch<NsSettings>('/api/notifications/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: next => {
      setDraft(null)
      queryClient.setQueryData(['notifications-settings'], next)
    },
  })

  const addChannel = useMutation({
    mutationFn: () => apiFetch('/api/notifications/channels', {
      method: 'POST',
      body: JSON.stringify(newKind === 'webhook'
        ? { kind: 'webhook', name: newName, url: newUrl }
        : { kind: 'telegram', name: newName, botToken: newBotToken, chatId: newChatId }),
    }),
    onSuccess: () => {
      setNewName(''); setNewUrl(''); setNewBotToken(''); setNewChatId('')
      queryClient.invalidateQueries({ queryKey: ['notifications-channels'] })
    },
  })

  const deleteChannel = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/notifications/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications-channels'] }),
  })

  const sendTest = useMutation({
    mutationFn: () => apiFetch('/api/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ event: 'key_error', title: t('notifications.testTitle'), body: t('notifications.testBody') }),
    }),
  })

  const toggleEvent = (event: string, on: boolean) => {
    setDraft(cur => ({ ...(cur ?? settings), events: { ...(cur?.events ?? settings.events), [event]: on } }))
  }
  const setNumber = (key: keyof NsSettings) => (value: string) => {
    setDraft(cur => ({ ...(cur ?? settings), [key]: value === '' ? 0 : Number(value) }))
  }

  const channels = channelsQ.data?.channels ?? []
  const canAdd = newName.trim() && (newKind === 'webhook' ? newUrl.trim() : newBotToken.trim() && newChatId.trim())
  const dirty = draft != null

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium">{t('notifications.channels')}</h3>
        <p className="text-xs text-muted-foreground">{t('notifications.empty')}</p>
      </div>

      <div className="space-y-2">
        {channels.map(channel => (
          <div key={channel.id} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs">
            <BellRing className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{channel.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {channel.kind === 'webhook' ? channel.url : `${channel.chatId}`}
              </p>
            </div>
            <Button type="button" size="xs" variant="ghost" disabled={deleteChannel.isPending} onClick={() => deleteChannel.mutate(channel.id)} aria-label={t('notifications.delete')}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <div className="grid gap-2 rounded-md border border-border/60 p-3 sm:grid-cols-2">
        <select
          value={newKind}
          onChange={event => setNewKind(event.target.value as 'webhook' | 'telegram')}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none"
        >
          <option value="webhook">{t('notifications.addWebhook')}</option>
          <option value="telegram">{t('notifications.addTelegram')}</option>
        </select>
        <Input value={newName} onChange={event => setNewName(event.target.value)} placeholder={t('notifications.nameLabel')} className="h-8 text-xs" />
        {newKind === 'webhook' ? (
          <Input value={newUrl} onChange={event => setNewUrl(event.target.value)} placeholder={t('notifications.urlLabel')} className="h-8 font-mono text-xs sm:col-span-2" />
        ) : (
          <>
            <Input value={newBotToken} onChange={event => setNewBotToken(event.target.value)} placeholder={t('notifications.botTokenLabel')} className="h-8 font-mono text-xs" />
            <Input value={newChatId} onChange={event => setNewChatId(event.target.value)} placeholder={t('notifications.chatIdLabel')} className="h-8 font-mono text-xs" />
          </>
        )}
        <Button type="button" size="sm" disabled={!canAdd || addChannel.isPending} onClick={() => addChannel.mutate()} className="sm:col-span-2">
          {addChannel.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {newKind === 'webhook' ? t('notifications.addWebhook') : t('notifications.addTelegram')}
        </Button>
      </div>

      <div>
        <h3 className="text-sm font-medium">{t('notifications.events')}</h3>
        <div className="mt-1 space-y-1">
          {EVENTS.map(event => (
            <label key={event} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/40">
              <span>{t(`notifications.event${event[0].toUpperCase()}${event.slice(1)}`)}</span>
              <Switch checked={settings.events[event] !== false} onCheckedChange={on => toggleEvent(event, on)} />
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <span className="text-xs">{t('notifications.readyMinLabel')}</span>
          <Input inputMode="numeric" value={String(settings.readyUpstreamsMin)} onChange={event => setNumber('readyUpstreamsMin')(event.target.value)} className="h-8 font-mono text-xs" />
        </div>
        <div className="space-y-1.5">
          <span className="text-xs">{t('notifications.cooldownLabel')}</span>
          <Input inputMode="numeric" value={String(settings.cooldownMs)} onChange={event => setNumber('cooldownMs')(event.target.value)} className="h-8 font-mono text-xs" />
        </div>
        <div className="space-y-1.5">
          <span className="text-xs">{t('notifications.webhookTimeoutLabel')}</span>
          <Input inputMode="numeric" value={String(settings.webhookTimeoutMs)} onChange={event => setNumber('webhookTimeoutMs')(event.target.value)} className="h-8 font-mono text-xs" />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!dirty || saveSettings.isPending} onClick={() => saveSettings.mutate(draft ?? {})}>
          {saveSettings.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('notifications.save')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={sendTest.isPending || channels.length === 0} onClick={() => sendTest.mutate()}>
          <Send className="size-3.5" />
          {t('notifications.testNow')}
        </Button>
      </div>
    </div>
  )
}