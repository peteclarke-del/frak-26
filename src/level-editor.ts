// ── Level Editor ──────────────────────────────────────────────────────────────
// Self-contained 2D canvas level editor.
// Communicates with main.ts via onDryRun / onClose callbacks.

import JSZip from 'jszip'
import { allSpritePngs, spriteConfigModules as spriteConfigGlob } from './sprite-data'
import { bgUrls, mp3Urls } from './assets'

const builtinBgUrls: Record<number, string> = Object.fromEntries(bgUrls.map((u, i) => [i, u]))
const builtinMp3Urls: Record<number, string> = Object.fromEntries(mp3Urls.map((u, i) => [i, u]))

// Bundled built-in levels (assets first, then public/ overlays at runtime)
const builtinLevelModules = import.meta.glob(
  './assets/levels/*.json',
  { eager: true, import: 'default' },
) as Record<string, LevelFile>
const builtinLevelKeys = Object.keys(builtinLevelModules).sort()
const builtinLevels: LevelFile[] = builtinLevelKeys.map(k => builtinLevelModules[k])

export interface LevelFile {
  id: string
  name: string
  musicTrack: number       // index into music list (0=title, 1-3=levels)
  backgroundIndex: number  // 0-2 for existing backgrounds, -1 for teal
  playerStart: [number, number]
  playerStarts?: [number, number][]
  platforms: [number, number, number, number][]
  ladders: [number, number, number, number][]
  monsters: [number, number, number, number][]
  keys: [number, number, number, number][]
  bulbs: [number, number, number, number][]
  treasures: [number, number, number, number][]
  hooters?: [number, number, number, number][]
  poglets?: [number, number, number, number][]
  chains?: [number, number, number, number][]
  chain_clamps?: [number, number, number, number][]
  girders?: [number, number, number, number][]
  exit: [number, number, number, number] | null
  customElements?: { kind: string; x: number; y: number; w: number; h: number; attrs?: Record<string, unknown> }[]
  /** Maps editor element kinds to sprite paths, tiling, and gameplay behavior.
   *  The game engine reads this to decide rendering AND interaction logic. */
  spriteMap?: Record<string, SpriteMapEntry>
  /** Optional time limit in seconds — defaults to 120 if omitted. */
  timeLimit?: number
  /** Optional explicit world bounds — overrides auto-computed bounds in both
   *  the editor and the game engine. Set by dragging the world border edges. */
  worldBounds?: { left: number; right: number; bottom: number; top: number }
  /** Hazard kinds that are disabled for this level (won't auto-spawn). */
  disabledHazards?: string[]
  /** Filename of custom background image in public/background/ (used when backgroundIndex >= 100). */
  customBg?: string
  /** Background colour hex string (used when backgroundIndex === -1). Defaults to #00d8d8. */
  bgColor?: string
  /** Filename of custom music file in public/music/ (used when musicTrack >= 100). */
  customMusic?: string
}

/** A single entry in the level's spriteMap — tells the engine everything about
 *  how to render and interact with elements of this kind. */
export type { AnimMode }

export interface SpriteMapEntry {
  sprite: string            // path relative to assets/sprites/
  tiling?: 'h' | 'v'       // 'h'=tile horizontally, 'v'=tile vertically
  animMode?: AnimMode       // 'loop' (default), 'pingpong', or 'once'
  spriteScale?: number      // visual scale multiplier (default 1.0)
  fps?: number              // animation frame rate (from sprite.json)
  behavior: {
    solid?: boolean         // blocks player movement (platforms)
    climbable?: boolean     // can be climbed (ladders, ropes, chains)
    collectible?: 'mandatory' | 'optional'  // mandatory = must collect all to complete level
    scoreValue?: number     // points awarded on collect or kill
    hud?: boolean           // show progress in HUD (e.g. Keys: 2/5)
    hudLabel?: string       // HUD display label (e.g. "Keys")
    enemy?: boolean         // kills player on touch, can be knocked by yoyo
    enemyScore?: number     // points awarded for knocking enemy
    exit?: boolean          // level exit zone
    hazard?: boolean        // damages player on touch (auto-spawned projectile)
    hazardMovement?: 'rise' | 'fall'  // 'rise'=floats upward, 'fall'=drops from above
    hazardAnimated?: boolean           // true=cycle through frames, false=static
    hazardAnimFps?: number             // animation frame rate (only if hazardAnimated)
    autoSpawn?: {           // auto-spawn config (only for hazards)
      direction: 'down' | 'up' | 'diagonal-left' | 'diagonal-right'
      interval?: number     // seconds between spawns (default engine decides)
      speed?: number        // movement speed multiplier (default 1)
    }
    obstacle?: boolean       // static obstacle placed in level
    obstacleBlocking?: boolean  // true=blocks movement, false=dangerous (kills player)
  }
}

type Mode = 'select' | 'erase'
type ElementKind = string

interface EdElement {
  kind: ElementKind
  x: number
  y: number
  w: number
  h: number
  attrs?: Record<string, unknown>  // per-element attribute overrides
}

const DEFAULT_WORLD = { left: 0, right: 52, bottom: -2, top: 28 }
const SNAP = 0.125

// Gameplay roles — the game engine uses these to route elements into the right
// collision/logic lists.  Element kinds that share a role behave identically in
// gameplay but can look different (earth vs log, ladder vs rope).
type ElementRole = 'platform' | 'ladder' | 'monster' | 'item' | 'exit' | 'spawn' | 'hazard' | 'obstacle'

/** Attribute field definitions — describes what's editable for each element kind.
 *  key = attribute path used in EdElement.attrs (flat, e.g. 'direction', 'interval'). */
type AttrDef =
  | { type: 'select'; label: string; options: { value: string; label: string }[]; defaultValue: string }
  | { type: 'number'; label: string; min?: number; max?: number; step?: number; defaultValue: number }
  | { type: 'boolean'; label: string; defaultValue: boolean }

// ── Data-driven sprite configuration ──────────────────────────────────────────
// Each sprite action directory contains a sprite.json that defines everything
// the editor and engine need: kind, role, group, behavior, editable attrs, etc.
// This replaces the former hardcoded DEFAULT_SPRITE_MAP, EDITABLE_ATTRS,
// ELEMENT_ROLE, PALETTE_GROUPS, DEFAULT_SIZE, and KIND_COLOR constants.

/** Sprite metadata from sprite.json — animation/visual data for the engine. */
export interface SpriteMetadata {
  visual_w?: number
  visual_h?: number
  fps?: number
}

interface SpriteConfig {
  kind: string
  role?: ElementRole         // editor-relevant sprite configs have role
  group?: string
  action?: string            // e.g. 'walk', 'climb' — for animation-only configs
  tiling?: 'h' | 'v'
  animMode?: AnimMode
  spriteScale?: number
  fps?: number
  visual_w?: number
  visual_h?: number
  frameCount?: number
  behavior?: SpriteMapEntry['behavior']
  editableAttrs?: AttrDef[]
  defaultSize?: [number, number]
  color?: { fill: string; stroke: string; label: string; icon: string }
}

const spriteConfigModules = spriteConfigGlob as unknown as Record<string, SpriteConfig>

// Build all data maps from sprite.json files
const ELEMENT_ROLE: Record<string, ElementRole> = { exit: 'exit' }
const EDITABLE_ATTRS: Record<string, AttrDef[]> = {}
export const DEFAULT_SPRITE_MAP: Record<string, SpriteMapEntry> = {
  exit: { sprite: '', behavior: { exit: true } },
}
export const DEFAULT_SIZE: Record<string, [number, number]> = { exit: [1.2, 2.5] }
const KIND_COLOR: Record<string, { fill: string; stroke: string; label: string; icon: string }> = {
  exit: { fill: '#0a3820', stroke: '#60ff90', label: 'Exit', icon: '🚪' },
}

// Sprite metadata registry — maps sprite path → { visual_w, visual_h, fps }
// Populated from ALL sprite.json files, including animation-only ones.
export const SPRITE_METADATA = new Map<string, SpriteMetadata>()

const _groupMap = new Map<string, ElementKind[]>()
_groupMap.set('Obstacles', [])  // always present, filled by custom uploads

for (const [jsonPath, cfg] of Object.entries(spriteConfigModules)) {
  const spritePath = jsonPath.replace('./assets/sprites/', '').replace('/sprite.json', '')

  // Register metadata for ALL sprite.json files (animation-only or editor-relevant)
  const meta: SpriteMetadata = {}
  if (cfg.visual_w !== undefined) meta.visual_w = cfg.visual_w
  if (cfg.visual_h !== undefined) meta.visual_h = cfg.visual_h
  if (cfg.fps !== undefined) meta.fps = cfg.fps
  SPRITE_METADATA.set(spritePath, meta)

  // Only process editor-relevant sprites (those with role + group + behavior + defaultSize + color)
  if (!cfg.role || !cfg.group || !cfg.behavior || !cfg.defaultSize || !cfg.color) continue

  const kind = cfg.kind
  ELEMENT_ROLE[kind] = cfg.role

  const entry: SpriteMapEntry = { sprite: spritePath, behavior: cfg.behavior }
  if (cfg.tiling) entry.tiling = cfg.tiling
  if (cfg.animMode) entry.animMode = cfg.animMode
  if (cfg.spriteScale !== undefined) entry.spriteScale = cfg.spriteScale
  if (cfg.fps !== undefined) entry.fps = cfg.fps
  DEFAULT_SPRITE_MAP[kind] = entry

  if (cfg.editableAttrs?.length) EDITABLE_ATTRS[kind] = cfg.editableAttrs
  DEFAULT_SIZE[kind] = cfg.defaultSize
  KIND_COLOR[kind] = cfg.color

  // Group for palette (Hazards are managed via the RH panel, not the palette)
  if (cfg.group !== 'Hazards') {
    if (!_groupMap.has(cfg.group)) _groupMap.set(cfg.group, [])
    _groupMap.get(cfg.group)!.push(kind)
  }
}

// Add 'exit' to Items group
const _items = _groupMap.get('Items') || []
if (!_items.includes('exit')) _items.push('exit')
_groupMap.set('Items', _items)

// Build PALETTE_GROUPS in a stable order, with kinds sorted alphabetically
const _GROUP_ORDER = ['Terrain', 'Characters', 'Items', 'Obstacles']
const PALETTE_GROUPS: { head: string; kinds: ElementKind[] }[] = []
for (const head of _GROUP_ORDER) {
  if (_groupMap.has(head)) {
    PALETTE_GROUPS.push({ head, kinds: _groupMap.get(head)!.sort() })
  }
}
for (const [head, kinds] of _groupMap) {
  if (!_GROUP_ORDER.includes(head)) PALETTE_GROUPS.push({ head, kinds: kinds.sort() })
}

// Helper: is a kind resizable (platform or ladder)?
const isResizable = (kind: string): boolean => {
  const r = ELEMENT_ROLE[kind]
  // Built-in platforms/ladders are always resizable; custom sprites are too.
  return r === 'platform' || r === 'ladder' || !r
}

// Helper: does this kind tile horizontally?
const tilesH = (kind: string): boolean => {
  const entry = DEFAULT_SPRITE_MAP[kind]
  return entry?.tiling === 'h'
}
// Helper: does this kind tile vertically?
const tilesV = (kind: string): boolean => {
  const entry = DEFAULT_SPRITE_MAP[kind]
  return entry?.tiling === 'v'
}

const LS_KEY = 'frak_custom_levels'

// Map sprite paths → first-frame thumbnail URL, built dynamically from the PNG glob.
// For each sprite directory, pick the first PNG (sorted) as the representative thumbnail.
const SPRITE_THUMBNAIL: Record<string, string> = {}
{
  const PREFIX = './assets/sprites/'
  const byDir = new Map<string, { name: string; url: string }[]>()
  for (const [pngPath, url] of Object.entries(allSpritePngs)) {
    if (!pngPath.startsWith(PREFIX)) continue
    const rel = pngPath.slice(PREFIX.length)        // e.g. "enemies/hooter/idle/000.png"
    const lastSlash = rel.lastIndexOf('/')
    if (lastSlash < 0) continue
    const dir = rel.slice(0, lastSlash)              // e.g. "enemies/hooter/idle"
    const name = rel.slice(lastSlash + 1)            // e.g. "000.png"
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir)!.push({ name, url })
  }
  for (const [dir, files] of byDir) {
    files.sort((a, b) => a.name.localeCompare(b.name))
    SPRITE_THUMBNAIL[dir] = files[0].url
  }
}

// Build ED_SPRITE_URL by resolving each kind's sprite path to a thumbnail
const ED_SPRITE_URL: Partial<Record<string, string>> = {}
for (const [kind, entry] of Object.entries(DEFAULT_SPRITE_MAP)) {
  const url = SPRITE_THUMBNAIL[entry.sprite]
  if (url) ED_SPRITE_URL[kind] = url
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const snapV = (v: number) => Math.round(v / SNAP) * SNAP

const loadCustomLevels = (): LevelFile[] => {
  try {
    const s = localStorage.getItem(LS_KEY)
    if (!s) return []
    const arr = JSON.parse(s)
    if (!Array.isArray(arr)) return []
    return arr as LevelFile[]
  } catch (e) {
    console.warn('[level-editor] Failed to load custom levels:', e)
    return []
  }
}

const saveCustomLevels = (levels: LevelFile[]) => {
  localStorage.setItem(LS_KEY, JSON.stringify(levels))
}

// ── Custom imported sprites ───────────────────────────────────────────────────
import { loadCustomSprites, saveCustomSprites as saveCustomSpritesToStorage } from './custom-sprites'
import type { AnimMode, CustomSprite } from './custom-sprites'

const levelToElements = (lf: LevelFile): EdElement[] => {
  const out: EdElement[] = []
  // Use spriteMap to determine the editor kind for platforms & ladders.
  // Falls back to 'earth' / 'ladder' for legacy files without spriteMap.
  const sm = lf.spriteMap ?? {}
  // platformKind covers only non-girder platforms; girders are stored separately
  const platformKind = Object.keys(sm).find(k => ELEMENT_ROLE[k] === 'platform' && k !== 'girder') ?? 'earth'
  // ladderKind covers only non-chain climbables; chains/chain_clamps are stored separately
  const ladderKind   = Object.keys(sm).find(k => ELEMENT_ROLE[k] === 'ladder' && k !== 'chain' && k !== 'chain_clamp') ?? 'ladder'
  lf.platforms.forEach(([x, y, w, h]) => out.push({ kind: platformKind, x, y, w, h }))
  lf.girders?.forEach(([x, y, w, h]) => out.push({ kind: 'girder', x, y, w, h }))
  lf.ladders.forEach(([x, y, w, h]) => out.push({ kind: ladderKind, x, y, w, h }))
  lf.chains?.forEach(([x, y, w, h]) => out.push({ kind: 'chain', x, y, w, h }))
  lf.chain_clamps?.forEach(([x, y, w, h]) => out.push({ kind: 'chain_clamp', x, y, w, h }))
  lf.monsters.forEach(([x, y, w, h]) => out.push({ kind: 'monster', x, y, w, h }))
  lf.keys.forEach(([x, y, w, h]) => out.push({ kind: 'key', x, y, w, h }))
  lf.bulbs.forEach(([x, y, w, h]) => out.push({ kind: 'bulb', x, y, w, h }))
  lf.treasures.forEach(([x, y, w, h]) => out.push({ kind: 'diamond', x, y, w, h }))
  lf.hooters?.forEach(([x, y, w, h]) => out.push({ kind: 'hooter', x, y, w, h }))
  lf.poglets?.forEach(([x, y, w, h]) => out.push({ kind: 'poglet', x, y, w, h }))
  if (lf.exit) out.push({ kind: 'exit', x: lf.exit[0], y: lf.exit[1], w: lf.exit[2], h: lf.exit[3] })
  // Load all player start positions (support both old single and new multi)
  const starts: [number, number][] = lf.playerStarts && lf.playerStarts.length > 0
    ? lf.playerStarts
    : [lf.playerStart]
  const [pw, ph] = DEFAULT_SIZE.player
  starts.forEach(([px, py]) => out.push({ kind: 'player', x: px - pw / 2, y: py - ph / 2, w: pw, h: ph }))
  lf.customElements?.forEach(({ kind, x, y, w, h, attrs }) => out.push({ kind, x, y, w, h, attrs }))
  // Hydrate kind-level attrs from spriteMap behavior for elements with editable attributes
  for (const el of out) {
    const defs = EDITABLE_ATTRS[el.kind]
    if (!defs || el.attrs) continue  // skip if no editable attrs or already has attrs (customElements)
    const entry = sm[el.kind]
    if (!entry) continue
    const b = entry.behavior
    const attrs: Record<string, unknown> = {}
    for (const def of defs) {
      const key = def.label.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/_$/, '')
      if (key === 'score' && b.enemyScore !== undefined) attrs[key] = b.enemyScore
      else if (key === 'score' && b.scoreValue !== undefined) attrs[key] = b.scoreValue
      else if (key === 'show_in_hud' && b.hud !== undefined) attrs[key] = b.hud
      else if (key === 'sprite_scale' && entry.spriteScale !== undefined) attrs[key] = entry.spriteScale
    }
    if (Object.keys(attrs).length > 0) el.attrs = attrs
  }
  return out
}

const elementsToLevel = (meta: LevelFile, elements: EdElement[], customSprites: CustomSprite[] = []): LevelFile => {
  const out: LevelFile = {
    ...meta,
    platforms: [],
    ladders: [],
    monsters: [],
    keys: [],
    bulbs: [],
    treasures: [],
    hooters: [],
    poglets: [],
    chains: [],
    chain_clamps: [],
    girders: [],
    exit: null,
    customElements: [],
  }
  let playerStart: [number, number] = meta.playerStart
  const playerStarts: [number, number][] = []
  // Build a lookup for custom sprite roles based on their category
  const customRoleMap = new Map<string, ElementRole>()
  const customSpriteById = new Map<string, CustomSprite>()
  for (const cs of customSprites) {
    customSpriteById.set(cs.id, cs)
    if (cs.category === 'hazards') customRoleMap.set(cs.id, 'hazard')
    if (cs.category === 'obstacles') customRoleMap.set(cs.id, 'obstacle')
  }
  // Track which element kinds are present so we can auto-build spriteMap
  const kindsUsed = new Set<string>()
  for (const e of elements) {
    const t: [number, number, number, number] = [e.x, e.y, e.w, e.h]
    const role = ELEMENT_ROLE[e.kind] ?? customRoleMap.get(e.kind)
    kindsUsed.add(e.kind)
    switch (role) {
      case 'platform':
        if (e.kind === 'girder') out.girders!.push(t)
        else out.platforms.push(t)
        break
      case 'ladder':
        if (e.kind === 'chain') out.chains!.push(t)
        else if (e.kind === 'chain_clamp') out.chain_clamps!.push(t)
        else out.ladders.push(t)
        break
      case 'monster':
        switch (e.kind) {
          case 'hooter': out.hooters!.push(t); break
          case 'poglet': out.poglets!.push(t); break
          default:       out.monsters.push(t); break
        }
        break
      case 'item':
        switch (e.kind) {
          case 'key':     out.keys.push(t);      break
          case 'bulb':    out.bulbs.push(t);     break
          case 'diamond': out.treasures.push(t); break
        }
        break
      case 'exit':  out.exit = t; break
      case 'spawn': playerStarts.push([e.x + e.w / 2, e.y + e.h / 2]); break
      case 'hazard':
        out.customElements!.push({ kind: e.kind, x: e.x, y: e.y, w: e.w, h: e.h, attrs: e.attrs })
        break
      case 'obstacle':
        out.customElements!.push({ kind: e.kind, x: e.x, y: e.y, w: e.w, h: e.h, attrs: e.attrs })
        break
      default:
        out.customElements!.push({ kind: e.kind, x: e.x, y: e.y, w: e.w, h: e.h, attrs: e.attrs })
    }
  }
  if (playerStarts.length > 0) playerStart = playerStarts[0]
  out.playerStart = playerStart
  out.playerStarts = playerStarts.length > 1 ? playerStarts : undefined
  // Auto-build spriteMap from the kinds actually used in this level,
  // merging per-element attrs into the behavior.
  const spriteMap: Record<string, SpriteMapEntry> = {}
  for (const kind of kindsUsed) {
    const entry = DEFAULT_SPRITE_MAP[kind]
    if (entry) {
      spriteMap[kind] = { sprite: entry.sprite, tiling: entry.tiling, behavior: { ...entry.behavior } }
      if (entry.animMode) spriteMap[kind].animMode = entry.animMode
      if (entry.spriteScale !== undefined) spriteMap[kind].spriteScale = entry.spriteScale
      if (entry.fps !== undefined) spriteMap[kind].fps = entry.fps
    } else {
      // Build spriteMap entry from custom sprite data
      const cs = customSpriteById.get(kind)
      if (cs && cs.category === 'hazards') {
        spriteMap[kind] = {
          sprite: `custom/${cs.id}`,
          tiling: cs.tiling === 'h' || cs.tiling === 'v' ? cs.tiling : undefined,
          animMode: cs.animMode,
          behavior: {
            hazard: true,
            hazardMovement: 'rise',
            hazardAnimated: cs.frames.length > 1,
            hazardAnimFps: cs.fps,
            autoSpawn: { direction: 'down', interval: 3, speed: 1 },
          },
        }
      } else if (cs && cs.category === 'obstacles') {
        const blocking = cs.obstacleType === 'blocking'
        spriteMap[kind] = {
          sprite: `custom/${cs.id}`,
          tiling: cs.tiling === 'h' || cs.tiling === 'v' ? cs.tiling : undefined,
          animMode: cs.animMode,
          behavior: {
            obstacle: true,
            obstacleBlocking: blocking,
          },
        }
      } else if (cs) {
        // Generic custom sprite (terrain, characters, items)
        spriteMap[kind] = {
          sprite: `custom/${cs.id}`,
          tiling: cs.tiling === 'h' || cs.tiling === 'v' ? cs.tiling : undefined,
          animMode: cs.animMode,
          behavior: {},
        }
      }
    }
  }
  // Preserve hazard entries from the original level spriteMap even if no hazard
  // elements are explicitly placed — hazards spawn ambient based on spriteMap alone.
  for (const [kind, entry] of Object.entries(meta.spriteMap ?? {})) {
    if (entry.behavior.hazard && !spriteMap[kind]) {
      spriteMap[kind] = { sprite: entry.sprite, tiling: entry.tiling, behavior: { ...entry.behavior } }
    }
  }
  // Merge kind-level attrs (score, hud, etc.) from the first element of each kind
  for (const e of elements) {
    if (!e.attrs || !spriteMap[e.kind]) continue
    const behavior = spriteMap[e.kind].behavior
    if (typeof e.attrs.score === 'number') {
      if (behavior.enemy) behavior.enemyScore = e.attrs.score
      if (behavior.collectible) behavior.scoreValue = e.attrs.score
    }
    if (typeof e.attrs.show_in_hud === 'boolean') behavior.hud = e.attrs.show_in_hud
    if (typeof e.attrs.sprite_scale === 'number') spriteMap[e.kind].spriteScale = e.attrs.sprite_scale
    if (typeof e.attrs.fps === 'number') spriteMap[e.kind].fps = e.attrs.fps
    if (typeof e.attrs.anim_mode === 'string') spriteMap[e.kind].animMode = e.attrs.anim_mode as AnimMode
  }
  // Attach per-element attrs to hazard customElements
  // (each hazard instance carries its own autoSpawn direction/interval/speed)
  for (const ce of out.customElements ?? []) {
    if (ce.attrs && Object.keys(ce.attrs).length > 0 && spriteMap[ce.kind]) {
      const behavior = spriteMap[ce.kind].behavior
      if (behavior.autoSpawn && ce.attrs.direction) {
        behavior.autoSpawn = {
          ...behavior.autoSpawn,
          direction: ce.attrs.direction as 'down' | 'up' | 'diagonal-left' | 'diagonal-right',
          interval: typeof ce.attrs.interval_s === 'number' ? ce.attrs.interval_s : behavior.autoSpawn.interval,
          speed: typeof ce.attrs.speed === 'number' ? ce.attrs.speed : behavior.autoSpawn.speed,
        }
      }
    }
  }
  out.spriteMap = spriteMap
  return out
}

// ── LevelEditor class ─────────────────────────────────────────────────────────

export class LevelEditor {
  private el!: HTMLDivElement
  private canvas!: HTMLCanvasElement
  private ctx!: CanvasRenderingContext2D

  private level: LevelFile | null = null
  private elements: EdElement[] = []
  private undoStack: EdElement[][] = []

  // View state
  private viewLeft   = -1
  private viewBottom = -3
  private scale      = 18

  // Mode (select / erase)
  private mode: Mode = 'select'

  // Canvas drag state (move existing elements, pan)
  private dragging       = false
  private dragMode: 'move' | 'pan' = 'move'
  private selectedIdx: number | null = null
  private moveOrigin: { x: number; y: number } | null = null
  private dragWorldStart: [number, number] = [0, 0]
  private panOrigin: { cx: number; cy: number; vl: number; vb: number } | null = null

  // Palette drag-drop state
  private paletteDragging  = false
  private paletteDragKind: ElementKind | null = null
  private paletteDragGhost: HTMLDivElement | null = null

  // Resize edge drag state (platforms & ladders only)
  private resizingIdx: number | null = null
  private resizeEdge: 'left' | 'right' | 'top' | 'bottom' | null = null
  private resizeOrigin: { x: number; y: number; w: number; h: number; ex: number; ey: number } | null = null

  // Multi-selection
  private selectedSet = new Set<number>()
  private marqueeStart: [number, number] | null = null
  private marqueeEnd: [number, number] | null = null
  private multiMoveOrigins: Map<number, { x: number; y: number }> | null = null

  // Custom world bounds (user-set via dragging world border edges)
  private customBounds: { left: number; right: number; bottom: number; top: number } | null = null
  // Bounds edge drag state
  private boundsDragEdge: 'left' | 'right' | 'top' | 'bottom' | null = null

  // UI element refs
  private modeBtns: Map<Mode, HTMLButtonElement> = new Map()
  private nameInput!: HTMLInputElement
  private timeLimitInput!: HTMLInputElement
  private musicSelect!: HTMLSelectElement
  private bgSelect!: HTMLSelectElement
  private musicDeleteBtn!: HTMLButtonElement
  private bgDeleteBtn!: HTMLButtonElement
  private bgColorInput!: HTMLInputElement
  private bgColorRow!: HTMLDivElement
  private bgThumb!: HTMLImageElement
  private musicPreviewBtn!: HTMLButtonElement
  private previewAudio: HTMLAudioElement | null = null
  private customBgFiles: string[] = []
  private customMusicFiles: string[] = []
  private levelSelectEl!: HTMLSelectElement
  private statusPos!: HTMLSpanElement
  private statusCount!: HTMLSpanElement
  private elemInfoEl!: HTMLElement
  private delElemBtn!: HTMLButtonElement
  private delLevelBtn!: HTMLButtonElement
  private widthInput!: HTMLInputElement
  private heightInput!: HTMLInputElement
  private attrsSection!: HTMLElement
  private attrsPanel!: HTMLElement
  private spriteConfigSection!: HTMLElement
  private spriteConfigPanel!: HTMLElement

  // Callbacks set by main.ts
  onDryRun: ((lf: LevelFile) => void) | null = null
  onClose:  (() => void) | null = null
  onOpenSpriteEditor: (() => void) | null = null

  // Loaded sprite images for canvas preview
  private edImgs: Partial<Record<string, HTMLImageElement>> = {}
  // Custom imported sprites
  private customSprites: CustomSprite[] = []
  private customSpriteById: Map<string, CustomSprite> = new Map()
  private customSpriteImages: Map<string, HTMLImageElement> = new Map()

  private container: HTMLElement
  constructor(container: HTMLElement) {
    this.container = container
    this.injectStyles()
    this.buildDOM()
    this.bindEvents()
    this.loadEditorSprites()
    this.loadCustomSpritesData()
  }

  // ── Sprite loading ────────────────────────────────────────────────────────────

  private loadEditorSprites() {
    let pending = 0
    for (const [kind, url] of Object.entries(ED_SPRITE_URL) as [ElementKind, string][]) {
      pending++
      const img = new Image()
      img.onload = () => {
        this.edImgs[kind] = img
        this.refreshPaletteTileSprite(kind, img)
        if (--pending === 0) this.render()
      }
      img.src = url
    }
  }

  private refreshPaletteTileSprite(kind: ElementKind, img: HTMLImageElement) {
    const tile = this.el.querySelector<HTMLDivElement>(`.ed-pal-tile[data-kind="${kind}"]`)
    if (!tile) return
    const cv = tile.querySelector<HTMLCanvasElement>('.ed-pal-sprite-cv')
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    const aspect = img.naturalWidth / img.naturalHeight
    let sw = cv.width, sh = cv.height
    if (aspect > 1) { sh = sw / aspect } else { sw = sh * aspect }
    const ox = (cv.width - sw) / 2
    const oy = (cv.height - sh) / 2
    ctx.drawImage(img, ox, oy, sw, sh)
  }

  // ── CSS ─────────────────────────────────────────────────────────────────────

  private injectStyles() {
    if (document.getElementById('ed-styles')) return
    const s = document.createElement('style')
    s.id = 'ed-styles'
    s.textContent = `
      #ed-screen {
        position:fixed;inset:0;z-index:200;
        background:#0d1520;color:#d6e8f8;
        display:flex;flex-direction:column;
        font-family:'Trebuchet MS','Verdana',sans-serif;font-size:13px;
        user-select:none;
      }
      /* ── Top bar ── */
      #ed-topbar {
        display:flex;align-items:center;gap:6px;flex-wrap:wrap;
        padding:5px 8px;background:#080f18;
        border-bottom:1px solid #1a3050;flex-shrink:0;
      }
      .ed-btn {
        padding:4px 10px;border-radius:4px;
        border:1px solid #243a58;background:#0f2035;
        color:#c0d8f0;cursor:pointer;font-size:12px;white-space:nowrap;
        line-height:1.3;
      }
      .ed-btn:hover { background:#182d46;border-color:#3a6090; }
      .ed-btn.ed-primary { border-color:#2090c0;color:#80d8ff; }
      .ed-btn.ed-primary:hover { background:#0a2840; }
      .ed-btn.ed-danger { border-color:#804040;color:#ffaaaa; }
      .ed-btn.ed-danger:hover { background:#200a0a; }
      .ed-sep { width:1px;height:20px;background:#1a3050;flex-shrink:0; }
      .ed-label { opacity:0.5;font-size:11px;white-space:nowrap; }
      .ed-select {
        padding:3px 6px;border-radius:4px;border:1px solid #243a58;
        background:#0f2035;color:#c0d8f0;font-size:12px;
      }
      /* ── Body ── */
      #ed-body { display:flex;flex:1;overflow:hidden; }
      /* ── Palette sidebar ── */
      #ed-palette {
        width:110px;flex-shrink:0;background:#080f18;
        border-right:1px solid #1a3050;
        display:flex;flex-direction:column;padding:6px 5px;gap:2px;
        overflow-y:auto;
      }
      .ed-pal-group-head {
        font-size:9px;font-weight:700;text-transform:uppercase;
        color:#ffd46b;letter-spacing:0.08em;
        padding:5px 3px 2px;margin-top:3px;
        border-top:1px solid #1a3050;
      }
      .ed-pal-group-head:first-child { border-top:none;margin-top:0; }
      .ed-pal-tile {
        display:flex;align-items:center;gap:6px;
        padding:7px 6px;border-radius:5px;
        border:1px solid #1a3050;background:#0f2035;
        color:#8ab0c8;cursor:grab;font-size:11px;
        transition:background 80ms,border-color 80ms;
      }
      .ed-pal-tile:hover { background:#162840;border-color:#2a4868;color:#c0e0ff; }
      .ed-pal-tile:active { cursor:grabbing; }
      .ed-pal-tile .ed-pal-icon { font-size:18px;line-height:1;flex-shrink:0;width:22px;text-align:center; }
      .ed-pal-tile .ed-pal-sprite-cv { width:28px;height:28px;flex-shrink:0;border-radius:3px;background:#07101a; }
      .ed-pal-tile .ed-pal-name { flex:1;font-size:11px;line-height:1.2; }
      /* Ghost element following cursor during palette drag */
      .ed-drag-ghost {
        position:fixed;pointer-events:none;z-index:9999;
        border-radius:5px;border:2px dashed;opacity:0.85;
        display:flex;align-items:center;justify-content:center;
        font-size:22px;line-height:1;
        transform:translate(-50%,-50%);
        box-shadow:0 4px 18px rgba(0,0,0,0.6);
      }
      /* ── Canvas area ── */
      #ed-canvas-wrap {
        flex:1;overflow:hidden;position:relative;background:#07101a;
      }
      #ed-canvas { display:block; }
      #ed-canvas-wrap.drag-over { outline:2px solid #3090d0; }
      /* ── Side panel ── */
      #ed-side {
        width:196px;flex-shrink:0;background:#080f18;
        border-left:1px solid #1a3050;
        padding:8px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;
      }
      .ed-section-head {
        font-size:9px;font-weight:700;text-transform:uppercase;
        color:#ffd46b;letter-spacing:0.08em;margin-bottom:3px;
      }
      .ed-section { display:flex;flex-direction:column;gap:3px; }
      .ed-prop {
        padding:4px 6px;border-radius:3px;border:1px solid #243a58;
        background:#0f2035;color:#d6e8f8;font-size:12px;width:100%;
        box-sizing:border-box;
      }
      .ed-elem-info {
        background:#0f2035;border-radius:4px;padding:6px;
        font-size:11px;color:#7090a8;line-height:1.6;
        min-height:38px;
      }
      .ed-size-row { display:flex;gap:4px;align-items:center;font-size:11px; }
      .ed-size-row label { opacity:0.6;flex-shrink:0; }
      .ed-size-row input {
        flex:1;padding:3px 5px;border-radius:3px;border:1px solid #243a58;
        background:#0f2035;color:#d6e8f8;font-size:11px;box-sizing:border-box;
      }
      .ed-attr-row { display:flex;gap:4px;align-items:center;font-size:11px;margin-top:3px; }
      .ed-attr-row label { opacity:0.6;flex-shrink:0;min-width:68px;font-size:10px; }
      .ed-attr-row select, .ed-attr-row input {
        flex:1;padding:3px 5px;border-radius:3px;border:1px solid #243a58;
        background:#0f2035;color:#d6e8f8;font-size:11px;box-sizing:border-box;
      }
      .ed-attr-row input[type="checkbox"] { flex:none;width:14px;height:14px;margin:0; }
      /* ── Status bar ── */
      #ed-statusbar {
        display:flex;gap:16px;padding:3px 10px;
        background:#080f18;border-top:1px solid #1a3050;
        font-size:11px;color:#4a6880;flex-shrink:0;
      }
      #ed-status-pos { font-family:monospace; }
      /* ── Custom palette section ── */
      #ed-pal-import-btn {
        margin:8px 3px 2px;padding:5px 4px;border-radius:4px;
        border:1px dashed #2a4060;background:transparent;
        color:#507090;cursor:pointer;font-size:10px;text-align:center;
        letter-spacing:0.05em;transition:color 80ms,border-color 80ms;
      }
      #ed-pal-import-btn:hover { border-color:#4090c0;color:#80c8f0; }
      /* ── Help modal ── */
      #ed-help-modal {
        position:fixed;inset:0;z-index:300;
        background:rgba(5,12,22,0.94);
        display:none;align-items:center;justify-content:center;
      }
      #ed-help-modal.visible { display:flex; }
      .ed-help-content {
        background:#0c1a2a;border:1px solid #1a3050;border-radius:10px;
        max-width:720px;width:92%;max-height:88vh;overflow-y:auto;
        padding:24px 28px;color:#c0d8f0;
        box-shadow:0 12px 48px rgba(0,0,0,0.7);
      }
      .ed-help-content h2 { color:#ffd46b;font-size:17px;margin:18px 0 8px;border-bottom:1px solid #1a3050;padding-bottom:4px; }
      .ed-help-content h2:first-child { margin-top:0; }
      .ed-help-content p  { font-size:13px;line-height:1.7;margin:4px 0 8px;opacity:0.85; }
      .ed-help-content ul { font-size:13px;line-height:1.8;padding-left:20px;margin:4px 0 12px; }
      .ed-help-content li { margin:2px 0; }
      .ed-help-content kbd {
        display:inline-block;padding:1px 6px;border-radius:3px;
        background:#182d46;border:1px solid #2a4868;color:#80d8ff;
        font-family:monospace;font-size:12px;
      }
      .ed-help-diagram {
        display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 12px;
      }
      .ed-help-diagram .ed-hd-box {
        border:1px solid #2a4868;border-radius:6px;background:#0f2035;
        padding:8px 12px;font-size:12px;text-align:center;min-width:100px;
      }
      .ed-help-diagram .ed-hd-box .ed-hd-icon { font-size:24px;display:block;margin-bottom:4px; }
      .ed-help-diagram .ed-hd-box .ed-hd-lbl  { color:#8ab0c8;font-size:11px; }
      .ed-help-flow {
        display:flex;align-items:center;gap:6px;margin:10px 0 14px;
        font-size:12px;color:#6090b0;flex-wrap:wrap;
      }
      .ed-help-flow .ed-hf-step {
        background:#0f2035;border:1px solid #243a58;border-radius:5px;
        padding:5px 10px;color:#c0d8f0;
      }
      .ed-help-flow .ed-hf-arrow { font-size:16px;color:#3a6090; }
    `
    document.head.appendChild(s)
  }

  // ── DOM ──────────────────────────────────────────────────────────────────────

  private buildDOM() {
    this.el = document.createElement('div')
    this.el.id = 'ed-screen'
    this.el.style.display = 'none'

    // Top bar
    const topbar = document.createElement('div')
    topbar.id = 'ed-topbar'
    topbar.innerHTML = `
      <button class="ed-btn" id="ed-back">← Exit Editor</button>
      <div class="ed-sep"></div>
      <span class="ed-label">Level:</span>
      <select class="ed-select" id="ed-level-sel" style="max-width:160px"></select>
      <button class="ed-btn" id="ed-new-level">+ New</button>
      <button class="ed-btn ed-danger" id="ed-del-level" style="display:none">Delete</button>
      <div class="ed-sep"></div>
      <span class="ed-label">Mode:</span>
      <button class="ed-btn active" id="ed-mode-select" title="Select &amp; move elements">↖ Select</button>
      <button class="ed-btn" id="ed-mode-erase" title="Click an element to delete it">✕ Erase</button>
      <div class="ed-sep"></div>
      <button class="ed-btn" id="ed-zoom-game" title="Zoom to approx. game camera size">1:1</button>
      <button class="ed-btn" id="ed-zoom-fit"  title="Zoom to fit whole playfield">Fit</button>
      <div class="ed-sep"></div>
      <button class="ed-btn" id="ed-import">📂 Import</button>
      <button class="ed-btn" id="ed-export">💾 Export</button>
      <button class="ed-btn" id="ed-export-zip">📦 Export ZIP</button>
      <input type="file" id="ed-file-input" accept=".json,.zip" style="display:none" />
      <div class="ed-sep"></div>
      <button class="ed-btn ed-primary" id="ed-dryrun">▶ Dry Run</button>
      <div class="ed-sep"></div>
      <button class="ed-btn" id="ed-help" title="How to use the level editor">❓ Help</button>
    `
    this.el.appendChild(topbar)

    // Body
    const body = document.createElement('div')
    body.id = 'ed-body'

    // ── Palette sidebar ──────────────────────────────────────────────────────
    const palette = document.createElement('div')
    palette.id = 'ed-palette'

    for (const { head, kinds } of PALETTE_GROUPS) {
      const h = document.createElement('div')
      h.className = 'ed-pal-group-head'
      h.textContent = head
      palette.appendChild(h)

      for (const kind of kinds) {
        const c = KIND_COLOR[kind]
        const tile = document.createElement('div')
        tile.className = 'ed-pal-tile'
        tile.dataset.kind = kind
        tile.draggable = true
        tile.title = `Drag onto canvas  ·  ${c.label}`
        const hasSprite = kind in ED_SPRITE_URL
        const iconHtml = hasSprite
          ? `<canvas class="ed-pal-sprite-cv" width="28" height="28"></canvas>`
          : `<div class="ed-pal-icon">${c.icon}</div>`
        tile.innerHTML = `${iconHtml}<span class="ed-pal-name">${c.label}</span>`
        palette.appendChild(tile)
      }
      // Per-category container for custom sprites
      const catSlot = document.createElement('div')
      catSlot.id = `ed-pal-custom-${head.toLowerCase()}`
      palette.appendChild(catSlot)
    }
    // Import sprite button — redirects to sprite editor
    const impBtn = document.createElement('button')
    impBtn.id = 'ed-pal-import-btn'
    impBtn.textContent = '⊕ Import Sprite (Sprite Editor)'
    palette.appendChild(impBtn)
    const customSection = document.createElement('div')
    customSection.id = 'ed-pal-custom'
    palette.appendChild(customSection)
    body.appendChild(palette)

    // Canvas wrap
    const canvasWrap = document.createElement('div')
    canvasWrap.id = 'ed-canvas-wrap'
    this.canvas = document.createElement('canvas')
    this.canvas.id = 'ed-canvas'
    this.canvas.setAttribute('aria-label', 'Level editor canvas')
    canvasWrap.appendChild(this.canvas)
    body.appendChild(canvasWrap)

    // Side panel
    const side = document.createElement('div')
    side.id = 'ed-side'
    side.innerHTML = `
      <div class="ed-section">
        <div class="ed-section-head">Level Name</div>
        <input id="ed-name" class="ed-prop" type="text" placeholder="Level name…" />
      </div>
      <div class="ed-section">
        <div class="ed-section-head">Time Limit (seconds)</div>
        <input id="ed-timelimit" class="ed-prop" type="number" min="10" max="600" step="10" value="120" />
      </div>
      <div class="ed-section">
        <div class="ed-section-head">Music</div>
        <div style="display:flex;gap:4px;align-items:center">
          <select id="ed-music" class="ed-prop" style="flex:1"></select>
          <button class="ed-btn" id="ed-music-preview" style="font-size:14px;width:28px;height:28px;padding:0;line-height:28px;text-align:center;flex-shrink:0" title="Preview music">▶</button>
        </div>
        <div style="display:flex;gap:4px;margin-top:4px">
          <button class="ed-btn" id="ed-music-upload" style="flex:1;font-size:11px" title="Upload custom music file">⊕ Upload</button>
          <button class="ed-btn ed-danger" id="ed-music-delete" style="font-size:11px;display:none" title="Delete selected custom music">✕ Delete</button>
        </div>
      </div>
      <div class="ed-section">
        <div class="ed-section-head">Background</div>
        <select id="ed-bg" class="ed-prop"></select>
        <div id="ed-bg-color-row" style="display:none;margin-top:4px;align-items:center;gap:6px">
          <label style="font-size:11px;color:#a0c0e0">Colour</label>
          <input id="ed-bg-color" type="color" value="#00d8d8" style="width:36px;height:24px;padding:0;border:1px solid #3a6090;border-radius:3px;background:transparent;cursor:pointer" />
        </div>
        <img id="ed-bg-thumb" style="display:none;margin-top:6px;max-width:100%;height:auto;border:1px solid #3a6090;border-radius:3px" alt="Background preview" />
        <div style="display:flex;gap:4px;margin-top:4px">
          <button class="ed-btn" id="ed-bg-upload" style="flex:1;font-size:11px" title="Upload custom background image">⊕ Upload</button>
          <button class="ed-btn ed-danger" id="ed-bg-delete" style="font-size:11px;display:none" title="Delete selected custom background">✕ Delete</button>
        </div>
      </div>
      <div class="ed-section">
        <div class="ed-section-head">Hazards</div>
        <div id="ed-hazard-toggles" style="font-size:11px;line-height:2"></div>
      </div>
      <div class="ed-section">
        <div class="ed-section-head">Selected Element</div>
        <div id="ed-elem-info" class="ed-elem-info">Drag an element from the left panel onto the canvas</div>
        <div id="ed-size-section" style="display:none">
          <div class="ed-section-head" style="margin-top:6px">Size</div>
          <div class="ed-size-row"><label>W</label><input id="ed-sel-w" type="number" step="0.25" min="0.25" /></div>
          <div class="ed-size-row"><label>H</label><input id="ed-sel-h" type="number" step="0.25" min="0.25" /></div>
        </div>
        <button id="ed-del-elem" class="ed-btn ed-danger" style="display:none;margin-top:4px">Delete Selected</button>
        <div id="ed-attrs-section" style="display:none">
          <div class="ed-section-head" style="margin-top:6px">Attributes</div>
          <div id="ed-attrs-panel"></div>
        </div>
        <div id="ed-spriteconfig-section" style="display:none">
          <div class="ed-section-head" style="margin-top:6px">Sprite Config</div>
          <div id="ed-spriteconfig-panel"></div>
        </div>
      </div>
      <div class="ed-section" style="margin-top:auto">
        <div class="ed-section-head">Controls</div>
        <div style="font-size:11px;opacity:0.5;line-height:1.7">
          Drag from panel → place<br>
          Drag on canvas → move<br>
          RMB drag → pan view<br>
          Scroll → zoom<br>
          F → fit whole level<br>
          1 → game-size view<br>
          Del / Backspace → delete<br>
          Ctrl+Z → undo
        </div>
      </div>
    `
    body.appendChild(side)
    this.el.appendChild(body)

    // Status bar
    const statusBar = document.createElement('div')
    statusBar.id = 'ed-statusbar'
    statusBar.innerHTML = `
      <span id="ed-status-pos" class="ed-coord">x:0.00 y:0.00</span>
      <span id="ed-status-count"></span>
    `
    this.el.appendChild(statusBar)

    this.container.appendChild(this.el)

    // ── Help modal ────────────────────────────────────────────────────────────
    const helpModal = document.createElement('div')
    helpModal.id = 'ed-help-modal'
    helpModal.setAttribute('role', 'dialog')
    helpModal.setAttribute('aria-modal', 'true')
    helpModal.setAttribute('aria-label', 'Level Editor Guide')
    helpModal.innerHTML = `
      <div class="ed-help-content">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <span style="font-size:18px;font-weight:700;color:#ffd46b">📖 Level Editor Guide</span>
          <button class="ed-btn" id="ed-help-close">✕ Close</button>
        </div>

        <h2>🖱️ Canvas Controls</h2>
        <div class="ed-help-diagram">
          <div class="ed-hd-box"><span class="ed-hd-icon">🖱️</span><span class="ed-hd-lbl">Left-click<br>Select / Move</span></div>
          <div class="ed-hd-box"><span class="ed-hd-icon">🖱️➡</span><span class="ed-hd-lbl">Right-drag<br>Pan view</span></div>
          <div class="ed-hd-box"><span class="ed-hd-icon">🔄</span><span class="ed-hd-lbl">Scroll wheel<br>Zoom in/out</span></div>
        </div>

        <h2>⌨️ Keyboard Shortcuts</h2>
        <ul>
          <li><kbd>F</kbd> — Fit entire level in view</li>
          <li><kbd>1</kbd> — Zoom to game-camera size (1:1)</li>
          <li><kbd>Del</kbd> or <kbd>Backspace</kbd> — Delete selected element</li>
          <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> — Undo last action</li>
        </ul>

        <h2>🧩 Placing Elements</h2>
        <div class="ed-help-flow">
          <span class="ed-hf-step">1. Pick from<br>left palette</span>
          <span class="ed-hf-arrow">→</span>
          <span class="ed-hf-step">2. Drag onto<br>the canvas</span>
          <span class="ed-hf-arrow">→</span>
          <span class="ed-hf-step">3. Release to<br>place element</span>
        </div>
        <p>Elements snap to a 0.125-unit grid. After placing, click an element to select it, then drag to reposition.</p>

        <h2>↔️ Resizing</h2>
        <p>Platforms (earth, log) and vertical links (ladders, ropes) can be resized:</p>
        <ul>
          <li><b>Drag the edge handles</b> — yellow dots appear on the right and top edges of the selected element. Drag them to resize freely.</li>
          <li><b>Side panel inputs</b> — use the W / H number inputs in the right panel for precise sizing.</li>
          <li>Elements can be any size. When wider or taller than one tile, the sprite <b>tiles automatically</b> to fill the area.</li>
        </ul>
        <div class="ed-help-diagram">
          <div class="ed-hd-box"><span class="ed-hd-icon">◻️</span><span class="ed-hd-lbl">Partial tile<br>(any width)</span></div>
          <div class="ed-hd-box"><span class="ed-hd-icon">◻️◻️</span><span class="ed-hd-lbl">Two tiles<br>(exact tiling)</span></div>
          <div class="ed-hd-box"><span class="ed-hd-icon">◻️◻️½</span><span class="ed-hd-lbl">Two and a half<br>(clips last tile)</span></div>
        </div>

        <h2>⚙️ Element Attributes</h2>
        <p>Select an element and look at the <b>Attributes</b> section in the right panel. Different element types have different editable properties:</p>
        <ul>
          <li><b>Hazards</b> (balloon, dagger) — Direction, Spawn Interval, Speed</li>
          <li><b>Enemies</b> (scrubbly, hooter, poglet) — Score value</li>
          <li><b>Collectibles</b> (key, bulb, diamond) — Score value, HUD visibility</li>
        </ul>
        <p>Changes are saved automatically with the level.</p>

        <h2>📁 Saving &amp; Loading</h2>
        <div class="ed-help-flow">
          <span class="ed-hf-step">Auto-saved<br>on every edit</span>
          <span class="ed-hf-arrow">+</span>
          <span class="ed-hf-step">💾 Export<br>downloads .json</span>
          <span class="ed-hf-arrow">+</span>
          <span class="ed-hf-step">📂 Import<br>loads .json file</span>
        </div>
        <ul>
          <li><b>Auto-save</b> — Every change is saved immediately (to localStorage for custom levels, or to disk for built-in levels via the dev server).</li>
          <li><b>Export</b> — Click 💾 <b>Export</b> in the toolbar to download the current level as a <code>.json</code> file. Use this for backups or to share levels.</li>
          <li><b>Import</b> — Click 📂 <b>Import</b> to load a <code>.json</code> level file from disk. This replaces the current level's data.</li>
        </ul>

        <h2>🎮 Dry Run</h2>
        <p>Click <b>▶ Dry Run</b> to instantly test-play the current level. The game loads your working level data without saving it to a file first — great for rapid iteration.</p>

        <h2>📐 Modes</h2>
        <ul>
          <li><b>↖ Select</b> — Default mode. Click to select, drag to move, drag edges to resize.</li>
          <li><b>✕ Erase</b> — Click any element to instantly delete it.</li>
        </ul>

        <h2>📦 Level Management</h2>
        <ul>
          <li><b>Level dropdown</b> — Switch between built-in levels and your custom levels.</li>
          <li><b>+ New</b> — Creates a blank custom level.</li>
          <li><b>Delete</b> — Removes the current custom level (only visible for custom levels).</li>
        </ul>

        <h2>🖼️ Import Sprite</h2>
        <p>Click <b>⊕ Import Sprite</b> at the bottom of the left palette to add custom sprite sheets. Configure the grid, set element properties, and the new element type appears in the palette for placement.</p>

        <div style="margin-top:16px;text-align:center">
          <button class="ed-btn ed-primary" id="ed-help-close2">Got it!</button>
        </div>
      </div>
    `
    this.container.appendChild(helpModal)

    // Grab refs
    this.ctx = this.canvas.getContext('2d')!
    this.nameInput    = document.getElementById('ed-name')      as HTMLInputElement
    this.timeLimitInput = document.getElementById('ed-timelimit') as HTMLInputElement
    this.musicSelect  = document.getElementById('ed-music')     as HTMLSelectElement
    this.bgSelect     = document.getElementById('ed-bg')        as HTMLSelectElement
    this.musicDeleteBtn = document.getElementById('ed-music-delete') as HTMLButtonElement
    this.bgDeleteBtn    = document.getElementById('ed-bg-delete')    as HTMLButtonElement
    this.bgColorInput   = document.getElementById('ed-bg-color')     as HTMLInputElement
    this.bgColorRow     = document.getElementById('ed-bg-color-row') as HTMLDivElement
    this.bgThumb        = document.getElementById('ed-bg-thumb')     as HTMLImageElement
    this.musicPreviewBtn = document.getElementById('ed-music-preview') as HTMLButtonElement
    this.levelSelectEl= document.getElementById('ed-level-sel') as HTMLSelectElement
    this.statusPos    = document.getElementById('ed-status-pos')as HTMLSpanElement
    this.statusCount  = document.getElementById('ed-status-count')as HTMLSpanElement
    this.elemInfoEl   = document.getElementById('ed-elem-info')!
    this.delElemBtn   = document.getElementById('ed-del-elem')  as HTMLButtonElement
    this.delLevelBtn  = document.getElementById('ed-del-level') as HTMLButtonElement
    this.widthInput   = document.getElementById('ed-sel-w')     as HTMLInputElement
    this.heightInput  = document.getElementById('ed-sel-h')     as HTMLInputElement
    this.attrsSection = document.getElementById('ed-attrs-section')!
    this.attrsPanel   = document.getElementById('ed-attrs-panel')!
    this.spriteConfigSection = document.getElementById('ed-spriteconfig-section')!
    this.spriteConfigPanel   = document.getElementById('ed-spriteconfig-panel')!

    this.modeBtns.set('select', document.getElementById('ed-mode-select') as HTMLButtonElement)
    this.modeBtns.set('erase',  document.getElementById('ed-mode-erase')  as HTMLButtonElement)

    const ro = new ResizeObserver(() => this.onResize())
    ro.observe(canvasWrap)

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  private bindEvents() {
    document.getElementById('ed-back')!.addEventListener('click', () => this.onClose?.())
    document.getElementById('ed-new-level')!.addEventListener('click', () => this.createNewLevel())
    this.delLevelBtn.addEventListener('click', () => this.deleteCurrentLevel())
    document.getElementById('ed-import')!.addEventListener('click', () =>
      (document.getElementById('ed-file-input') as HTMLInputElement).click())
    document.getElementById('ed-export')!.addEventListener('click', () => this.exportJson())
    document.getElementById('ed-export-zip')!.addEventListener('click', () => this.exportZip())
    document.getElementById('ed-file-input')!.addEventListener('change', (e) =>
      this.importFile(e as InputEvent & { target: HTMLInputElement }))
    document.getElementById('ed-dryrun')!.addEventListener('click', () => this.doDryRun())
    document.getElementById('ed-help')!.addEventListener('click', () => {
      document.getElementById('ed-help-modal')!.classList.add('visible')
      ;(document.getElementById('ed-help-close') as HTMLElement).focus()
    })
    const closeHelp = () => {
      document.getElementById('ed-help-modal')!.classList.remove('visible')
      ;(document.getElementById('ed-help') as HTMLElement).focus()
    }
    document.getElementById('ed-help-close')!.addEventListener('click', closeHelp)
    document.getElementById('ed-help-close2')!.addEventListener('click', closeHelp)
    document.getElementById('ed-help-modal')!.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'ed-help-modal') closeHelp()
    })
    document.getElementById('ed-zoom-game')!.addEventListener('click', () => { this.zoomToGame(); this.render() })
    document.getElementById('ed-zoom-fit')!.addEventListener('click',  () => { this.fitWorld();    this.render() })
    this.delElemBtn.addEventListener('click', () => this.deleteSelected())

    // Mode buttons
    this.modeBtns.get('select')!.addEventListener('click', () => this.setMode('select'))
    this.modeBtns.get('erase')!.addEventListener('click',  () => this.setMode('erase'))

    this.levelSelectEl.addEventListener('change', () => this.selectLevel(this.levelSelectEl.value))

    this.nameInput.addEventListener('input', () => {
      if (this.level) { this.level.name = this.nameInput.value; this.saveCurrentCustom() }
    })
    this.musicSelect.addEventListener('change', () => {
      if (this.level) {
        const val = parseInt(this.musicSelect.value)
        this.level.musicTrack = val
        // Store custom filename when a custom music track is selected
        if (val >= 100) {
          const idx = val - 100
          this.level.customMusic = this.customMusicFiles[idx]
        } else {
          delete this.level.customMusic
        }
        this.updateMusicDeleteBtn()
        this.stopMusicPreview()
        this.saveCurrentCustom()
      }
    })
    this.bgSelect.addEventListener('change', () => {
      if (this.level) {
        const val = parseInt(this.bgSelect.value)
        this.level.backgroundIndex = val
        if (val >= 100) {
          const idx = val - 100
          this.level.customBg = this.customBgFiles[idx]
        } else {
          delete this.level.customBg
        }
        this.updateBgDeleteBtn()
        this.updateBgColorPicker()
        this.updateBgThumbnail()
        this.saveCurrentCustom()
      }
    })
    this.musicPreviewBtn.addEventListener('click', () => this.toggleMusicPreview())
    this.bgColorInput.addEventListener('input', () => {
      if (this.level && this.level.backgroundIndex === -1) {
        this.level.bgColor = this.bgColorInput.value
        this.saveCurrentCustom()
      }
    })

    // Custom asset upload/delete buttons
    document.getElementById('ed-music-upload')!.addEventListener('click', () => this.uploadCustomAsset('music'))
    this.musicDeleteBtn.addEventListener('click', () => this.deleteCustomAsset('music'))
    document.getElementById('ed-bg-upload')!.addEventListener('click', () => this.uploadCustomAsset('background'))
    this.bgDeleteBtn.addEventListener('click', () => this.deleteCustomAsset('background'))
    this.timeLimitInput.addEventListener('change', () => {
      if (this.level) {
        const v = parseInt(this.timeLimitInput.value)
        this.level.timeLimit = isNaN(v) || v <= 0 ? undefined : v
        this.saveCurrentCustom()
      }
    })

    // Size inputs (platform / ladder resize from side panel)
    this.widthInput.addEventListener('change', () => {
      if (this.selectedIdx === null) return
      const el = this.elements[this.selectedIdx]
      const v = parseFloat(this.widthInput.value)
      if (isNaN(v) || v < SNAP) return
      this.commitEdit()
      if (tilesH(el.kind)) {
        const tw = this.tileSpriteW(el.kind) * el.h
        el.w = Math.max(tw, Math.round(v / tw) * tw)
      } else {
        el.w = snapV(v)
      }
      this.updateElemInfo(); this.render()
    })
    this.heightInput.addEventListener('change', () => {
      if (this.selectedIdx === null) return
      const el = this.elements[this.selectedIdx]
      const v = parseFloat(this.heightInput.value)
      if (isNaN(v) || v < SNAP) return
      this.commitEdit()
      if (tilesV(el.kind)) {
        const th = this.tileSpriteH(el.kind) * el.w
        el.h = Math.max(th, Math.round(v / th) * th)
      } else {
        el.h = snapV(v)
      }
      this.updateElemInfo(); this.render()
    })

    this.canvas.addEventListener('mousedown',  (e) => this.onMouseDown(e))
    this.canvas.addEventListener('mousemove',  (e) => this.onMouseMove(e))
    this.canvas.addEventListener('mouseup',    (e) => this.onMouseUp(e))
    this.canvas.addEventListener('mouseleave', () => this.onMouseLeave())
    this.canvas.addEventListener('wheel',      (e) => this.onWheel(e), { passive: false })

    // ── Palette drag ──────────────────────────────────────────────────────────
    const palette = document.getElementById('ed-palette')!
    const canvasWrap = document.getElementById('ed-canvas-wrap')!

    palette.addEventListener('dragstart', (e) => {
      const tile = (e.target as HTMLElement).closest('.ed-pal-tile') as HTMLElement | null
      if (!tile) return
      const kind = tile.dataset.kind as ElementKind
      this.paletteDragKind = kind
      this.paletteDragging = true
      // Suppress the default drag image
      const blank = document.createElement('canvas')
      blank.width = blank.height = 1
      e.dataTransfer!.setDragImage(blank, 0, 0)
      e.dataTransfer!.effectAllowed = 'copy'
      // Floating ghost — show sprite if available, otherwise coloured emoji tile
      const c = this.kindColor(kind)
      const [dw, dh] = this.kindSize(kind)
      const ghostImg = this.edImgs[kind] ?? this.customSpriteImages.get(kind)

      const ghost = document.createElement('div')
      ghost.className = 'ed-drag-ghost'

      if (ghostImg) {
        // Scale the ghost so it represents the game-unit hitbox at ~2px per unit
        const PX_PER_UNIT = 22
        const gw = Math.round(dw * PX_PER_UNIT)
        const gh = Math.round(dh * PX_PER_UNIT)
        ghost.style.cssText = `width:${gw}px;height:${gh}px;background:${c.fill};border-color:${c.stroke};overflow:hidden;padding:0;`
        const cv = document.createElement('canvas')
        cv.width = gw; cv.height = gh
        cv.style.cssText = 'display:block;width:100%;height:100%;'
        const ctx2 = cv.getContext('2d')
        if (ctx2) {
          const sAspect = ghostImg.naturalWidth / ghostImg.naturalHeight
          let sw = gw, sh = gh
          if (sAspect > gw / gh) { sh = sw / sAspect } else { sw = sh * sAspect }
          ctx2.drawImage(ghostImg, (gw - sw) / 2, (gh - sh) / 2, sw, sh)
        }
        ghost.appendChild(cv)
      } else {
        ghost.style.cssText = `width:48px;height:48px;background:${c.fill};border-color:${c.stroke};color:${c.stroke};font-size:24px;`
        ghost.textContent = c.icon
      }

      document.body.appendChild(ghost)
      this.paletteDragGhost = ghost
    })

    palette.addEventListener('dragend', () => {
      this.paletteDragging = false
      this.paletteDragKind = null
      if (this.paletteDragGhost) { this.paletteDragGhost.remove(); this.paletteDragGhost = null }
      canvasWrap.classList.remove('drag-over')
    })

    canvasWrap.addEventListener('dragover', (e) => {
      if (!this.paletteDragging) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
      canvasWrap.classList.add('drag-over')
      if (this.paletteDragGhost) {
        this.paletteDragGhost.style.left = `${e.clientX}px`
        this.paletteDragGhost.style.top  = `${e.clientY}px`
      }
    })

    canvasWrap.addEventListener('dragleave', () => canvasWrap.classList.remove('drag-over'))

    canvasWrap.addEventListener('drop', (e) => {
      e.preventDefault()
      canvasWrap.classList.remove('drag-over')
      if (!this.paletteDragging || !this.paletteDragKind || !this.level) return
      const rect = this.canvas.getBoundingClientRect()
      const [wx, wy] = this.c2w(e.clientX - rect.left, e.clientY - rect.top)
      this.dropFromPalette(this.paletteDragKind, wx, wy)
    })

    // Keep ghost following cursor everywhere
    document.addEventListener('dragover', (e) => {
      if (this.paletteDragGhost) {
        this.paletteDragGhost.style.left = `${e.clientX}px`
        this.paletteDragGhost.style.top  = `${e.clientY}px`
      }
    })

    window.addEventListener('keydown', (e) => this.onKeyDown(e))

    // ── Sprite importer — opens sprite editor ──────────────────────────────
    document.getElementById('ed-pal-import-btn')!.addEventListener('click', () => {
      if (this.onOpenSpriteEditor) this.onOpenSpriteEditor()
    })
  }

  // ── View helpers ─────────────────────────────────────────────────────────────

  private w2c(wx: number, wy: number): [number, number] {
    return [
      (wx - this.viewLeft) * this.scale,
      this.canvas.height - (wy - this.viewBottom) * this.scale,
    ]
  }

  private c2w(cx: number, cy: number): [number, number] {
    return [
      cx / this.scale + this.viewLeft,
      (this.canvas.height - cy) / this.scale + this.viewBottom,
    ]
  }

  private onResize() {
    const wrap = this.canvas.parentElement!
    this.canvas.width  = wrap.clientWidth
    this.canvas.height = wrap.clientHeight
    this.render()
  }

  /** Compute world bounds from current elements (with padding). Falls back to defaults if empty.
   *  If the user has set custom bounds, those override the auto-computed values. */
  private worldBounds(): { left: number; right: number; bottom: number; top: number } {
    if (this.customBounds) return { ...this.customBounds }
    if (this.elements.length === 0) return { ...DEFAULT_WORLD }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const e of this.elements) {
      minX = Math.min(minX, e.x)
      maxX = Math.max(maxX, e.x + e.w)
      minY = Math.min(minY, e.y)
      maxY = Math.max(maxY, e.y + e.h)
    }
    const pad = 3
    return {
      left:   Math.floor(minX - pad),
      right:  Math.ceil(maxX + pad),
      bottom: Math.floor(minY - pad),
      top:    Math.ceil(maxY + pad),
    }
  }

  private fitWorld() {
    const wb = this.worldBounds()
    const ww = wb.right - wb.left
    const wh = wb.top - wb.bottom
    const pad = 0.06
    const sx = (this.canvas.width  * (1 - pad * 2)) / ww
    const sy = (this.canvas.height * (1 - pad * 2)) / wh
    this.scale = Math.min(sx, sy)
    this.viewLeft   = wb.left - (this.canvas.width  / this.scale - ww) / 2
    this.viewBottom = wb.bottom - (this.canvas.height / this.scale - wh) / 2
  }

  // Zoom to approx. game camera view: ~21.3 world units wide at centre of world
  private zoomToGame() {
    const wb = this.worldBounds()
    const GAME_VIEW_UNITS = 21.3   // 32 / baseZoom(1.5)
    this.scale = this.canvas.width / GAME_VIEW_UNITS
    const worldMidX = (wb.left + wb.right) / 2
    const worldMidY = (wb.bottom + wb.top) / 2
    this.viewLeft   = worldMidX - this.canvas.width  / this.scale / 2
    this.viewBottom = worldMidY - this.canvas.height / this.scale / 2
  }

  // ── Mode selection ────────────────────────────────────────────────────────────

  private setMode(m: Mode) {
    this.mode = m
    this.modeBtns.forEach((btn, key) => btn.classList.toggle('active', key === m))
    if (m !== 'select') { this.selectedIdx = null; this.selectedSet.clear(); this.updateElemInfo() }
    this.canvas.style.cursor = m === 'erase' ? 'not-allowed' : 'default'
    this.render()
  }

  // ── Palette drop ──────────────────────────────────────────────────────────────

  private dropFromPalette(kind: ElementKind, wx: number, wy: number) {
    const [dw, dh] = this.kindSize(kind)
    const x = snapV(wx - dw / 2)
    const y = snapV(wy - dh / 2)
    // Only one Trogg allowed per level
    if (kind === 'monster') {
      const ei = this.elements.findIndex((el) => el.kind === kind)
      if (ei >= 0) { this.commitEdit(); this.elements.splice(ei, 1) }
    }
    this.placeElement(kind, x, y, dw, dh)
    this.setMode('select')
    this.render()
  }

  // ── Level management ──────────────────────────────────────────────────────────

  private async refreshLevelPicker() {
    const sel = this.levelSelectEl
    sel.innerHTML = ''

    // Built-in group
    const builtinGrp = document.createElement('optgroup')
    builtinGrp.label = 'Built-in'
    for (let i = 0; i < builtinLevels.length; i++) {
      const opt = document.createElement('option')
      opt.value = `builtin-${i + 1}`
      opt.textContent = builtinLevels[i].name || `Level ${i + 1} (built-in)`
      builtinGrp.appendChild(opt)
    }
    sel.appendChild(builtinGrp)

    // Custom group
    const customs = loadCustomLevels()
    if (customs.length > 0) {
      const customGrp = document.createElement('optgroup')
      customGrp.label = 'Custom'
      for (const lf of customs) {
        const opt = document.createElement('option')
        opt.value = lf.id
        opt.textContent = lf.name || lf.id
        customGrp.appendChild(opt)
      }
      sel.appendChild(customGrp)
    }

    if (this.level) sel.value = this.level.id
  }

  private async selectLevel(id: string) {
    if (id.startsWith('builtin-')) {
      const n = parseInt(id.split('-')[1])
      await this.loadBuiltin(n)
    } else {
      const lf = loadCustomLevels().find((l) => l.id === id)
      if (lf) this.applyLevel(lf)
    }
  }

  private async loadBuiltin(n: number) {
    // Start with bundled built-in level
    let lf = builtinLevels[n - 1]
    // Then try public/ override (editor-saved or user-placed file)
    try {
      const resp = await fetch(`/levels/${n}.json`, { cache: 'no-store' })
      if (resp.ok) lf = (await resp.json()) as LevelFile
    } catch { /* no override — keep bundled */ }
    if (lf) this.applyLevel(lf)
  }

  private applyLevel(lf: LevelFile) {
    this.level = { ...lf }
    this.elements = levelToElements(lf)
    this.customBounds = lf.worldBounds ? { ...lf.worldBounds } : null
    this.selectedIdx = null
    this.selectedSet.clear()
    this.nameInput.value = lf.name
    this.timeLimitInput.value = String(lf.timeLimit ?? 120)

    // Resolve custom bg/music by filename (index may shift if files were added/removed)
    if (lf.customBg) {
      const idx = this.customBgFiles.indexOf(lf.customBg)
      if (idx >= 0) { lf.backgroundIndex = 100 + idx; this.level.backgroundIndex = 100 + idx }
    }
    if (lf.customMusic) {
      const idx = this.customMusicFiles.indexOf(lf.customMusic)
      if (idx >= 0) { lf.musicTrack = 100 + idx; this.level.musicTrack = 100 + idx }
    }

    this.musicSelect.value = String(lf.musicTrack)
    this.bgSelect.value = String(lf.backgroundIndex)
    this.updateMusicDeleteBtn()
    this.updateBgDeleteBtn()
    this.updateBgColorPicker()
    this.updateBgThumbnail()
    this.stopMusicPreview()
    this.levelSelectEl.value = lf.id
    this.undoStack = []
    this.zoomToGame()
    this.updateElemInfo()
    this.updateCount()
    this.rebuildHazardToggles()
    this.render()
    this.delLevelBtn.style.display = lf.id.startsWith('builtin-') ? 'none' : ''
  }

  private createNewLevel() {
    const id = `custom-${Date.now()}`
    const lf: LevelFile = {
      id,
      name: 'New Level',
      musicTrack: 1,
      backgroundIndex: 0,
      playerStart: [2.5, 4.55],
      platforms: [],
      ladders: [],
      monsters: [],
      keys: [],
      bulbs: [],
      treasures: [],
      exit: null,
    }
    const customs = loadCustomLevels()
    customs.push(lf)
    saveCustomLevels(customs)
    this.refreshLevelPicker()
    this.applyLevel(lf)
  }

  private deleteCurrentLevel() {
    if (!this.level || this.level.id.startsWith('builtin-')) return
    if (!confirm(`Delete level "${this.level.name}"?`)) return
    const customs = loadCustomLevels().filter((l) => l.id !== this.level!.id)
    saveCustomLevels(customs)
    this.level = null
    this.refreshLevelPicker()
    this.loadBuiltin(1)
  }

  private saveCurrentCustom() {
    if (!this.level) return
    // Sync custom bounds into level before saving
    this.level.worldBounds = this.customBounds ? { ...this.customBounds } : undefined
    const saved = elementsToLevel(this.level, this.elements, this.customSprites)
    if (this.level.id.startsWith('builtin-')) {
      // Save built-in level override to public/levels/ via dev server API
      const n = parseInt(this.level.id.split('-')[1])
      fetch(`/__save_level/${n}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(saved, null, 2),
      }).catch(() => { /* save failed — dev server may not support it */ })
      return
    }
    // Custom level → save to localStorage AND to public/levels/ via dev server
    const customs = loadCustomLevels()
    const idx = customs.findIndex((l) => l.id === this.level!.id)
    if (idx >= 0) customs[idx] = saved
    else customs.push(saved)
    saveCustomLevels(customs)
    // Also persist to disk via dev server
    const safeFilename = this.level.id.replace(/[^a-zA-Z0-9_-]/g, '_')
    fetch(`/__save_level/${safeFilename}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(saved, null, 2),
    }).catch(() => { /* save failed — dev server may not support it */ })
  }

  // ── Custom background/music asset management ──────────────────────────────

  async refreshCustomAssetLists() {
    try {
      const [bgResp, musicResp] = await Promise.all([
        fetch('/__asset_list/background'),
        fetch('/__asset_list/music'),
      ])
      this.customBgFiles = bgResp.ok ? await bgResp.json() : []
      this.customMusicFiles = musicResp.ok ? await musicResp.json() : []
    } catch {
      this.customBgFiles = []
      this.customMusicFiles = []
    }
    this.rebuildBgSelect()
    this.rebuildMusicSelect()
  }

  private rebuildBgSelect() {
    const sel = this.bgSelect
    const prev = sel.value
    sel.innerHTML = ''
    // Built-in options
    const builtinOpts = [
      { value: '0', label: 'Level 1' },
      { value: '1', label: 'Level 2' },
      { value: '2', label: 'Level 3' },
      { value: '-1', label: 'None (colour)' },
    ]
    for (const o of builtinOpts) {
      const opt = document.createElement('option')
      opt.value = o.value; opt.textContent = o.label
      sel.appendChild(opt)
    }
    // Custom backgrounds
    if (this.customBgFiles.length > 0) {
      const grp = document.createElement('optgroup')
      grp.label = 'Custom'
      this.customBgFiles.forEach((f, i) => {
        const opt = document.createElement('option')
        opt.value = String(100 + i); opt.textContent = f
        grp.appendChild(opt)
      })
      sel.appendChild(grp)
    }
    sel.value = prev
    this.updateBgDeleteBtn()
  }

  private rebuildMusicSelect() {
    const sel = this.musicSelect
    const prev = sel.value
    sel.innerHTML = ''
    const builtinOpts = [
      { value: '1', label: 'Level 1' },
      { value: '2', label: 'Level 2' },
      { value: '3', label: 'Level 3' },
      { value: '0', label: 'Title' },
    ]
    for (const o of builtinOpts) {
      const opt = document.createElement('option')
      opt.value = o.value; opt.textContent = o.label
      sel.appendChild(opt)
    }
    if (this.customMusicFiles.length > 0) {
      const grp = document.createElement('optgroup')
      grp.label = 'Custom'
      this.customMusicFiles.forEach((f, i) => {
        const opt = document.createElement('option')
        opt.value = String(100 + i); opt.textContent = f
        grp.appendChild(opt)
      })
      sel.appendChild(grp)
    }
    sel.value = prev
    this.updateMusicDeleteBtn()
  }

  private updateBgDeleteBtn() {
    const val = parseInt(this.bgSelect.value)
    this.bgDeleteBtn.style.display = val >= 100 ? '' : 'none'
  }

  private updateBgColorPicker() {
    const isNone = parseInt(this.bgSelect.value) === -1
    this.bgColorRow.style.display = isNone ? 'flex' : 'none'
    if (isNone && this.level) {
      this.bgColorInput.value = this.level.bgColor ?? '#00d8d8'
    }
  }

  private updateMusicDeleteBtn() {
    const val = parseInt(this.musicSelect.value)
    this.musicDeleteBtn.style.display = val >= 100 ? '' : 'none'
  }

  private updateBgThumbnail() {
    const val = parseInt(this.bgSelect.value)
    if (val >= 0 && val < 100 && builtinBgUrls[val]) {
      this.bgThumb.src = builtinBgUrls[val]
      this.bgThumb.style.display = ''
    } else if (val >= 100) {
      const idx = val - 100
      const filename = this.customBgFiles[idx]
      if (filename) {
        this.bgThumb.src = `/background/${filename}`
        this.bgThumb.style.display = ''
      } else {
        this.bgThumb.style.display = 'none'
      }
    } else {
      this.bgThumb.style.display = 'none'
    }
  }

  private toggleMusicPreview() {
    if (this.previewAudio) {
      this.stopMusicPreview()
      return
    }
    const val = parseInt(this.musicSelect.value)
    let url: string | null = null
    if (val >= 0 && val < 100 && builtinMp3Urls[val] !== undefined) {
      url = builtinMp3Urls[val]
    } else if (val >= 100) {
      const idx = val - 100
      const filename = this.customMusicFiles[idx]
      if (filename) url = `/music/${filename}`
    }
    if (!url) return
    const a = new Audio(url)
    a.loop = true
    a.volume = 0.5
    a.play().catch(() => { /* user gesture required */ })
    this.previewAudio = a
    this.musicPreviewBtn.textContent = '⏹'
    this.musicPreviewBtn.title = 'Stop preview'
  }

  private stopMusicPreview() {
    if (this.previewAudio) {
      this.previewAudio.pause()
      this.previewAudio.src = ''
      this.previewAudio = null
    }
    this.musicPreviewBtn.textContent = '▶'
    this.musicPreviewBtn.title = 'Preview music'
  }

  private uploadCustomAsset(type: 'background' | 'music') {
    const accept = type === 'background' ? 'image/png,image/jpeg,image/webp' : 'audio/mpeg,audio/ogg,.vgz'
    const input = document.createElement('input')
    input.type = 'file'; input.accept = accept
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      // Sanitize filename: keep alphanumeric, dash, underscore, dot
      const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')
      try {
        const resp = await fetch(`/__asset_save/${type}/${safeName}`, {
          method: 'POST',
          body: file,
        })
        if (!resp.ok) { alert(`Upload failed: ${await resp.text()}`); return }
        await this.refreshCustomAssetLists()
        // Auto-select the newly uploaded item
        const list = type === 'background' ? this.customBgFiles : this.customMusicFiles
        const idx = list.indexOf(safeName)
        if (idx >= 0 && this.level) {
          const val = 100 + idx
          if (type === 'background') {
            this.bgSelect.value = String(val)
            this.level.backgroundIndex = val
            this.level.customBg = safeName
            this.updateBgDeleteBtn()
            this.updateBgThumbnail()
          } else {
            this.musicSelect.value = String(val)
            this.level.musicTrack = val
            this.level.customMusic = safeName
            this.updateMusicDeleteBtn()
            this.stopMusicPreview()
          }
          this.saveCurrentCustom()
        }
      } catch (e) { alert(`Upload error: ${e}`) }
    })
    input.click()
  }

  private async deleteCustomAsset(type: 'background' | 'music') {
    const sel = type === 'background' ? this.bgSelect : this.musicSelect
    const val = parseInt(sel.value)
    if (val < 100) return
    const idx = val - 100
    const list = type === 'background' ? this.customBgFiles : this.customMusicFiles
    const filename = list[idx]
    if (!filename || !confirm(`Delete custom ${type} "${filename}"?`)) return
    try {
      await fetch(`/__asset_delete/${type}/${filename}`, { method: 'DELETE' })
    } catch { /* ignore */ }
    await this.refreshCustomAssetLists()
    // Reset to default
    if (this.level) {
      if (type === 'background') {
        this.level.backgroundIndex = 0
        delete this.level.customBg
        this.bgSelect.value = '0'
        this.updateBgDeleteBtn()
        this.updateBgThumbnail()
      } else {
        this.level.musicTrack = 1
        delete this.level.customMusic
        this.musicSelect.value = '1'
        this.updateMusicDeleteBtn()
        this.stopMusicPreview()
      }
      this.saveCurrentCustom()
    }
  }

  private commitEdit() {
    // Push undo snapshot before mutating (deep-clone attrs)
    this.undoStack.push(this.elements.map((e) => ({ ...e, attrs: e.attrs ? { ...e.attrs } : undefined })))
    if (this.undoStack.length > 50) this.undoStack.shift()
    this.saveCurrentCustom()
  }

  private undo() {
    const snap = this.undoStack.pop()
    if (!snap) return
    this.elements = snap
    this.selectedIdx = null
    this.selectedSet.clear()
    this.updateElemInfo()
    this.updateCount()
    this.saveCurrentCustom()
    this.render()
  }

  private exportJson() {
    if (!this.level) return
    const out = elementsToLevel(this.level, this.elements, this.customSprites)
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${out.name.replace(/\s+/g, '-').toLowerCase() || 'level'}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
  }

  private async exportZip() {
    if (!this.level) return
    const out = elementsToLevel(this.level, this.elements, this.customSprites)
    const zip = new JSZip()
    zip.file('level.json', JSON.stringify(out, null, 2))

    // Include any sprite.json overrides from public/sprites/
    try {
      const resp = await fetch('/__sprite_index', { cache: 'no-store' })
      if (resp.ok) {
        const files = (await resp.json()) as string[]
        await Promise.all(files.map(async (filePath) => {
          try {
            const r = await fetch(`/__read_sprite/${encodeURIComponent(filePath)}`, { cache: 'no-store' })
            if (r.ok) zip.file(`sprites/${filePath}`, await r.text())
          } catch { /* skip */ }
        }))
      }
    } catch { /* no sprite index — export without sprites */ }

    const blob = await zip.generateAsync({ type: 'blob' })
    const name = out.name.replace(/\s+/g, '-').toLowerCase() || 'level'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
  }

  private importFile(e: InputEvent & { target: HTMLInputElement }) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.name.endsWith('.zip')) {
      this.importZip(file)
    } else {
      this.importJson(file)
    }
    e.target.value = ''
  }

  private importJson(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const lf = JSON.parse(reader.result as string) as LevelFile
        this.applyImportedLevel(lf, file.name)
      } catch {
        alert('Could not parse JSON file.')
      }
    }
    reader.readAsText(file)
  }

  private async importZip(file: File) {
    try {
      const zip = await JSZip.loadAsync(file)
      const levelFile = zip.file('level.json')
      if (!levelFile) { alert('ZIP does not contain level.json'); return }
      const text = await levelFile.async('string')
      const lf = JSON.parse(text) as LevelFile
      this.applyImportedLevel(lf, file.name)

      // Save any sprites/ overrides to the dev server
      const spriteFiles = Object.keys(zip.files).filter(f => f.startsWith('sprites/') && f.endsWith('sprite.json'))
      for (const sf of spriteFiles) {
        const data = await zip.file(sf)!.async('string')
        const spritePath = sf.slice('sprites/'.length) // e.g. "enemies/hooter/idle/sprite.json"
        try {
          await fetch(`/__save_sprite/${encodeURIComponent(spritePath)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: data,
          })
        } catch { /* skip failed sprite save */ }
      }
    } catch {
      alert('Could not read ZIP file.')
    }
  }

  private applyImportedLevel(lf: LevelFile, filename: string) {
    if (!lf.id) lf.id = `custom-${Date.now()}`
    if (!lf.name) lf.name = filename.replace(/\.(json|zip)$/, '')
    lf.platforms  ??= []
    lf.ladders    ??= []
    lf.monsters   ??= []
    lf.keys       ??= []
    lf.bulbs      ??= []
    lf.treasures  ??= []
    lf.playerStart ??= [2.5, 4.55]
    const customs = loadCustomLevels()
    const existing = customs.findIndex((l) => l.id === lf.id)
    if (existing >= 0) customs[existing] = lf
    else customs.push(lf)
    saveCustomLevels(customs)
    this.refreshLevelPicker()
    this.applyLevel(lf)
  }

  private doDryRun() {
    if (!this.level) return
    const out = elementsToLevel(this.level, this.elements, this.customSprites)
    this.onDryRun?.(out)
  }

  // ── Hit testing ───────────────────────────────────────────────────────────────

  private hitTest(wx: number, wy: number): number {
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const e = this.elements[i]
      if (wx >= e.x && wx <= e.x + e.w && wy >= e.y && wy <= e.y + e.h) return i
    }
    return -1
  }

  private nearResizeEdge(wx: number, wy: number, el: EdElement): 'left' | 'right' | 'top' | 'bottom' | null {
    const THRESH = 6 / this.scale
    const nearLeft   = Math.abs(wx - el.x)         < THRESH && wy >= el.y && wy <= el.y + el.h
    const nearRight  = Math.abs(wx - (el.x + el.w)) < THRESH && wy >= el.y && wy <= el.y + el.h
    const nearBottom = Math.abs(wy - el.y)         < THRESH && wx >= el.x && wx <= el.x + el.w
    const nearTop    = Math.abs(wy - (el.y + el.h)) < THRESH && wx >= el.x && wx <= el.x + el.w
    // Corner: pick whichever axis is closer
    const edges: Array<{ edge: 'left' | 'right' | 'top' | 'bottom'; dist: number }> = []
    if (nearLeft)   edges.push({ edge: 'left',   dist: Math.abs(wx - el.x) })
    if (nearRight)  edges.push({ edge: 'right',  dist: Math.abs(wx - (el.x + el.w)) })
    if (nearBottom) edges.push({ edge: 'bottom', dist: Math.abs(wy - el.y) })
    if (nearTop)    edges.push({ edge: 'top',    dist: Math.abs(wy - (el.y + el.h)) })
    if (edges.length === 0) return null
    edges.sort((a, b) => a.dist - b.dist)
    return edges[0].edge
  }

  /** Detect if cursor is near a world-border edge (for dragging bounds). */
  private nearBoundsEdge(wx: number, wy: number): 'left' | 'right' | 'top' | 'bottom' | null {
    const wb = this.worldBounds()
    const THRESH = 6 / this.scale
    const inY = wy >= wb.bottom - THRESH && wy <= wb.top + THRESH
    const inX = wx >= wb.left - THRESH && wx <= wb.right + THRESH
    const edges: Array<{ edge: 'left' | 'right' | 'top' | 'bottom'; dist: number }> = []
    if (Math.abs(wx - wb.left)  < THRESH && inY) edges.push({ edge: 'left',   dist: Math.abs(wx - wb.left) })
    if (Math.abs(wx - wb.right) < THRESH && inY) edges.push({ edge: 'right',  dist: Math.abs(wx - wb.right) })
    if (Math.abs(wy - wb.bottom) < THRESH && inX) edges.push({ edge: 'bottom', dist: Math.abs(wy - wb.bottom) })
    if (Math.abs(wy - wb.top)    < THRESH && inX) edges.push({ edge: 'top',    dist: Math.abs(wy - wb.top) })
    if (edges.length === 0) return null
    edges.sort((a, b) => a.dist - b.dist)
    return edges[0].edge
  }

  // ── Editing helpers ───────────────────────────────────────────────────────────

  private placeElement(kind: ElementKind, x: number, y: number, w: number, h: number) {
    this.commitEdit()
    this.elements.push({ kind, x, y, w, h })
    this.selectedIdx = this.elements.length - 1
    this.updateElemInfo()
    this.updateCount()
    this.saveCurrentCustom()
  }

  private deleteSelected() {
    if (this.selectedSet.size > 1) {
      this.commitEdit()
      // Delete indices in descending order to avoid index shift issues
      const sorted = [...this.selectedSet].sort((a, b) => b - a)
      for (const idx of sorted) this.elements.splice(idx, 1)
      this.selectedSet.clear()
      this.selectedIdx = null
      this.updateElemInfo()
      this.updateCount()
      this.saveCurrentCustom()
      this.render()
      return
    }
    if (this.selectedIdx === null) return
    this.commitEdit()
    this.elements.splice(this.selectedIdx, 1)
    this.selectedIdx = null
    this.selectedSet.clear()
    this.updateElemInfo()
    this.updateCount()
    this.saveCurrentCustom()
    this.render()
  }

  // ── Mouse events ──────────────────────────────────────────────────────────────

  private onMouseDown(e: MouseEvent) {
    if (!this.level) return
    const [wx, wy] = this.c2w(e.offsetX, e.offsetY)

    // RMB or Alt+LMB → pan
    if (e.button === 2 || (e.button === 0 && e.altKey)) {
      this.dragMode = 'pan'
      this.panOrigin = { cx: e.offsetX, cy: e.offsetY, vl: this.viewLeft, vb: this.viewBottom }
      this.dragging = true
      this.canvas.style.cursor = 'grabbing'
      return
    }
    if (e.button !== 0) return

    if (this.mode === 'erase') {
      const idx = this.hitTest(wx, wy)
      if (idx >= 0) {
        this.commitEdit()
        this.elements.splice(idx, 1)
        if (this.selectedIdx === idx) this.selectedIdx = null
        else if (this.selectedIdx !== null && this.selectedIdx > idx) this.selectedIdx--
        // Rebuild selectedSet after splice
        const updated = new Set<number>()
        for (const si of this.selectedSet) {
          if (si === idx) continue
          updated.add(si > idx ? si - 1 : si)
        }
        this.selectedSet = updated
        this.updateElemInfo()
        this.updateCount()
        this.saveCurrentCustom()
        this.render()
      }
      return
    }

    // Select mode — check resize edge first (single-selection only)
    if (this.selectedIdx !== null && this.selectedSet.size <= 1) {
      const sel = this.elements[this.selectedIdx]
      if (isResizable(sel.kind)) {
        const edge = this.nearResizeEdge(wx, wy, sel)
        if (edge) {
          this.resizingIdx = this.selectedIdx
          this.resizeEdge = edge
          this.resizeOrigin = { x: sel.x, y: sel.y, w: sel.w, h: sel.h, ex: wx, ey: wy }
          this.commitEdit()
          return
        }
      }
    }

    // Check world-border edge drag (before element hit test so we can still grab it)
    if (this.mode === 'select') {
      const bEdge = this.nearBoundsEdge(wx, wy)
      if (bEdge) {
        // Initialise customBounds from current effective bounds if not already set
        if (!this.customBounds) this.customBounds = this.worldBounds()
        this.boundsDragEdge = bEdge
        this.dragging = true
        return
      }
    }

    const idx = this.hitTest(wx, wy)
    if (idx >= 0) {
      if (e.shiftKey) {
        // Shift+click: toggle in selection set
        if (this.selectedSet.has(idx)) {
          this.selectedSet.delete(idx)
          if (this.selectedIdx === idx) this.selectedIdx = this.selectedSet.size > 0 ? [...this.selectedSet][this.selectedSet.size - 1] : null
        } else {
          this.selectedSet.add(idx)
          this.selectedIdx = idx
        }
        this.updateElemInfo()
        this.render()
        return
      }
      // If clicking an element already in the multi-selection, start multi-move
      if (this.selectedSet.has(idx) && this.selectedSet.size > 1) {
        this.selectedIdx = idx
        this.dragWorldStart = [wx, wy]
        this.dragMode = 'move'
        this.dragging = true
        this.multiMoveOrigins = new Map()
        for (const si of this.selectedSet) {
          const sel = this.elements[si]
          this.multiMoveOrigins.set(si, { x: sel.x, y: sel.y })
        }
        this.canvas.style.cursor = 'grabbing'
      } else {
        // Single click on element — clear multi-selection, select just this one
        this.selectedIdx = idx
        this.selectedSet.clear()
        this.selectedSet.add(idx)
        const el = this.elements[idx]
        this.moveOrigin = { x: el.x, y: el.y }
        this.dragWorldStart = [wx, wy]
        this.dragMode = 'move'
        this.dragging = true
        this.canvas.style.cursor = 'grabbing'
      }
    } else {
      // Click on empty space — start marquee selection
      if (!e.shiftKey) {
        this.selectedIdx = null
        this.selectedSet.clear()
      }
      this.marqueeStart = [wx, wy]
      this.marqueeEnd = [wx, wy]
      this.dragging = true
      this.dragMode = 'move' // reuse dragging flag; marqueeStart distinguishes
    }
    this.updateElemInfo()
    this.render()
  }

  private onMouseMove(e: MouseEvent) {
    const [wx, wy] = this.c2w(e.offsetX, e.offsetY)
    this.statusPos.textContent = `x:${wx.toFixed(2)} y:${wy.toFixed(2)}`

    // Resize drag
    if (this.resizingIdx !== null && this.resizeOrigin) {
      const el = this.elements[this.resizingIdx]
      const o = this.resizeOrigin
      const cs = this.customSpriteById.get(el.kind)
      const isHTile = tilesH(el.kind) || cs?.tiling === 'h'
      const isVTile = tilesV(el.kind) || cs?.tiling === 'v'
      // For tiling elements, snap to multiples of the tile's world-unit size
      // so tiles always align cleanly. Built-in snaps by tile aspect; custom
      // respects the snapUnit setting.
      const snapW = (v: number) => {
        if (isHTile) {
          const tw = this.tileSpriteW(el.kind) * el.h
          return Math.max(tw, Math.round(v / tw) * tw)
        }
        if (cs?.snapUnit === 'tile') {
          return Math.max(cs.hitboxW, Math.round(v / cs.hitboxW) * cs.hitboxW)
        }
        return Math.max(SNAP, snapV(v))
      }
      const snapH = (v: number) => {
        if (isVTile) {
          const th = this.tileSpriteH(el.kind) * el.w
          return Math.max(th, Math.round(v / th) * th)
        }
        if (cs?.snapUnit === 'tile') {
          return Math.max(cs.hitboxH, Math.round(v / cs.hitboxH) * cs.hitboxH)
        }
        return Math.max(SNAP, snapV(v))
      }
      if (this.resizeEdge === 'right') {
        el.w = snapW(o.w + (wx - o.ex))
      } else if (this.resizeEdge === 'left') {
        const rawW = o.w + o.x - snapV(o.x + (wx - o.ex))
        const newW = snapW(rawW)
        const newX = o.x + o.w - newW
        if (newW >= SNAP) { el.x = newX; el.w = newW }
      } else if (this.resizeEdge === 'top') {
        el.h = snapH(o.h + (wy - o.ey))
      } else if (this.resizeEdge === 'bottom') {
        const rawH = o.h + o.y - snapV(o.y + (wy - o.ey))
        const newH = snapH(rawH)
        const newY = o.y + o.h - newH
        if (newH >= SNAP) { el.y = newY; el.h = newH }
      }
      this.updateElemInfo()
      this.render()
      return
    }

    // Bounds edge drag
    if (this.boundsDragEdge && this.customBounds) {
      const edge = this.boundsDragEdge
      const cb = this.customBounds
      const snapped = Math.round(edge === 'left' || edge === 'right' ? wx : wy)
      // Prevent inverted bounds (min 2 units between opposite edges)
      if (edge === 'left'  && snapped >= cb.right  - 2) return
      if (edge === 'right' && snapped <= cb.left   + 2) return
      if (edge === 'bottom' && snapped >= cb.top   - 2) return
      if (edge === 'top'    && snapped <= cb.bottom + 2) return
      cb[edge] = snapped
      this.render()
      return
    }

    if (!this.dragging) {
      if (this.mode === 'select') {
        if (this.selectedIdx !== null && this.selectedSet.size <= 1) {
          const sel = this.elements[this.selectedIdx]
          if (sel && isResizable(sel.kind)) {
            const edge = this.nearResizeEdge(wx, wy, sel)
            if (edge === 'left' || edge === 'right') { this.canvas.style.cursor = 'ew-resize'; return }
            if (edge === 'top'  || edge === 'bottom') { this.canvas.style.cursor = 'ns-resize'; return }
          }
        }
        // Check for bounds edge hover
        const bEdge = this.nearBoundsEdge(wx, wy)
        if (bEdge === 'left' || bEdge === 'right')  { this.canvas.style.cursor = 'ew-resize'; return }
        if (bEdge === 'top'  || bEdge === 'bottom') { this.canvas.style.cursor = 'ns-resize'; return }
        this.canvas.style.cursor = this.hitTest(wx, wy) >= 0 ? 'grab' : 'default'
      }
      return
    }

    if (this.dragMode === 'pan' && this.panOrigin) {
      const dx = (e.offsetX - this.panOrigin.cx) / this.scale
      const dy = (e.offsetY - this.panOrigin.cy) / this.scale
      this.viewLeft   = this.panOrigin.vl - dx
      this.viewBottom = this.panOrigin.vb + dy
      this.render()
      return
    }

    // Marquee drag
    if (this.marqueeStart) {
      this.marqueeEnd = [wx, wy]
      this.render()
      return
    }

    // Multi-move drag
    if (this.multiMoveOrigins && this.selectedSet.size > 1) {
      const dx = snapV(wx - this.dragWorldStart[0])
      const dy = snapV(wy - this.dragWorldStart[1])
      for (const [si, orig] of this.multiMoveOrigins) {
        const el = this.elements[si]
        el.x = snapV(orig.x + dx)
        el.y = snapV(orig.y + dy)
      }
      this.updateElemInfo()
      this.render()
      return
    }

    if (this.dragMode === 'move' && this.selectedIdx !== null && this.moveOrigin) {
      const dx = snapV(wx - this.dragWorldStart[0])
      const dy = snapV(wy - this.dragWorldStart[1])
      const el = this.elements[this.selectedIdx]
      el.x = snapV(this.moveOrigin.x + dx)
      el.y = snapV(this.moveOrigin.y + dy)
      this.updateElemInfo()
      this.render()
    }
  }

  private onMouseUp(e: MouseEvent) {
    if (this.resizingIdx !== null) {
      this.resizingIdx = null
      this.resizeEdge = null
      this.resizeOrigin = null
      this.saveCurrentCustom()
      this.canvas.style.cursor = 'default'
      return
    }

    // Bounds edge drag finalize
    if (this.boundsDragEdge) {
      this.boundsDragEdge = null
      this.dragging = false
      this.saveCurrentCustom()
      this.canvas.style.cursor = 'default'
      this.render()
      return
    }

    // Marquee selection finalize
    if (this.marqueeStart && this.marqueeEnd) {
      const x0 = Math.min(this.marqueeStart[0], this.marqueeEnd[0])
      const x1 = Math.max(this.marqueeStart[0], this.marqueeEnd[0])
      const y0 = Math.min(this.marqueeStart[1], this.marqueeEnd[1])
      const y1 = Math.max(this.marqueeStart[1], this.marqueeEnd[1])
      // Only select if marquee has meaningful size (not just a click)
      if (x1 - x0 > 0.1 || y1 - y0 > 0.1) {
        if (!e.shiftKey) this.selectedSet.clear()
        for (let i = 0; i < this.elements.length; i++) {
          const el = this.elements[i]
          // Element overlaps marquee box
          if (el.x + el.w > x0 && el.x < x1 && el.y + el.h > y0 && el.y < y1) {
            this.selectedSet.add(i)
          }
        }
        this.selectedIdx = this.selectedSet.size > 0 ? [...this.selectedSet][this.selectedSet.size - 1] : null
      }
      this.marqueeStart = null
      this.marqueeEnd = null
      this.dragging = false
      this.updateElemInfo()
      this.render()
      return
    }

    // Multi-move finalize
    if (this.multiMoveOrigins && this.selectedSet.size > 1) {
      const [wx, wy] = this.c2w(e.offsetX, e.offsetY)
      const dx = snapV(wx - this.dragWorldStart[0])
      const dy = snapV(wy - this.dragWorldStart[1])
      for (const [si, orig] of this.multiMoveOrigins) {
        const el = this.elements[si]
        el.x = snapV(orig.x + dx)
        el.y = snapV(orig.y + dy)
      }
      this.multiMoveOrigins = null
      this.dragging = false
      this.moveOrigin = null
      this.saveCurrentCustom()
      this.canvas.style.cursor = 'grab'
      this.render()
      return
    }

    if (!this.dragging) return

    if (this.dragMode === 'move' && this.selectedIdx !== null && this.moveOrigin) {
      const [wx, wy] = this.c2w(e.offsetX, e.offsetY)
      const el = this.elements[this.selectedIdx]
      el.x = snapV(this.moveOrigin.x + snapV(wx - this.dragWorldStart[0]))
      el.y = snapV(this.moveOrigin.y + snapV(wy - this.dragWorldStart[1]))
      this.saveCurrentCustom()
      this.canvas.style.cursor = 'grab'
    } else {
      this.canvas.style.cursor = 'default'
    }

    this.dragging = false
    this.moveOrigin = null
    this.panOrigin = null
    this.render()
  }

  private onMouseLeave() {
    // intentionally left empty — keep drag alive if cursor re-enters
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.13 : 1 / 1.13
    const [wx, wy] = this.c2w(e.offsetX, e.offsetY)
    // Min scale = enough to see the whole world; max = ~120px/unit (very zoomed in)
    const wb = this.worldBounds()
    const ww = wb.right - wb.left
    const minScale = Math.min(
      (this.canvas.width  * 0.9) / ww,
      (this.canvas.height * 0.9) / (wb.top - wb.bottom),
    )
    this.scale = Math.max(minScale, Math.min(120, this.scale * factor))
    this.viewLeft   = wx - e.offsetX / this.scale
    this.viewBottom = wy - (this.canvas.height - e.offsetY) / this.scale
    this.render()
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.el.style.display === 'none') return
    const active = document.activeElement
    const isInput = active instanceof HTMLInputElement || active instanceof HTMLSelectElement
    if (isInput) return

    if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault()
      this.deleteSelected()
    }
    if (e.code === 'Escape') {
      this.selectedIdx = null
      this.selectedSet.clear()
      this.updateElemInfo()
      this.render()
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault()
      this.undo()
    }
    if (e.code === 'KeyF') { e.preventDefault(); this.fitWorld();    this.render() }
    if (e.code === 'Digit1') { e.preventDefault(); this.zoomToGame(); this.render() }
    // Reset custom world bounds back to auto-computed
    if (e.code === 'KeyB') {
      e.preventDefault()
      if (this.customBounds) {
        this.customBounds = null
        this.saveCurrentCustom()
        this.render()
      }
    }
  }

  // ── UI updates ────────────────────────────────────────────────────────────────

  private updateElemInfo() {
    const sizeSec = document.getElementById('ed-size-section')!
    if (this.selectedSet.size > 1) {
      this.elemInfoEl.textContent = ''
      const b = document.createElement('b')
      b.style.color = '#40c0ff'
      b.textContent = `${this.selectedSet.size} elements selected`
      this.elemInfoEl.appendChild(b)
      this.elemInfoEl.appendChild(document.createElement('br'))
      this.elemInfoEl.appendChild(document.createTextNode(
        'Shift+click to toggle \u2022 Drag to move all \u2022 Del to delete'))
      this.delElemBtn.style.display = ''
      sizeSec.style.display = 'none'
      this.attrsSection.style.display = 'none'
      this.spriteConfigSection.style.display = 'none'
      return
    }
    if (this.selectedIdx === null || !this.elements[this.selectedIdx]) {
      this.elemInfoEl.textContent = 'Nothing selected — drag from the left panel or click an element'
      this.delElemBtn.style.display = 'none'
      sizeSec.style.display = 'none'
      this.attrsSection.style.display = 'none'
      this.spriteConfigSection.style.display = 'none'
      return
    }
    const el = this.elements[this.selectedIdx]
    const c = this.kindColor(el.kind)
    this.elemInfoEl.textContent = ''
    const b = document.createElement('b')
    b.style.color = c.stroke
    b.textContent = `${c.icon} ${c.label}`
    this.elemInfoEl.appendChild(b)
    this.elemInfoEl.appendChild(document.createElement('br'))
    this.elemInfoEl.appendChild(document.createTextNode(
      `x: ${el.x.toFixed(2)}  y: ${el.y.toFixed(2)}`))
    this.elemInfoEl.appendChild(document.createElement('br'))
    this.elemInfoEl.appendChild(document.createTextNode(
      `w: ${el.w.toFixed(2)}  h: ${el.h.toFixed(2)}`))
    this.delElemBtn.style.display = ''
    const resizable = isResizable(el.kind)
    sizeSec.style.display = resizable ? '' : 'none'
    if (resizable) {
      this.widthInput.value  = el.w.toFixed(2)
      this.heightInput.value = el.h.toFixed(2)
    }
    this.buildAttrsPanel(el)
    this.buildSpriteConfigPanel(el)
  }

  private buildAttrsPanel(el: EdElement) {
    const defs = EDITABLE_ATTRS[el.kind]
    if (!defs || defs.length === 0) {
      this.attrsSection.style.display = 'none'
      this.attrsPanel.innerHTML = ''
      return
    }
    this.attrsSection.style.display = ''
    this.attrsPanel.innerHTML = ''
    if (!el.attrs) el.attrs = {}

    for (const def of defs) {
      const row = document.createElement('div')
      row.className = 'ed-attr-row'
      const lbl = document.createElement('label')
      lbl.textContent = def.label
      row.appendChild(lbl)

      const key = def.label.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/_$/, '')
      const curVal = el.attrs[key] ?? def.defaultValue

      if (def.type === 'select') {
        const sel = document.createElement('select')
        for (const opt of def.options) {
          const o = document.createElement('option')
          o.value = opt.value
          o.textContent = opt.label
          if (opt.value === String(curVal)) o.selected = true
          sel.appendChild(o)
        }
        sel.addEventListener('change', () => {
          this.commitEdit()
          el.attrs![key] = sel.value
          this.saveCurrentCustom()
        })
        row.appendChild(sel)
      } else if (def.type === 'number') {
        const inp = document.createElement('input')
        inp.type = 'number'
        inp.value = String(curVal)
        if (def.min !== undefined) inp.min = String(def.min)
        if (def.max !== undefined) inp.max = String(def.max)
        if (def.step !== undefined) inp.step = String(def.step)
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value)
          if (!isNaN(v)) {
            this.commitEdit()
            el.attrs![key] = v
            this.saveCurrentCustom()
          }
        })
        row.appendChild(inp)
      } else if (def.type === 'boolean') {
        const chk = document.createElement('input')
        chk.type = 'checkbox'
        chk.checked = Boolean(curVal)
        chk.addEventListener('change', () => {
          this.commitEdit()
          el.attrs![key] = chk.checked
          this.saveCurrentCustom()
        })
        row.appendChild(chk)
      }

      this.attrsPanel.appendChild(row)
    }
  }

  private buildSpriteConfigPanel(el: EdElement) {
    const kind = el.kind
    const entry = DEFAULT_SPRITE_MAP[kind]
    const cs = this.customSpriteById.get(kind)
    if (!entry && !cs) {
      this.spriteConfigSection.style.display = 'none'
      this.spriteConfigPanel.innerHTML = ''
      return
    }
    this.spriteConfigSection.style.display = ''
    this.spriteConfigPanel.innerHTML = ''
    if (!el.attrs) el.attrs = {}

    const makeRow = (label: string): HTMLDivElement => {
      const row = document.createElement('div')
      row.className = 'ed-attr-row'
      const lbl = document.createElement('label')
      lbl.textContent = label
      row.appendChild(lbl)
      return row
    }

    // Sprite path (read-only)
    const spritePath = entry?.sprite ?? (cs ? `custom/${cs.id}` : '')
    if (spritePath) {
      const row = makeRow('Sprite')
      const span = document.createElement('span')
      span.style.cssText = 'font-size:10px;opacity:0.7;word-break:break-all'
      span.textContent = spritePath
      row.appendChild(span)
      this.spriteConfigPanel.appendChild(row)
    }

    // Sprite Scale is handled by editableAttrs in sprite.json — no duplicate control needed.
  }

  private updateCount() {
    const counts: Record<string, number> = {}
    for (const e of this.elements) counts[e.kind] = (counts[e.kind] ?? 0) + 1
    this.statusCount.textContent = Object.entries(counts)
      .map(([k, v]) => `${k}:${v}`)
      .join('  ')
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────

  private render() {
    const ctx = this.ctx
    const W = this.canvas.width
    const H = this.canvas.height

    ctx.clearRect(0, 0, W, H)

    // Sky background
    ctx.fillStyle = '#071520'
    ctx.fillRect(0, 0, W, H)

    // World rectangle (content area)
    const wb = this.worldBounds()
    const [wx0, wy0] = this.w2c(wb.left,  wb.top)
    const [wx1, wy1] = this.w2c(wb.right, wb.bottom)
    ctx.fillStyle = '#0a1a2a'
    ctx.fillRect(wx0, wy0, wx1 - wx0, wy1 - wy0)

    this.drawGrid()

    for (let i = 0; i < this.elements.length; i++) {
      this.drawElement(this.elements[i], i === this.selectedIdx, this.selectedSet.has(i))
    }

    // Marquee selection rectangle
    if (this.marqueeStart && this.marqueeEnd) {
      const [sx, sy] = this.w2c(
        Math.min(this.marqueeStart[0], this.marqueeEnd[0]),
        Math.max(this.marqueeStart[1], this.marqueeEnd[1]),
      )
      const [ex, ey] = this.w2c(
        Math.max(this.marqueeStart[0], this.marqueeEnd[0]),
        Math.min(this.marqueeStart[1], this.marqueeEnd[1]),
      )
      ctx.save()
      ctx.strokeStyle = '#40c0ff'
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 3])
      ctx.strokeRect(sx, sy, ex - sx, ey - sy)
      ctx.fillStyle = 'rgba(64,192,255,0.08)'
      ctx.fillRect(sx, sy, ex - sx, ey - sy)
      ctx.restore()
    }

    // World border
    ctx.strokeStyle = this.customBounds ? '#30a0e0' : '#2060a0'
    ctx.lineWidth = this.customBounds ? 2 : 1.5
    ctx.strokeRect(wx0, wy0, wx1 - wx0, wy1 - wy0)

    // Drag handles on world border edges (small rectangles at midpoints)
    {
      const midX = (wx0 + wx1) / 2
      const midY = (wy0 + wy1) / 2
      const hw = 12  // handle half-width in px
      const hh = 4   // handle half-height in px
      ctx.fillStyle = this.customBounds ? '#30a0e0' : 'rgba(32,96,160,0.7)'
      // Left edge handle
      ctx.fillRect(wx0 - hh, midY - hw, hh * 2, hw * 2)
      // Right edge handle
      ctx.fillRect(wx1 - hh, midY - hw, hh * 2, hw * 2)
      // Top edge handle
      ctx.fillRect(midX - hw, wy0 - hh, hw * 2, hh * 2)
      // Bottom edge handle
      ctx.fillRect(midX - hw, wy1 - hh, hw * 2, hh * 2)
    }
  }

  private drawGrid() {
    const ctx = this.ctx
    const W = this.canvas.width
    const H = this.canvas.height

    const worldLeft   = this.viewLeft
    const worldRight  = this.viewLeft  + W / this.scale
    const worldBottom = this.viewBottom
    const worldTop    = this.viewBottom + H / this.scale

    const minor = 1
    const major = 4

    const sx = Math.floor(worldLeft   / minor) * minor
    const sy = Math.floor(worldBottom / minor) * minor

    // Minor grid lines
    ctx.strokeStyle = 'rgba(25,55,90,0.55)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let x = sx; x <= worldRight + minor; x += minor) {
      const [cx] = this.w2c(x, 0)
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
    }
    for (let y = sy; y <= worldTop + minor; y += minor) {
      const [, cy] = this.w2c(0, y)
      ctx.moveTo(0, cy); ctx.lineTo(W, cy)
    }
    ctx.stroke()

    // Major grid lines
    const msx = Math.floor(worldLeft   / major) * major
    const msy = Math.floor(worldBottom / major) * major
    ctx.strokeStyle = 'rgba(30,80,140,0.75)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = msx; x <= worldRight + major; x += major) {
      const [cx] = this.w2c(x, 0)
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
    }
    for (let y = msy; y <= worldTop + major; y += major) {
      const [, cy] = this.w2c(0, y)
      ctx.moveTo(0, cy); ctx.lineTo(W, cy)
    }
    ctx.stroke()

    // Coordinate labels at major intersections when zoomed in
    if (this.scale >= 10) {
      ctx.fillStyle = 'rgba(80,130,190,0.45)'
      ctx.font = `${Math.max(9, Math.min(11, this.scale * 0.35))}px monospace`
      ctx.textAlign = 'left'
      for (let x = msx; x <= worldRight + major; x += major) {
        for (let y = msy; y <= worldTop + major; y += major) {
          const [cx, cy] = this.w2c(x, y)
          ctx.fillText(`${x},${y}`, cx + 2, cy - 2)
        }
      }
    }
  }

  private drawElement(el: EdElement, selected: boolean, inSet = false) {
    const ctx = this.ctx
    const [cx, cy] = this.w2c(el.x, el.y + el.h)
    const pw = el.w * this.scale
    const ph = el.h * this.scale
    const c = this.kindColor(el.kind)

    ctx.save()
    ctx.globalAlpha = 0.82

    const csTiling = this.customSpriteById.get(el.kind)?.tiling
    if (tilesH(el.kind) || csTiling === 'h') {
      // Tile sprite horizontally across element width
      const img = this.edImgs[el.kind] ?? this.customSpriteImages.get(el.kind)
      if (img) {
        const tileH = ph
        const tileW = (img.naturalWidth / img.naturalHeight) * tileH
        const count = Math.ceil(pw / tileW)
        ctx.save()
        ctx.beginPath()
        ctx.rect(cx, cy, pw, ph)
        ctx.clip()
        for (let i = 0; i < count; i++) {
          ctx.drawImage(img, cx + i * tileW, cy, tileW, tileH)
        }
        ctx.restore()
      } else {
        ctx.fillStyle = c.fill
        ctx.fillRect(cx, cy, pw, ph)
      }
    } else if (tilesV(el.kind) || csTiling === 'v') {
      // Tile sprite vertically (bottom to top)
      const img = this.edImgs[el.kind] ?? this.customSpriteImages.get(el.kind)
      if (img) {
        const tileW = pw
        const tileH = (img.naturalHeight / img.naturalWidth) * tileW
        ctx.save()
        ctx.beginPath()
        ctx.rect(cx, cy, pw, ph)
        ctx.clip()
        let oy2 = cy + ph - tileH
        while (oy2 > cy - tileH) {
          ctx.drawImage(img, cx, oy2, tileW, tileH)
          oy2 -= tileH
        }
        ctx.restore()
      } else {
        ctx.fillStyle = c.fill
        ctx.fillRect(cx, cy, pw, ph)
      }
    } else {
      ctx.fillStyle = c.fill
      ctx.fillRect(cx, cy, pw, ph)
      // Draw sprite image if loaded (built-in or custom)
      const img = this.edImgs[el.kind] ?? this.customSpriteImages.get(el.kind)
      if (img) {
        ctx.globalAlpha = 0.92
        const sAspect = img.naturalWidth / img.naturalHeight
        let dw = pw, dh = ph
        if (sAspect > pw / ph) { dh = pw / sAspect } else { dw = ph * sAspect }
        const ox = cx + (pw - dw) / 2
        const oy = cy + (ph - dh) / 2
        ctx.drawImage(img, ox, oy, dw, dh)
      }
    }

    ctx.globalAlpha = 1

    // Outline
    const highlighted = selected || inSet
    ctx.strokeStyle = selected ? '#ffe040' : inSet ? '#40c0ff' : c.stroke
    ctx.lineWidth = highlighted ? 2 : 1
    ctx.strokeRect(cx, cy, pw, ph)

    // Emoji icon centred when big enough
    if (pw > 10 && ph > 8) {
      const fontSize = Math.max(8, Math.min(18, Math.min(pw, ph) * 0.55))
      ctx.font = `${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(c.icon, cx + pw / 2, cy + ph / 2)
    }

    // Edge resize handles for selected resizable element
    if (selected && isResizable(el.kind)) {
      ctx.fillStyle = '#ffe040'
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 1
      const r = 4
      // Right-edge mid handle (resize width)
      ctx.beginPath()
      ctx.arc(cx + pw, cy + ph / 2, r, 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
      // Left-edge mid handle (resize width)
      ctx.beginPath()
      ctx.arc(cx, cy + ph / 2, r, 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
      // Top-edge mid handle (resize height)
      ctx.beginPath()
      ctx.arc(cx + pw / 2, cy, r, 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
      // Bottom-edge mid handle (resize height)
      ctx.beginPath()
      ctx.arc(cx + pw / 2, cy + ph, r, 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
    }

    ctx.restore()
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  show() {
    this.el.style.display = 'flex'
    this.setMode('select')
    this.refreshCustomAssetLists()
    setTimeout(() => {
      this.onResize()
      this.refreshLevelPicker().then(() => {
        if (!this.level) this.loadBuiltin(1)
      })
    }, 16)
  }

  hide() {
    this.stopMusicPreview()
    this.el.style.display = 'none'
  }

  /** Re-load all sprite images (call after sprite editor changes). */
  reloadSprites() {
    this.edImgs = {}
    this.loadEditorSprites()
    this.loadCustomSpritesData()
  }

  private kindColor(kind: string): { fill: string; stroke: string; label: string; icon: string } {
    if (KIND_COLOR[kind]) return KIND_COLOR[kind]
    const cs = this.customSpriteById.get(kind)
    return cs
      ? { fill: cs.fill, stroke: cs.stroke, label: cs.label, icon: cs.icon }
      : { fill: '#303040', stroke: '#8090a0', label: kind, icon: '?' }
  }

  /** World-unit width of one tile for a horizontally-tiling kind, from sprite aspect ratio. */
  private tileSpriteW(kind: string): number {
    const img = this.edImgs[kind] ?? this.customSpriteImages.get(kind)
    if (img) return img.naturalWidth / img.naturalHeight
    return DEFAULT_SIZE[kind]?.[0] ?? this.customSpriteById.get(kind)?.hitboxW ?? 1.0
  }

  /** World-unit height of one tile for a vertically-tiling kind, from sprite aspect ratio. */
  private tileSpriteH(kind: string): number {
    const img = this.edImgs[kind] ?? this.customSpriteImages.get(kind)
    if (img) return img.naturalHeight / img.naturalWidth
    return DEFAULT_SIZE[kind]?.[1] ?? this.customSpriteById.get(kind)?.hitboxH ?? 1.0
  }

  private kindSize(kind: string): [number, number] {
    // For tiling kinds, use defaultSize for the fixed axis and derive the
    // tiling axis from the sprite's aspect ratio × that fixed axis so
    // exactly 1 complete tile is visible on placement.
    const cs = this.customSpriteById.get(kind)
    const ds = DEFAULT_SIZE[kind]
    if (tilesH(kind) || cs?.tiling === 'h') {
      const h = ds?.[1] ?? 1.0
      const tw = this.tileSpriteW(kind) * h  // tile width at this height
      return [Math.max(tw, tw * Math.round((ds?.[0] ?? tw) / tw)), h]
    }
    if (tilesV(kind) || cs?.tiling === 'v') {
      const w = ds?.[0] ?? 1.0
      const th = this.tileSpriteH(kind) * w  // tile height at this width
      return [w, Math.max(th, th * Math.round((ds?.[1] ?? th) / th))]
    }
    if (ds) return ds
    return cs ? [cs.hitboxW, cs.hitboxH] : [1.0, 1.0]
  }

  private rebuildCustomSpriteMap() {
    this.customSpriteById = new Map(this.customSprites.map(s => [s.id, s]))
  }

  private loadCustomSpritesData() {
    this.customSprites = loadCustomSprites()
    this.rebuildCustomSpriteMap()
    for (const cs of this.customSprites) {
      if (cs.frames.length > 0) {
        const img = new Image()
        img.onload = () => {
          this.customSpriteImages.set(cs.id, img)
          this.rebuildCustomPalette()
          this.render()
        }
        img.src = cs.frames[cs.iconFrame] ?? cs.frames[0]
      }
    }
    this.rebuildCustomPalette()
  }

  /** Rebuild the hazard on/off checkboxes in the RH panel from current spriteMap. */
  private rebuildHazardToggles() {
    const container = this.el.querySelector<HTMLDivElement>('#ed-hazard-toggles')
    if (!container) return
    container.innerHTML = ''
    if (!this.level) return
    // Collect all known hazard kinds from DEFAULT_SPRITE_MAP + custom hazard sprites
    const hazardKinds: { kind: string; label: string }[] = []
    for (const [kind, entry] of Object.entries(DEFAULT_SPRITE_MAP)) {
      if (entry.behavior.hazard) {
        const c = KIND_COLOR[kind]
        hazardKinds.push({ kind, label: c?.label ?? kind })
      }
    }
    for (const cs of this.customSprites) {
      if (cs.category === 'hazards') {
        hazardKinds.push({ kind: cs.id, label: cs.label })
      }
    }
    if (hazardKinds.length === 0) {
      container.innerHTML = '<span style="opacity:0.4">No hazards available</span>'
      return
    }
    const disabled = new Set(this.level.disabledHazards ?? [])
    for (const { kind, label } of hazardKinds) {
      const row = document.createElement('label')
      row.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !disabled.has(kind)
      cb.addEventListener('change', () => {
        if (!this.level) return
        const dis = new Set(this.level.disabledHazards ?? [])
        if (cb.checked) dis.delete(kind); else dis.add(kind)
        this.level.disabledHazards = dis.size > 0 ? [...dis] : undefined
        this.saveCurrentCustom()
      })
      row.appendChild(cb)
      row.appendChild(document.createTextNode(label))
      container.appendChild(row)
    }
  }

  private rebuildCustomPalette() {
    // Clear all category slots and the fallback container
    for (const cat of ['terrain', 'characters', 'items', 'hazards', 'obstacles']) {
      const slot = this.el.querySelector<HTMLDivElement>(`#ed-pal-custom-${cat}`)
      if (slot) slot.innerHTML = ''
    }
    const fallback = this.el.querySelector<HTMLDivElement>('#ed-pal-custom')
    if (fallback) fallback.innerHTML = ''

    for (const cs of this.customSprites) {
      const catSlot = cs.category
        ? this.el.querySelector<HTMLDivElement>(`#ed-pal-custom-${cs.category}`)
        : null
      const target = catSlot ?? fallback
      if (!target) continue

      const tile = document.createElement('div')
      tile.className = 'ed-pal-tile'
      tile.draggable = true
      tile.dataset.kind = cs.id
      tile.title = `Drag onto canvas  ·  ${cs.label}`
      tile.style.position = 'relative'
      const img = this.customSpriteImages.get(cs.id)
      if (img) {
        const cv = document.createElement('canvas')
        cv.className = 'ed-pal-sprite-cv'
        cv.width = 28; cv.height = 28
        const ctx2 = cv.getContext('2d')
        if (ctx2) {
          const a = img.naturalWidth / img.naturalHeight
          let sw = 28, sh = 28
          if (a > 1) { sh = sw / a } else { sw = sh * a }
          ctx2.drawImage(img, (28 - sw) / 2, (28 - sh) / 2, sw, sh)
        }
        tile.innerHTML = ''
        tile.appendChild(cv)
      } else {
        tile.innerHTML = `<div class="ed-pal-icon">${cs.icon}</div>`
      }
      const nameSpan = document.createElement('span')
      nameSpan.className = 'ed-pal-name'
      nameSpan.textContent = cs.label
      tile.appendChild(nameSpan)
      // Remove button
      const rm = document.createElement('button')
      rm.textContent = '×'
      rm.style.cssText = 'position:absolute;top:0;right:0;background:rgba(0,0,0,.6);color:#fff;border:none;cursor:pointer;font-size:0.7rem;padding:1px 3px;line-height:1;z-index:1'
      rm.onclick = (e) => {
        e.stopPropagation()
        this.customSprites = this.customSprites.filter(s => s.id !== cs.id)
        this.rebuildCustomSpriteMap()
        this.customSpriteImages.delete(cs.id)
        saveCustomSpritesToStorage(this.customSprites)
        this.rebuildCustomPalette()
      }
      tile.appendChild(rm)
      target.appendChild(tile)
    }
  }
}
