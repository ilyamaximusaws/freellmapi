import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * [fork 4/10] Windowed caps on a key: hour/day/week/month budgets in requests or
 * tokens, calendar (with timezone / custom billing day) or sliding reset, a soft
 * threshold that demotes, an optional model scope, and an account tag that makes
 * several keys share one budget.
 */

export interface KeyCapStatus {
  id: number;
  scope: 'key' | 'account' | 'model';
  accountKey: string | null;
  modelId: string | null;
  window: 'hour' | 'day' | 'week' | 'month';
  unit: 'requests' | 'tokens';
  cap: number;
  used: number;
  softPercent: number;
  softReached: boolean;
  hardReached: boolean;
  resetAt: number;
  resetType: 'calendar' | 'sliding';
  timezone: string;
  resetHour: number;
  resetDayOfMonth: number | null;
}

interface CapSummary {
  keyId: number;
  accountKey: string | null;
  caps: KeyCapStatus[];
}

const WINDOWS = ['hour', 'day', 'week', 'month'] as const;
const UNITS = ['requests', 'tokens'] as const;
const RESET_TYPES = ['calendar', 'sliding'] as const;

function formatReset(resetAt: number, resetType: string, t: (key: string) => string): string {
  if (resetType === 'sliding') return t('keys.capResetSliding');
  return new Date(resetAt).toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'short', hour12: false,
  });
}

/**
 * Collapsed by default, and its content (which fetches live usage) only mounts
 * once the operator opens it — the key dialog otherwise issues a request per
 * key row for data nobody is looking at.
 */
export function KeyCapsSection({ apiKey, onChanged }: {
  apiKey: { id: number; accountKey?: string | null; caps?: KeyCapStatus[] };
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(
    Boolean(apiKey.accountKey) || Boolean(apiKey.caps?.length),
  );
  return (
    <details
      className="group"
      open={opened}
      onToggle={event => setOpened((event.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
        {t('keys.capSectionTitle')}
      </summary>
      {opened ? <KeyCapsContent apiKey={apiKey} onChanged={onChanged} /> : null}
    </details>
  );
}

function KeyCapsContent({ apiKey, onChanged }: {
  apiKey: { id: number; accountKey?: string | null; caps?: KeyCapStatus[] };
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [accountKey, setAccountKey] = useState(apiKey.accountKey ?? '');
  const [draft, setDraft] = useState({
    window: 'day' as typeof WINDOWS[number],
    unit: 'requests' as typeof UNITS[number],
    cap: '',
    resetType: 'calendar' as typeof RESET_TYPES[number],
    timezone: 'UTC',
    resetHour: '0',
    softPercent: '80',
    modelId: '',
    accountKey: '',
  });

  const { data, isLoading } = useQuery<CapSummary>({
    queryKey: ['key-caps', apiKey.id],
    queryFn: () => apiFetch<CapSummary>(`/api/keys/${apiKey.id}/caps`),
    initialData: apiKey.caps
      ? { keyId: apiKey.id, accountKey: apiKey.accountKey ?? null, caps: apiKey.caps }
      : undefined,
  });

  useEffect(() => {
    setAccountKey(apiKey.accountKey ?? '');
  }, [apiKey.accountKey]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['key-caps', apiKey.id] });
    queryClient.invalidateQueries({ queryKey: ['keys'] });
    onChanged?.();
  };

  const saveAccount = useMutation({
    mutationFn: (value: string | null) =>
      apiFetch(`/api/keys/${apiKey.id}/account`, { method: 'PUT', body: JSON.stringify({ accountKey: value }) }),
    onSuccess: invalidate,
  });

  const addCap = useMutation({
    mutationFn: () => {
      const cap = Number(draft.cap);
      if (!Number.isInteger(cap) || cap <= 0) throw new Error(t('keys.capInvalidNumber'));
      return apiFetch(`/api/keys/${apiKey.id}/caps`, {
        method: 'POST',
        body: JSON.stringify({
          window: draft.window,
          unit: draft.unit,
          cap,
          resetType: draft.resetType,
          timezone: draft.timezone.trim() || 'UTC',
          resetHour: Number(draft.resetHour) || 0,
          softPercent: Number(draft.softPercent) || 80,
          modelId: draft.modelId.trim() || null,
          accountKey: draft.accountKey.trim() || null,
        }),
      });
    },
    onSuccess: () => {
      setDraft(current => ({ ...current, cap: '', modelId: '', accountKey: '' }));
      invalidate();
    },
  });

  const removeCap = useMutation({
    mutationFn: (capId: number) => apiFetch(`/api/keys/${apiKey.id}/caps/${capId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const caps = data?.caps ?? [];
  const accountDirty = accountKey !== (apiKey.accountKey ?? '');

  return (
    <div className="mt-2 space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="key-account-tag">{t('keys.capAccountLabel')}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="key-account-tag"
              value={accountKey}
              onChange={event => setAccountKey(event.target.value)}
              placeholder={t('keys.capAccountPlaceholder')}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!accountDirty || saveAccount.isPending}
              onClick={() => saveAccount.mutate(accountKey.trim() || null)}
            >
              {t('common.save')}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('keys.capAccountHint')}</p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t('common.loading')}
          </div>
        ) : caps.length > 0 ? (
          <ul className="space-y-2">
            {caps.map(cap => (
              <li key={cap.id} className="rounded-md border border-border/60 px-2.5 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {t(`keys.capWindow_${cap.window}`)} · {t(`keys.capUnit_${cap.unit}`)} · {cap.used.toLocaleString()}/{cap.cap.toLocaleString()}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-label={t('keys.capDelete')}
                    onClick={() => removeCap.mutate(cap.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {cap.scope !== 'key' && cap.modelId ? `${cap.modelId} · ` : ''}
                  {cap.scope === 'account' && cap.accountKey ? `${cap.accountKey} · ` : ''}
                  {t('keys.capResetAt', { time: formatReset(cap.resetAt, cap.resetType, t) })}
                  {' · '}{t('keys.capSoftAt', { percent: cap.softPercent })}
                  {cap.hardReached ? ` · ${t('keys.capHard')}` : cap.softReached ? ` · ${t('keys.capSoft')}` : ''}
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full ${cap.hardReached ? 'bg-destructive' : cap.softReached ? 'bg-amber-500' : 'bg-primary'}`}
                    style={{ width: `${Math.min(100, (cap.used / cap.cap) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">{t('keys.capNone')}</p>
        )}

        <div className="rounded-md border border-dashed border-border/70 p-2.5">
          <p className="mb-2 text-[11px] font-medium">{t('keys.capAddTitle')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-window">{t('keys.capWindowLabel')}</Label>
              <select
                id="cap-window"
                value={draft.window}
                onChange={event => setDraft(current => ({ ...current, window: event.target.value as typeof draft.window }))}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                {WINDOWS.map(window => <option key={window} value={window}>{t(`keys.capWindow_${window}`)}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-unit">{t('keys.capUnitLabel')}</Label>
              <select
                id="cap-unit"
                value={draft.unit}
                onChange={event => setDraft(current => ({ ...current, unit: event.target.value as typeof draft.unit }))}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                {UNITS.map(unit => <option key={unit} value={unit}>{t(`keys.capUnit_${unit}`)}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-limit">{t('keys.capLimitLabel')}</Label>
              <Input
                id="cap-limit"
                inputMode="numeric"
                value={draft.cap}
                onChange={event => setDraft(current => ({ ...current, cap: event.target.value }))}
                placeholder="1000"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-reset-type">{t('keys.capResetTypeLabel')}</Label>
              <select
                id="cap-reset-type"
                value={draft.resetType}
                onChange={event => setDraft(current => ({ ...current, resetType: event.target.value as typeof draft.resetType }))}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                {RESET_TYPES.map(resetType => <option key={resetType} value={resetType}>{t(`keys.capResetType_${resetType}`)}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-timezone">{t('keys.capTimezoneLabel')}</Label>
              <Input
                id="cap-timezone"
                value={draft.timezone}
                onChange={event => setDraft(current => ({ ...current, timezone: event.target.value }))}
                placeholder="UTC"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-reset-hour">{t('keys.capResetHourLabel')}</Label>
              <Input
                id="cap-reset-hour"
                inputMode="numeric"
                value={draft.resetHour}
                onChange={event => setDraft(current => ({ ...current, resetHour: event.target.value }))}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-soft">{t('keys.capSoftLabel')}</Label>
              <Input
                id="cap-soft"
                inputMode="numeric"
                value={draft.softPercent}
                onChange={event => setDraft(current => ({ ...current, softPercent: event.target.value }))}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-model">{t('keys.capModelLabel')}</Label>
              <Input
                id="cap-model"
                value={draft.modelId}
                onChange={event => setDraft(current => ({ ...current, modelId: event.target.value }))}
                placeholder={t('keys.capModelPlaceholder')}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]" htmlFor="cap-account">{t('keys.capAccountScopeLabel')}</Label>
              <Input
                id="cap-account"
                value={draft.accountKey}
                onChange={event => setDraft(current => ({ ...current, accountKey: event.target.value }))}
                placeholder={t('keys.capAccountPlaceholder')}
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            {addCap.isError && <p className="me-auto text-[11px] text-destructive">{addCap.error.message}</p>}
            <Button
              type="button"
              size="sm"
              disabled={!draft.cap.trim() || addCap.isPending}
              onClick={() => addCap.mutate()}
            >
              <Plus className="size-3.5" />
              {t('keys.capAdd')}
            </Button>
          </div>
        </div>
      </div>
  );
}
