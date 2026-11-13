import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ConfirmButton } from '@/components/confirm-button'
import { ChevronRight, RotateCw, Trash2, SlidersHorizontal } from 'lucide-react'
import { useI18n } from '@/i18n'

// Per-client resource limits ([fork 1/10]). 0 = unlimited, matching the
// per-key cap convention. Kept as a flat shape so it round-trips the API.
interface ClientLimits {
  maxConcurrent: number
  rpm: number
  tpm: number
  dailyRequestCap: number
  dailyTokenCap: number
  monthlyRequestCap: number
  monthlyTokenCap: number
  maxTokensPerRequest: number
  maxRequestBytes: number
  profileId: number | null
}

interface ClientUsageWindow { requests: number; tokens: number }

interface ClientProfile {
  id: number
  name: string
  maskedKey: string
  systemPrompt: string | null
  enabled: boolean
  limits: ClientLimits
  usage: { day: ClientUsageWindow; month: ClientUsageWindow; active: number }
  lastUsedAt: string | null
}

type ProfileWithKey = ClientProfile & { key: string }

const UNLIMITED: ClientLimits = {
  maxConcurrent: 0, rpm: 0, tpm: 0,
  dailyRequestCap: 0, dailyTokenCap: 0,
  monthlyRequestCap: 0, monthlyTokenCap: 0,
  maxTokensPerRequest: 0, maxRequestBytes: 0,
  profileId: null,
}

// Per-client API keys with a server-enforced system prompt (#411) and per-agent
// resource limits ([fork 1/10]). Deliberately a collapsed accordion under the
// unified-key card — the unified key stays the first-class flow (it is the
// implicit unlimited `default` client); this is the power-user add-on.
export function ClientProfilesSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  // The freshly minted key (create/rotate) — shown once, never fetchable again.
  const [newKey, setNewKey] = useState<{ id: number; key: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [editingLimits, setEditingLimits] = useState<number | null>(null)

  const { data: profiles = [] } = useQuery<ClientProfile[]>({
    queryKey: ['client-profiles'],
    queryFn: () => apiFetch('/api/client-profiles'),
    enabled: open,
    refetchInterval: 15000,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['client-profiles'] })

  const create = useMutation({
    mutationFn: () => apiFetch<ProfileWithKey>('/api/client-profiles', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), systemPrompt: prompt.trim() || null }),
    }),
    onSuccess: (created) => {
      setName('')
      setPrompt('')
      setNewKey({ id: created.id, key: created.key })
      invalidate()
    },
  })

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: number; enabled?: boolean; limits?: Partial<ClientLimits> }) =>
      apiFetch(`/api/client-profiles/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })

  const rotate = useMutation({
    mutationFn: (id: number) =>
      apiFetch<ProfileWithKey>(`/api/client-profiles/${id}/rotate`, { method: 'POST' }),
    onSuccess: (rotated) => {
      setNewKey({ id: rotated.id, key: rotated.key })
      invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/client-profiles/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      setNewKey(current => (current?.id === id ? null : current))
      invalidate()
    },
  })

  async function copyNewKey() {
    if (!newKey || !await copyText(newKey.key)) {
      toast.error(t('common.copyFailed'))
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 p-5 text-start"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <div>
          <h2 className="text-sm font-medium">{t('keys.cpTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('keys.cpDesc')}</p>
        </div>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          {newKey && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5 space-y-1.5">
              <p className="text-xs text-muted-foreground">{t('keys.cpKeyOnce')}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate">{newKey.key}</code>
                <Button variant="outline" size="sm" onClick={() => void copyNewKey()}>
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setNewKey(null)}>
                  {t('common.dismiss')}
                </Button>
              </div>
            </div>
          )}

          {profiles.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('keys.cpEmpty')}</p>
          ) : (
            <ul className="divide-y">
              {profiles.map(p => (
                <li key={p.id} className="py-2 space-y-1.5">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium truncate">{p.name}</span>
                        <code className="font-mono text-[11px] text-muted-foreground">{p.maskedKey}</code>
                      </div>
                      {p.systemPrompt && (
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">{p.systemPrompt}</p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('keys.cpLimits')}
                      title={t('keys.cpLimits')}
                      onClick={() => setEditingLimits(editingLimits === p.id ? null : p.id)}
                    >
                      <SlidersHorizontal className="size-3.5" />
                    </Button>
                    <Switch
                      size="sm"
                      checked={p.enabled}
                      onCheckedChange={(enabled) => update.mutate({ id: p.id, enabled })}
                      aria-label={t('keys.cpEnabledAria')}
                    />
                    <ConfirmButton
                      onConfirm={() => rotate.mutate(p.id)}
                      size="icon-xs"
                      armedSize="xs"
                      confirmLabel={t('keys.cpRotate')}
                      title={t('keys.cpRotate')}
                      aria-label={t('keys.cpRotate')}
                    >
                      <RotateCw className="size-3.5" />
                    </ConfirmButton>
                    <ConfirmButton
                      onConfirm={() => remove.mutate(p.id)}
                      size="icon-xs"
                      armedSize="xs"
                      armedClassName="text-destructive"
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="size-3.5" />
                    </ConfirmButton>
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    {t('keys.cpUsage')
                      .replace('{requests}', String(p.usage?.day.requests ?? 0))
                      .replace('{tokens}', String(p.usage?.day.tokens ?? 0))
                      .replace('{monthRequests}', String(p.usage?.month.requests ?? 0))
                      .replace('{monthTokens}', String(p.usage?.month.tokens ?? 0))
                      .replace('{active}', String(p.usage?.active ?? 0))}
                  </p>

                  {editingLimits === p.id && (
                    <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                      <LimitsEditor
                        initial={p.limits ?? UNLIMITED}
                        saving={update.isPending}
                        onSave={(limits) => update.mutate({ id: p.id, limits }, {
                          onSuccess: () => setEditingLimits(null),
                        })}
                        onCancel={() => setEditingLimits(null)}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form
            className="space-y-2 border-t pt-4"
            onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate() }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('keys.cpNamePlaceholder')}
              aria-label={t('keys.cpNameLabel')}
              maxLength={100}
            />
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('keys.cpPromptPlaceholder')}
              aria-label={t('keys.cpPromptLabel')}
              rows={3}
            />
            <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
              {t('keys.cpCreate')}
            </Button>
          </form>
        </div>
      )}
    </section>
  )
}

// Nine numeric fields in a compact grid. Every field is 0 = unlimited.
function LimitsEditor({ initial, saving, onSave, onCancel }: {
  initial: ClientLimits
  saving: boolean
  onSave: (limits: Partial<ClientLimits>) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Partial<ClientLimits>>(initial)

  const fields: Array<[keyof ClientLimits, string]> = [
    ['maxConcurrent', t('keys.cpMaxConcurrent')],
    ['rpm', t('keys.cpRpm')],
    ['tpm', t('keys.cpTpm')],
    ['dailyRequestCap', t('keys.cpDailyRequests')],
    ['dailyTokenCap', t('keys.cpDailyTokens')],
    ['monthlyRequestCap', t('keys.cpMonthlyRequests')],
    ['monthlyTokenCap', t('keys.cpMonthlyTokens')],
  ]

  return (
    <>
      <p className="text-[11px] text-muted-foreground">{t('keys.cpLimitsHint')}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {fields.map(([field, label]) => (
          <label key={field} className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">{label}</span>
            <Input
              type="number"
              min={0}
              className="h-8 text-xs"
              value={Number(draft[field] ?? 0)}
              onChange={(e) => setDraft(current => ({ ...current, [field]: Math.max(0, Number(e.target.value) || 0) }))}
              aria-label={label}
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={saving} onClick={() => onSave(draft)}>{t('common.save')}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </>
  )
}