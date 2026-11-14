import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import type { ApiKey } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'

/**
 * [fork 6/10] Bulk rotation editing: weight and order are per-key, but they are
 * set in groups ("these three are primaries, the rest are backups"), so editing
 * them one dialog at a time is the wrong shape. Rows whose numbers were not
 * touched are not sent, and everything goes in one PATCH.
 */

interface Draft {
  weight: string
  order: string
}

const DEFAULT_KEY_WEIGHT = 1
const DEFAULT_KEY_ORDER = 0

export function BulkRotationDialog({ keys, open, onOpenChange }: {
  keys: ApiKey[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Record<number, Draft>>({})

  const draftFor = (key: ApiKey): Draft => draft[key.id] ?? {
    weight: String(key.weight ?? DEFAULT_KEY_WEIGHT),
    order: String(key.order ?? DEFAULT_KEY_ORDER),
  }

  const changes = useMemo(() => {
    const out: Array<{ id: number; weight?: number; order?: number }> = []
    for (const key of keys) {
      const current = draft[key.id]
      if (!current) continue
      const entry: { id: number; weight?: number; order?: number } = { id: key.id }
      const weight = Number(current.weight)
      const order = Number(current.order)
      if (current.weight.trim() !== '' && Number.isInteger(weight) && weight >= 0
          && weight !== (key.weight ?? DEFAULT_KEY_WEIGHT)) {
        entry.weight = weight
      }
      if (current.order.trim() !== '' && Number.isInteger(order)
          && order !== (key.order ?? DEFAULT_KEY_ORDER)) {
        entry.order = order
      }
      if (entry.weight !== undefined || entry.order !== undefined) out.push(entry)
    }
    return out
  }, [draft, keys])

  const save = useMutation({
    mutationFn: async () => {
      // The endpoint takes one value per field for a selection, so group the
      // changes by identical values and issue one request per distinct tuple.
      const byTuple = new Map<string, { weight?: number; order?: number; ids: number[] }>()
      for (const change of changes) {
        const tupleKey = `${change.weight ?? ''}:${change.order ?? ''}`
        const bucket = byTuple.get(tupleKey) ?? { weight: change.weight, order: change.order, ids: [] }
        bucket.ids.push(change.id)
        byTuple.set(tupleKey, bucket)
      }
      for (const bucket of byTuple.values()) {
        await apiFetch('/api/keys/bulk/rotation', {
          method: 'PATCH',
          body: JSON.stringify({ ids: bucket.ids, weight: bucket.weight, order: bucket.order }),
        })
      }
    },
    onSuccess: () => {
      setDraft({})
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-2xl">
        <DialogTitle>{t('keys.rotationTitle')}</DialogTitle>
        <DialogDescription>{t('keys.rotationDescription')}</DialogDescription>

        <div className="max-h-96 space-y-2 overflow-y-auto pe-1">
          {keys.map(key => {
            const value = draftFor(key)
            return (
              <div key={key.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">{key.label || key.maskedKey}</p>
                  <p className="text-[11px] text-muted-foreground">{key.platform}</p>
                </div>
                <Input
                  inputMode="numeric"
                  value={value.weight}
                  aria-label={t('keys.weightLabel')}
                  onChange={event => setDraft(current => ({
                    ...current, [key.id]: { ...draftFor(key), weight: event.target.value },
                  }))}
                  className="h-8 w-20 font-mono text-xs"
                />
                <Input
                  inputMode="numeric"
                  value={value.order}
                  aria-label={t('keys.orderLabel')}
                  onChange={event => setDraft(current => ({
                    ...current, [key.id]: { ...draftFor(key), order: event.target.value },
                  }))}
                  className="h-8 w-20 font-mono text-xs"
                />
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2">
          <span className="me-auto text-[11px] text-muted-foreground">
            {changes.length > 0 ? t('keys.rotationPending', { count: changes.length }) : t('keys.rotationNoChanges')}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={changes.length === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('common.save')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
