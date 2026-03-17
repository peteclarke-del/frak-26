// ── Shared sprite asset globs ─────────────────────────────────────────────────
// Centralises the import.meta.glob calls so Vite bundles each glob only once,
// regardless of how many modules import the data.

/** Every sprite.json config, keyed by glob path. */
export const spriteConfigModules = import.meta.glob(
  './assets/sprites/**/sprite.json',
  { eager: true, import: 'default' },
) as Record<string, Record<string, unknown>>

/** Every sprite PNG URL, keyed by glob path. */
export const allSpritePngs = import.meta.glob(
  './assets/sprites/**/*.png',
  { eager: true, import: 'default' },
) as Record<string, string>
