import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { invalidateSearchQueries } from '@/lib/search'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { X } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { PLATFORMS } from './shared'
import { GroupLabelField } from './group-label-field'
import { capUsage } from './cap-usage'
import { KeyCapsSection } from './key-caps-section'
import { KeyCooldownSection } from './key-cooldown-section'
import { KeyPenaltySection } from './key-penalty-section'

type UpdateBody = {
  label?: string
  key?: string
  monthlyRequestCap?: number
  monthlyTokenCap?: number
  // Per-key in-flight cap ([fork 2/10]): 0 = unlimited, null = inherit.
  maxConcurrent?: number | null
  // Rotation share and group ([fork 6/10]).
  weight?: number
  order?: number
  // Per-key rate caps ([fork 7/10]): 0 = unlimited.
  rpm?: number
  tpm?: number
  rpd?: number
  rate?: import('../../../../shared/types').KeyRateSummary
  owner?: string | null
  consoleUrl?: string | null
  note?: string | null
  tags?: string[]
  keyType?: import('../../../../shared/types').KeyType | null
  creditsRemaining?: number | null
  expiresAt?: string | null
  expireReminderDays?: number
  groupLabel?: string
  proxyUrl?: string
}

/** Parse a budget-cap input: blank or 0 means unlimited (0); otherwise a
 *  non-negative integer. Anything else is invalid (null). */
function parseCap(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return 0
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) ? n : null
}

/** Format a cap for the input: 0 (unlimited) shows as empty. */
function capToInput(cap: number | undefined): string {
  return cap && cap > 0 ? String(cap) : ''
}

/** A slim progress bar for one cap: neutral normally, amber at the 80% soft
 *  alert, red at the cap itself (the state where the server 429s). Mirrors
 *  the budget-alert thresholds so the dialog and the Logs page never
 *  disagree about "how close is this key to running out". */
function CapUsageBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const { t } = useI18n()
  const usage = capUsage(used, cap)
  if (!usage) return null
  const pctShown = Math.floor(usage.fraction * 100)
  const tone = usage.fraction >= 1
    ? 'bg-destructive'
    : usage.overWarning
      ? 'bg-amber-500'
      : 'bg-primary/60'
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className={usage.overWarning ? 'font-medium text-foreground' : undefined}>
          {t('keys.capUsagePercent', { used: used.toLocaleString(), cap: cap.toLocaleString(), pct: pctShown })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={pctShown}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pctShown)}%` }} />
      </div>
      {usage.overWarning && (
        <p className={`text-[11px] ${usage.fraction >= 1 ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'}`}>
          {usage.fraction >= 1 ? t('keys.capExhaustedWarning') : t('keys.capWarning80')}
        </p>
      )}
    </div>
  )
}

/** Edit the mutable parts of a key without deleting its stable endpoint
 *  identity. Changing the credential itself is deliberately explicit: the
 *  field starts empty because the API never sends plaintext secrets back. */
export function EditKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [label, setLabel] = useState(apiKey.label)
  const [apiKeyValue, setApiKeyValue] = useState('')
  const [accountId, setAccountId] = useState('')
  const [attempted, setAttempted] = useState(false)
  // Custom-endpoint group label (#1176): '' = the single legacy Custom group.
  const [groupLabel, setGroupLabel] = useState(apiKey.groupLabel ?? '')
  const isCustom = apiKey.platform === 'custom'
  // Monthly budget caps (#1158): editable here so the cap is settable from
  // the dashboard at all; it shipped API-only. Empty = unlimited.
  const [requestCap, setRequestCap] = useState(capToInput(apiKey.monthlyRequestCap))
  const [tokenCap, setTokenCap] = useState(capToInput(apiKey.monthlyTokenCap))
  // Rotation weight/order ([fork 6/10]): '' means "leave unchanged".
  const [weight, setWeight] = useState(String(apiKey.weight ?? 1))
  const [order, setOrder] = useState(String(apiKey.order ?? 0))
  // Per-key rate caps ([fork 7/10]): blank = unlimited.
  const [rpm, setRpm] = useState(apiKey.rpm ? String(apiKey.rpm) : '')
  const [tpm, setTpm] = useState(apiKey.tpm ? String(apiKey.tpm) : '')
  const [rpd, setRpd] = useState(apiKey.rpd ? String(apiKey.rpd) : '')
  // Operator metadata ([fork 9/10]).
  const md = apiKey.metadata
  const [owner, setOwner] = useState(md?.owner ?? '')
  const [note, setNote] = useState(md?.note ?? '')
  const [keyType, setKeyType] = useState(md?.keyType ?? 'free')
  const [credits, setCredits] = useState(md?.creditsRemaining != null ? String(md.creditsRemaining) : '')
  const [expiresAt, setExpiresAt] = useState(md?.expiresAt ? md.expiresAt.slice(0, 10) : '')
  const [reminderDays, setReminderDays] = useState(String(md?.expireReminderDays ?? 3))
  const [tags, setTags] = useState((md?.tags ?? []).join(', '))
  // Per-key concurrency cap ([fork 2/10]): blank = inherit the provider/global
  // cap, 0 = unlimited, N = at most N requests in flight on this credential.
  const [maxConcurrentInput, setMaxConcurrentInput] = useState(
    apiKey.maxConcurrent == null ? '' : String(apiKey.maxConcurrent),
  )
  // Per-key proxy (#590, #1526): shipped API-only. Like the credential, the
  // field starts empty and the saved proxy shows masked beside it, so the
  // masked password can never be submitted back over the real one.
  const [proxyUrl, setProxyUrl] = useState('')
  const [clearProxy, setClearProxy] = useState(false)

  const needsAccountId = apiKey.platform === 'cloudflare'
  // Every row takes a credential, including the anonymous row of a
  // key-optional platform (Kilo, OVH, AI Horde): a real key replaces the
  // sentinel there (#1331).
  const provider = PLATFORMS.find(p => p.value === apiKey.platform)
  const credential = useMemo(() => {
    if (!apiKeyValue.trim()) return ''
    if (needsAccountId) return accountId.trim() ? `${accountId.trim()}:${apiKeyValue.trim()}` : ''
    return apiKeyValue.trim()
  }, [accountId, apiKeyValue, needsAccountId])

  const credentialError = needsAccountId &&
    (accountId.trim() ? !apiKeyValue.trim() : Boolean(apiKeyValue.trim()))
    ? t('keys.editCredentialPartsRequired')
    : null
  const requestCapValue = parseCap(requestCap)
  const tokenCapValue = parseCap(tokenCap)
  const capError = requestCapValue === null || tokenCapValue === null
  const requestCapChanged = requestCapValue !== (apiKey.monthlyRequestCap || 0)
  const tokenCapChanged = tokenCapValue !== (apiKey.monthlyTokenCap || 0)
  const maxConcurrentTrimmed = maxConcurrentInput.trim()
  const maxConcurrentValid = maxConcurrentTrimmed === '' || /^\d+$/.test(maxConcurrentTrimmed)
  const maxConcurrentValue = maxConcurrentTrimmed === ''
    ? null
    : maxConcurrentValid ? Number(maxConcurrentTrimmed) : null
  const maxConcurrentChanged = (apiKey.maxConcurrent ?? null) !== maxConcurrentValue
  const groupLabelChanged = isCustom && groupLabel.trim() !== (apiKey.groupLabel ?? '')
  const proxyChanged = Boolean(proxyUrl.trim()) || clearProxy
  // Rotation weight/group ([fork 6/10]). Both are non-negative integers.
  const weightTrimmed = weight.trim()
  const weightValid = /^\d+$/.test(weightTrimmed)
  const orderTrimmed = order.trim()
  const orderValid = /^-?\d+$/.test(orderTrimmed)
  const weightChanged = weightValid && Number(weightTrimmed) !== (apiKey.weight ?? 1)
  const orderChanged = orderValid && Number(orderTrimmed) !== (apiKey.order ?? 0)
  // Per-key rate caps ([fork 7/10]): all three are non-negative integers; blank
  // means unlimited. Parse consistently with the server's 0-clears semantics.
  const rpmTrimmed = rpm.trim()
  const tpmTrimmed = tpm.trim()
  const rpdTrimmed = rpd.trim()
  const rpmValue = rpmTrimmed === '' ? 0 : Number(rpmTrimmed)
  const tpmValue = tpmTrimmed === '' ? 0 : Number(tpmTrimmed)
  const rpdValue = rpdTrimmed === '' ? 0 : Number(rpdTrimmed)
  const rateValid = /^\d*$/.test(rpmTrimmed) && /^\d*$/.test(tpmTrimmed) && /^\d*$/.test(rpdTrimmed)
  const rpmChanged = rpmValue !== (apiKey.rpm ?? 0)
  const tpmChanged = tpmValue !== (apiKey.tpm ?? 0)
  const rpdChanged = rpdValue !== (apiKey.rpd ?? 0)
  // Operator metadata ([fork 9/10]): credits/reminder are optional non-negative
  // numbers; tags are a comma list. null in the body clears server-side.
  const creditsTrimmed = credits.trim()
  const creditsValid = creditsTrimmed === '' || /^\d*\.?\d+$/.test(creditsTrimmed)
  const reminderTrimmed = reminderDays.trim()
  const reminderValid = /^\d+$/.test(reminderTrimmed)
  const ownerValue = owner.trim()
  const noteValue = note.trim()
  const expiresValue = expiresAt.trim()
  const tagsValue = tags.trim()
  const ownerChanged = ownerValue !== (md?.owner ?? '')
  const noteChanged = noteValue !== (md?.note ?? '')
  const keyTypeChanged = keyType !== (md?.keyType ?? 'free')
  const creditsChanged = creditsValid && (creditsTrimmed === '' ? null : Number(creditsTrimmed)) !== (md?.creditsRemaining ?? null)
  const expiresChanged = expiresValue !== (md?.expiresAt ? md.expiresAt.slice(0, 10) : '')
  const reminderChanged = reminderValid && Number(reminderTrimmed) !== (md?.expireReminderDays ?? 3)
  const tagsChanged = tagsValue !== (md?.tags ?? []).join(', ')
  const metadataChanged = ownerChanged || noteChanged || keyTypeChanged || creditsChanged || expiresChanged || reminderChanged || tagsChanged
  const hasChanges = label !== apiKey.label || Boolean(credential) || requestCapChanged || tokenCapChanged || groupLabelChanged || proxyChanged || maxConcurrentChanged || weightChanged || orderChanged || rpmChanged || tpmChanged || rpdChanged || metadataChanged

  const updateKey = useMutation({
    mutationFn: (body: UpdateBody) =>
      apiFetch(`/api/keys/${apiKey.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      for (const key of ['keys', 'health']) queryClient.invalidateQueries({ queryKey: [key] })
      invalidateSearchQueries(queryClient)
      onOpenChange(false)
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (credentialError || capError || !maxConcurrentValid || !weightValid || !orderValid || !rateValid || !creditsValid || !reminderValid) {
      setAttempted(true)
      return
    }

    const body: UpdateBody = {}
    if (label !== apiKey.label) body.label = label
    if (credential) body.key = credential
    if (requestCapChanged && requestCapValue !== null) body.monthlyRequestCap = requestCapValue
    if (tokenCapChanged && tokenCapValue !== null) body.monthlyTokenCap = tokenCapValue
    if (maxConcurrentChanged && maxConcurrentValid) body.maxConcurrent = maxConcurrentValue
    if (weightChanged) body.weight = Number(weightTrimmed)
    if (orderChanged) body.order = Number(orderTrimmed)
    if (rpmChanged) body.rpm = rpmValue
    if (tpmChanged) body.tpm = tpmValue
    if (rpdChanged) body.rpd = rpdValue
    // Operator metadata ([fork 9/10]): always send the current value, '' = null.
    if (ownerChanged) body.owner = ownerValue || null
    if (noteChanged) body.note = noteValue || null
    if (keyTypeChanged) body.keyType = keyType
    if (creditsChanged) body.creditsRemaining = creditsTrimmed === '' ? null : Number(creditsTrimmed)
    if (expiresChanged) body.expiresAt = expiresValue || null
    if (reminderChanged) body.expireReminderDays = Number(reminderTrimmed)
    if (tagsChanged) body.tags = tagsValue ? tagsValue.split(',').map(t => t.trim()).filter(Boolean) : []
    if (groupLabelChanged) body.groupLabel = groupLabel.trim()
    // '' clears the override; a typed URL replaces it (and wins over Remove).
    if (proxyChanged) body.proxyUrl = proxyUrl.trim()
    if (Object.keys(body).length > 0) updateKey.mutate(body)
    else onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-lg">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.editKey')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('keys.platform')}</Label>
              <Input value={provider?.label ?? apiKey.platform} readOnly className="bg-muted/30" />
              <p className="text-[11px] text-muted-foreground">{t('keys.editPlatformLocked')}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="edit-key-label">{t('keys.label')}</Label>
              <Input
                id="edit-key-label"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder={t('keys.customDisplayNameOptional')}
              />
            </div>
          </div>

          {apiKey.baseUrl && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('keys.customBaseUrl')}</Label>
              <Input value={apiKey.baseUrl} readOnly className="bg-muted/30 font-mono text-xs" />
            </div>
          )}

          {isCustom && <GroupLabelField value={groupLabel} onChange={setGroupLabel} />}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs" htmlFor="edit-key-value">
                {needsAccountId ? t('keys.apiToken') : t('keys.customApiKey')}
              </Label>
              {!apiKey.keyless && (
                <code className="font-mono text-[11px] text-muted-foreground">{apiKey.maskedKey}</code>
              )}
            </div>
            {needsAccountId && (
              <Input
                value={accountId}
                onChange={e => setAccountId(e.target.value)}
                placeholder={t('keys.accountId')}
                className="font-mono text-xs"
                aria-invalid={attempted && Boolean(credentialError)}
              />
            )}
            <Input
              id="edit-key-value"
              type="password"
              autoComplete="new-password"
              value={apiKeyValue}
              onChange={e => setApiKeyValue(e.target.value)}
              placeholder={apiKey.keyless ? t('keys.keyOptionalPlaceholder') : (needsAccountId ? t('keys.bearerTokenPlaceholder') : t('keys.pasteKeyPlaceholder'))}
              className="font-mono text-xs"
              aria-invalid={attempted && Boolean(credentialError)}
            />
            {attempted && <FieldError error={credentialError} />}
            <p className="text-[11px] text-muted-foreground">
              {apiKey.keyless ? t('keys.keyOptionalHint') : t('keys.editCredentialHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs" htmlFor="edit-key-proxy">{t('keys.keyProxyLabel')}</Label>
              {apiKey.maskedProxyUrl && (
                <div className="flex min-w-0 items-center gap-2">
                  <code className={`truncate font-mono text-[11px] text-muted-foreground${clearProxy ? ' line-through' : ''}`}>
                    {apiKey.maskedProxyUrl}
                  </code>
                  <button
                    type="button"
                    onClick={() => setClearProxy(c => !c)}
                    className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {clearProxy ? t('keys.keyProxyUndo') : t('common.remove')}
                  </button>
                </div>
              )}
            </div>
            <Input
              id="edit-key-proxy"
              autoComplete="off"
              spellCheck={false}
              value={proxyUrl}
              onChange={e => setProxyUrl(e.target.value)}
              placeholder="socks5://user:pass@host:1080"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              {clearProxy && !proxyUrl.trim() ? t('keys.keyProxyRemoved') : t('keys.keyProxyHint')}
            </p>
          </div>

          {/* Monthly budget (#1158) stays one collapsed line; it opens by
              default only when a cap is already set, so a cap is never hidden. */}
          <details className="group" open={Boolean(apiKey.monthlyRequestCap || apiKey.monthlyTokenCap) || undefined}>
            <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
              {apiKey.monthlyUsage
                ? t('keys.monthlyUsageLine', {
                    requests: apiKey.monthlyUsage.requests.toLocaleString(),
                    tokens: apiKey.monthlyUsage.tokens.toLocaleString(),
                  })
                : t('keys.monthlyRequestCapLabel')}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="edit-key-request-cap">{t('keys.monthlyRequestCapLabel')}</Label>
                <Input
                  id="edit-key-request-cap"
                  inputMode="numeric"
                  value={requestCap}
                  onChange={e => setRequestCap(e.target.value)}
                  placeholder={t('keys.capUnlimitedPlaceholder')}
                  className="font-mono text-xs"
                  aria-invalid={attempted && requestCapValue === null}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="edit-key-token-cap">{t('keys.monthlyTokenCapLabel')}</Label>
                <Input
                  id="edit-key-token-cap"
                  inputMode="numeric"
                  value={tokenCap}
                  onChange={e => setTokenCap(e.target.value)}
                  placeholder={t('keys.capUnlimitedPlaceholder')}
                  className="font-mono text-xs"
                  aria-invalid={attempted && tokenCapValue === null}
                />
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t('keys.capEditHint')}</p>
            {apiKey.monthlyUsage && (apiKey.monthlyRequestCap || apiKey.monthlyTokenCap) ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <CapUsageBar
                  label={t('keys.monthlyRequestCapLabel')}
                  used={apiKey.monthlyUsage.requests}
                  cap={apiKey.monthlyRequestCap ?? 0}
                />
                <CapUsageBar
                  label={t('keys.monthlyTokenCapLabel')}
                  used={apiKey.monthlyUsage.tokens}
                  cap={apiKey.monthlyTokenCap ?? 0}
                />
              </div>
            ) : null}
          </details>

          {/* Windowed caps [fork 4/10]: hour/day/week/month budgets in requests
              or tokens, calendar (with timezone) or sliding reset, soft threshold,
              per-model scope, and an account tag for a shared budget. */}
          <KeyCapsSection apiKey={apiKey} />

          <KeyCooldownSection apiKey={apiKey} />

          <KeyPenaltySection apiKey={apiKey} />

          {/* Per-key concurrency ([fork 2/10]): how many requests may be in
              flight against this credential at once. */}
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="edit-key-max-concurrent">{t('keys.keyConcurrencyLabel')}</Label>
            <Input
              id="edit-key-max-concurrent"
              inputMode="numeric"
              value={maxConcurrentInput}
              onChange={e => setMaxConcurrentInput(e.target.value)}
              placeholder={apiKey.effectiveMaxConcurrent != null ? String(apiKey.effectiveMaxConcurrent) : t('keys.capUnlimitedPlaceholder')}
              className="font-mono text-xs"
              aria-invalid={attempted && !maxConcurrentValid}
            />
            <p className="text-[11px] text-muted-foreground">{t('keys.keyConcurrencyHint')}</p>
          </div>

          {/* Rotation weight and group ([fork 6/10]): the share this key takes
              inside its group, and the group itself. Applied on the next
              routing decision, so saving is enough. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="edit-key-weight">{t('keys.weightLabel')}</Label>
              <Input
                id="edit-key-weight"
                inputMode="numeric"
                value={weight}
                onChange={e => setWeight(e.target.value)}
                aria-invalid={attempted && !weightValid}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="edit-key-order">{t('keys.orderLabel')}</Label>
              <Input
                id="edit-key-order"
                inputMode="numeric"
                value={order}
                onChange={e => setOrder(e.target.value)}
                aria-invalid={attempted && !orderValid}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('keys.rotationHint')}</p>

          {/* Per-key rate caps ([fork 7/10]): the key's own rpm/tpm/rpd, counted
              on a sliding window and checked before the request. Blank = unlimited. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="edit-key-rpm">{t('keys.rpmLabel')}</Label>
              <Input id="edit-key-rpm" inputMode="numeric" value={rpm} onChange={e => setRpm(e.target.value)}
                placeholder={t('keys.capUnlimitedPlaceholder')} aria-invalid={attempted && !rateValid} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="edit-key-tpm">{t('keys.tpmLabel')}</Label>
              <Input id="edit-key-tpm" inputMode="numeric" value={tpm} onChange={e => setTpm(e.target.value)}
                placeholder={t('keys.capUnlimitedPlaceholder')} aria-invalid={attempted && !rateValid} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="edit-key-rpd">{t('keys.rpdLabel')}</Label>
              <Input id="edit-key-rpd" inputMode="numeric" value={rpd} onChange={e => setRpd(e.target.value)}
                placeholder={t('keys.capUnlimitedPlaceholder')} aria-invalid={attempted && !rateValid} className="font-mono text-xs" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('keys.rateHint')}</p>
          {apiKey.rate && (apiKey.rate.provider?.requestsRemaining != null || apiKey.rate.provider?.tokensRemaining != null) && (
            <p className="text-[11px] text-amber-600 dark:text-amber-500">
              {t('keys.providerRateLine', {
                requests: apiKey.rate.provider.requestsRemaining ?? '?',
                tokens: apiKey.rate.provider.tokensRemaining ?? '?',
              })}
            </p>
          )}

          {/* Operator metadata ([fork 9/10]): owner, budget kind, expiry and
              tags. Collapsed unless something is already set. */}
          <details className="group" open={Boolean(md?.owner || md?.note || md?.expiresAt || (md?.tags?.length ?? 0) > 0) || undefined}>
            <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
              {t('keys.metadataTitle')}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="edit-key-owner">{t('keys.metadataOwner')}</Label>
                <Input id="edit-key-owner" value={owner} onChange={e => setOwner(e.target.value)} placeholder="owner@example.com" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="edit-key-type">{t('keys.metadataType')}</Label>
                <select
                  id="edit-key-type"
                  value={keyType}
                  onChange={e => setKeyType(e.target.value as 'free' | 'credits' | 'paid')}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="free">{t('keys.metadataTypeFree')}</option>
                  <option value="credits">{t('keys.metadataTypeCredits')}</option>
                  <option value="paid">{t('keys.metadataTypePaid')}</option>
                </select>
              </div>
              {keyType === 'credits' && (
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="edit-key-credits">{t('keys.metadataCredits')}</Label>
                  <Input id="edit-key-credits" inputMode="decimal" value={credits} onChange={e => setCredits(e.target.value)} placeholder="12.50" className="font-mono text-xs" />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="edit-key-expires">{t('keys.metadataExpires')}</Label>
                <Input id="edit-key-expires" type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="edit-key-reminder">{t('keys.metadataReminder')}</Label>
                <Input id="edit-key-reminder" inputMode="numeric" value={reminderDays} onChange={e => setReminderDays(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs" htmlFor="edit-key-tags">{t('keys.metadataTags')}</Label>
                <Input id="edit-key-tags" value={tags} onChange={e => setTags(e.target.value)} placeholder="trial, west, low-priority" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs" htmlFor="edit-key-note">{t('keys.metadataNote')}</Label>
                <Input id="edit-key-note" value={note} onChange={e => setNote(e.target.value)} placeholder={t('keys.metadataNotePlaceholder')} />
              </div>
            </div>
          </details>

          {updateKey.isError && (
            <p className="text-xs text-destructive">{(updateKey.error as Error).message}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!hasChanges || updateKey.isPending}>
              {updateKey.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
