import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, PlayCircle } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import type { ApiKey } from '../../../../shared/types'

/**
 * [fork 8/10] A key in the failure-streak penalty: it kept timing out, so the
 * router is skipping it for a growing duration. The section only renders while
 * the penalty is live, and offers an early "unpark".
 */

export function KeyPenaltySection({ apiKey }: { apiKey: ApiKey }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const penalty = apiKey.penalty
  const active = penalty?.penalizedUntilMs != null && penalty.penalizedUntilMs > Date.now()

  const clear = useMutation({
    mutationFn: () => apiFetch(`/api/keys/${apiKey.id}/penalty`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  if (!penalty || (!active && penalty.streak === 0)) return null

  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-xs">
      <AlertTriangle className="size-4 text-amber-500" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {active
            ? t('keys.penaltyActive', { step: penalty.step, until: new Date(penalty.penalizedUntilMs!).toLocaleString() })
            : t('keys.penaltyRecent', { streak: penalty.streak })}
        </p>
        <p className="text-[11px] text-muted-foreground">{t('keys.penaltyHint')}</p>
      </div>
      {active ? (
        <Button type="button" size="xs" variant="outline" disabled={clear.isPending} onClick={() => clear.mutate()}>
          <PlayCircle className="size-3.5" />
          {t('keys.penaltyClear')}
        </Button>
      ) : null}
    </div>
  )
}