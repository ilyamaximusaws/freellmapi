import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Clock, ExternalLink, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * [fork 5/10] Keys waiting on a human: the credential is fine, but the provider
 * wants a phone confirmed, new terms accepted, a card added or the daily bonus
 * claimed. The banner is the one place that says "these keys are out of rotation
 * and here is the link" — a key that silently stops routing looks identical to a
 * dead one otherwise.
 */

export interface ActionNeededFlag {
  id: number
  keyId: number
  label?: string
  platform?: string | null
  reason: string
  url: string | null
  note: string | null
  policy: 'inform_only' | 'exclude_from_rotation'
  source: 'manual' | 'auto'
  createdAt: string
  snoozedUntilMs: number | null
  snoozed?: boolean
  recurrenceKind: 'none' | 'interval' | 'daily'
  recurrenceHours: number | null
  recurrenceHour: number | null
}

interface ActionList {
  summary: { total: number; excluded: number; byReason: Record<string, number> }
  actions: ActionNeededFlag[]
}

const DEFAULT_SNOOZE_HOURS = 4

export function ActionNeededSection({ includeSnoozed = false }: { includeSnoozed?: boolean }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [snoozeHours, setSnoozeHours] = useState(String(DEFAULT_SNOOZE_HOURS))

  const { data, isLoading } = useQuery<ActionList>({
    queryKey: ['action-needed', includeSnoozed],
    queryFn: () => apiFetch(`/api/keys/action-needed${includeSnoozed ? '?includeSnoozed=1' : ''}`),
    refetchInterval: 60000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['action-needed'] })
    queryClient.invalidateQueries({ queryKey: ['keys'] })
  }

  const done = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/keys/${keyId}/action/done`, { method: 'POST' }),
    onSuccess: invalidate,
  })

  const snooze = useMutation({
    mutationFn: (keyId: number) =>
      apiFetch(`/api/keys/${keyId}/action/snooze`, {
        method: 'POST',
        body: JSON.stringify({ hours: Number(snoozeHours) || DEFAULT_SNOOZE_HOURS }),
      }),
    onSuccess: invalidate,
  })

  const actions = data?.actions ?? []
  const summary = data?.summary
  if (isLoading || !summary || actions.length === 0) return null

  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 text-amber-500" />
        <h2 className="text-sm font-medium">
          {t('keys.actionNeededTitle', { count: summary.total.toLocaleString() })}
        </h2>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {summary.excluded > 0
          ? t('keys.actionNeededExcludedHint', { count: summary.excluded.toLocaleString() })
          : t('keys.actionNeededHint')}
      </p>

      <ul className="mt-3 space-y-2">
        {actions.map(flag => (
          <li key={flag.id} className="rounded-md border border-border/60 bg-background px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">
                  {flag.label ?? `key ${flag.keyId}`}
                  {flag.platform ? <span className="text-muted-foreground"> · {flag.platform}</span> : null}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {t(`keys.actionReason_${flag.reason}`)}
                  {' · '}
                  {flag.policy === 'exclude_from_rotation' ? t('keys.actionPolicyExcluded') : t('keys.actionPolicyInformOnly')}
                  {flag.recurrenceKind !== 'none' ? ` · ${t('keys.actionRecurring')}` : ''}
                  {flag.snoozed ? ` · ${t('keys.actionSnoozed')}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {flag.url ? (
                  <a
                    href={flag.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-xs underline"
                  >
                    {t('keys.actionOpen')}
                    <ExternalLink className="size-3" />
                  </a>
                ) : null}
                <Input
                  inputMode="numeric"
                  value={snoozeHours}
                  onChange={event => setSnoozeHours(event.target.value)}
                  aria-label={t('keys.actionSnoozeHours')}
                  className="h-8 w-16 font-mono text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={snooze.isPending}
                  onClick={() => snooze.mutate(flag.keyId)}
                >
                  <Clock className="size-3.5" />
                  {t('keys.actionSnooze')}
                </Button>
                <Button type="button" size="sm" disabled={done.isPending} onClick={() => done.mutate(flag.keyId)}>
                  {done.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  {t('keys.actionDone')}
                </Button>
              </div>
            </div>
            {flag.note ? <p className="mt-1 text-[11px] text-muted-foreground">{flag.note}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
