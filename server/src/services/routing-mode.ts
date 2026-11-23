// ── Custom routing mode ─────────────────────────────────────────────────────
//
// "Custom routing" is the named-chain feature: the router reads one chain from
// `profile_models` instead of the built-in global table in `fallback_config`,
// and the dashboard grows a Custom routing page. It is a mode, not a strategy —
// a strategy ranks models inside whichever chain is in use.
//
// Off means off: the active chain pointer is cleared, so every routing path in
// services/router.ts falls back to the global table exactly as it did before
// chains existed. The last chain the operator used is remembered so switching
// back does not silently land them on the wrong chain.
import { getDb, getSetting, setSetting } from '../db/index.js';
import { getActiveProfileId } from './profile-models.js';

const MODE_KEY = 'custom_routing_enabled';
const LAST_PROFILE_KEY = 'custom_routing_last_profile_id';

/**
 * Whether named chains are in use. Unset means "whatever the install already
 * does": an install with an active chain keeps using it, a fresh one does not
 * get a sidebar entry it never asked for.
 */
export function isCustomRoutingEnabled(): boolean {
  const raw = getSetting(MODE_KEY);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return getActiveProfileId(getDb()) !== null;
}

function setActiveProfileId(profileId: number | null): void {
  const db = getDb();
  if (profileId === null) {
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    return;
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(profileId));
}

/**
 * Turn the mode on or off. Turning it on restores the chain used last (or the
 * built-in Default chain on an install that never had one), so the operator
 * lands somewhere valid instead of on "no chain at all".
 */
export function setCustomRoutingEnabled(enabled: boolean): { enabled: boolean; activeProfileId: number | null } {
  const db = getDb();

  if (enabled) {
    setSetting(MODE_KEY, '1');
    let active = getActiveProfileId(db);
    if (active === null) {
      const remembered = Number.parseInt(getSetting(LAST_PROFILE_KEY) ?? '', 10);
      const rememberedExists = Number.isInteger(remembered)
        && db.prepare('SELECT id FROM profiles WHERE id = ?').get(remembered) !== undefined;
      const fallbackProfile = rememberedExists
        ? remembered
        : (db.prepare("SELECT id FROM profiles WHERE type = 'default' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
      if (fallbackProfile !== null) setActiveProfileId(fallbackProfile);
      active = fallbackProfile;
    }
    return { enabled: true, activeProfileId: active };
  }

  const active = getActiveProfileId(db);
  if (active !== null) setSetting(LAST_PROFILE_KEY, String(active));
  setActiveProfileId(null);
  setSetting(MODE_KEY, '0');
  return { enabled: false, activeProfileId: null };
}

/**
 * Keep the mode and the active-chain pointer from disagreeing: activating a
 * chain means the feature is in use, and clearing it means it is not.
 */
export function syncModeWithActiveProfile(profileId: number | null): void {
  setSetting(MODE_KEY, profileId === null ? '0' : '1');
}
