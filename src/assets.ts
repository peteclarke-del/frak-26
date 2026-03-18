// ── Shared asset URLs ────────────────────────────────────────────────────────
// Bulk-imports built-in backgrounds, music, and SFX via import.meta.glob
// so every consumer gets the same resolved URLs without per-file imports.

/** Built-in level background image URLs, keyed 0-2. */
export const bgUrls = Object.values(
  import.meta.glob('./assets/background/*.png', { query: '?url', import: 'default', eager: true }) as Record<string, string>
)

/** VGZ chiptune music URLs. Index 0 = title, 1-3 = levels. */
export const vgzUrls = Object.values(
  import.meta.glob('./assets/music/*.vgz', { query: '?url', import: 'default', eager: true }) as Record<string, string>
)

/** MP3 remaster music URLs. Index 0 = title, 1-3 = levels. */
export const mp3Urls = Object.values(
  import.meta.glob('./assets/music/*.mp3', { query: '?url', import: 'default', eager: true }) as Record<string, string>
)

/** SFX URLs, keyed by base filename (without extension). */
const sfxGlob = import.meta.glob('./assets/sfx/*.mp3', { query: '?url', import: 'default', eager: true }) as Record<string, string>
export const sfxUrls: Record<string, string> = {}
for (const [path, url] of Object.entries(sfxGlob)) {
  const name = path.split('/').pop()!.replace(/\.[^.]+$/, '')
  sfxUrls[name] = url
}

/** Title screen background image URLs. */
export const titleBgUrls = Object.values(
  import.meta.glob('./assets/title/*.png', { query: '?url', import: 'default', eager: true }) as Record<string, string>
)

/** Sprite URLs, keyed by base filename (without extension). */
const spriteGlob = import.meta.glob('./assets/sprites/**/*.png', { query: '?url', import: 'default', eager: true }) as Record<string, string>
export const spriteUrls: Record<string, string> = {}
for (const [path, url] of Object.entries(spriteGlob)) {
  const name = path.split('/').pop()!.replace(/\.[^.]+$/, '')
  spriteUrls[name] = url
}
