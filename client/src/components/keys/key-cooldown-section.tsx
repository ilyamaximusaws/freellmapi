import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clock, Loader2, PauseCircle, PlayCircle } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ApiKey } from '../../../../shared/types'

/**
 * [fork 7/10] Key-wide cooldown: park a key with a reason and a duration, or see
 * the one a provider 429's Retry-After already set. A parked key is skipped by
 * the router with the reason visible here, so an idling key is a decision, not a
 * mystery.
 */

const DEFAULT_COOLDOWN_HOURS = 1

export function KeyCooldownSection({ apiKey }: { apiKey: ApiKey }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [hours, setHours] = useState(String(DEFAULT_COOLDOWN_HOURS))

  const cooldown = apiKey.keyCooldown
  const active = cooldown && cooldown.expiresAtMs > Date.now()

  const setCooldown = useMutation({
    mutationFn: () =>
      apiFetch(`/api/keys/${apiKey.id}/cooldown`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() || t('keys.cooldownDefaultReason'), seconds: Math.round(Number(hours) * 3600) }),
      }),
    onSuccess: () => {
      setReason('')
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const clear = useMutation({
    mutationFn: () => apiFetch(`/api/keys/${apiKey.id}/cooldown`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['keys'] }),
  })

  const expired = cooldown && !active

  return (
    <details className="group" open={Boolean(active) || undefined}>
      <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
        {cooldown && active
          ? t('keys.cooldownActive', { until: new Date(cooldown.expiresAtMs).toLocaleTimeString() })
          : expired
            ? t('keys.cooldownExpired')
            : t('keys.cooldownTitle')}
      </summary>

      <div className="mt-2 space-y-2">
        {active && cooldown ? (
          <div className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs">
            <PauseCircle className="size-4 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{cooldown.reason}</p>
              {cooldown.note ? <p className="text-[11px] text-muted-foreground">{cooldown.note}</p> : null}
              <p className="text-[11px] text-muted-foreground">
                {t('keys.cooldownUntil', { until: new Date(cooldown.expiresAtMs).toLocaleString() })}
                {cooldown.source === 'retry_after' ? ` · ${t('keys.cooldownSourceRetryAfter')}` : ''}
              </p>
            </div>
            <Button type="button" size="xs" variant="outline" disabled={clear.isPending} onClick={() => clear.mutate()}>
              <PlayCircle className="size-3.5" />
              {t('keys.cooldownClear')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-[1fr_6rem_auto]">
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="key-cooldown-reason">{t('keys.cooldownReasonLabel')}</Label>
              <Input
                id="key-cooldown-reason"
                value={reason}
                onChange={event => setReason(event.target.value)}
                placeholder={t('keys.cooldownReasonPlaceholder')}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="key-cooldown-hours">{t('keys.cooldownHoursLabel')}</Label>
              <Input
                id="key-cooldown-hours"
                inputMode="numeric"
                value={hours}
                onChange={event => setHours(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                size="sm"
                disabled={setCooldown.isPending || !/^\\d*\\.?\\d+$/.test(hours.trim()) || Number(hours) <= 0}
                onClick={() => setCooldown.mutate()}
              >
                {setCooldown.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Clock className="size-3.5" />}
                {t('keys.cooldownSet')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </details>
  )
}