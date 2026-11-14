/**
 * Recurring action-needed flags [fork 5/10].
 *
 * A cleared flag with a recurrence (the daily claim) has to come back on its own
 * schedule; nothing else in the process knows when that is. The tick is short
 * because the check is one indexed read on a table that is empty on most
 * installs, and because a "daily bonus at 00:00" should be raised within a
 * minute of the reset, not whenever the next 5-minute health pass happens to
 * run.
 */
import type { Scheduler } from '../lib/scheduler.js';
import { raiseDueActions } from './action-needed.js';

export const ACTION_TICK_MS = 60 * 1000;

let cancelTick: (() => void) | null = null;

export function startActionScheduler(scheduler: Scheduler, intervalMs = ACTION_TICK_MS): void {
  if (cancelTick) return;
  cancelTick = scheduler.every(intervalMs, () => {
    try {
      const raised = raiseDueActions();
      if (raised.length > 0) {
        console.log(`[action] re-raised ${raised.length} recurring action flag(s) for keys ${raised.join(', ')}`);
      }
    } catch (err) {
      console.error('[action] recurring tick failed:', err);
    }
  }, { name: 'action-needed' });
}

export function stopActionScheduler(): void {
  cancelTick?.();
  cancelTick = null;
}
