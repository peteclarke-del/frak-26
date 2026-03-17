/**
 * Sprite Editor — full-screen editor for viewing, editing, importing, and
 * exporting sprite configurations and frame data.
 *
 * Architecture mirrors LevelEditor: constructor → injectStyles → buildDOM →
 * bindEvents.  Opens as a full-screen overlay (z-index 210, above level editor).
 *
 * Persistence
 * -----------
 * Built-in sprite.json files live under src/assets/sprites/ and are loaded
 * at build time via import.meta.glob.  Overrides are saved to public/sprites/
 * via the Vite dev-server /__save_sprite/ endpoint; the game engine merges
 * these on top of the built-in defaults at runtime.
 *
 * Custom (user-imported) sprites are stored in localStorage under the
 * 'frak_custom_sprites' key, matching the existing level-editor convention.
 */

import JSZip from 'jszip'
import { loadCustomSprites, saveCustomSprites } from './custom-sprites'
import type { AnimMode, CustomSprite, SpriteCategory, ObstacleType, TilingMode, SnapUnit } from './custom-sprites'

// ── Types ────────────────────────────────────────────────────────────────────

interface SpriteConfig {
  kind: string
  role?: string
  group?: string
  action?: string
  tiling?: 'h' | 'v'
  animMode?: AnimMode
  spriteScale?: number
  fps?: number
  visual_w?: number
  visual_h?: number
  frameCount?: number
  frameOrder?: number[]
  behavior?: Record<string, unknown>
  editableAttrs?: unknown[]
  defaultSize?: [number, number]
  color?: { fill: string; stroke: string; label: string; icon: string }
}

// ── Load all sprite.json configs at build time ───────────────────────────────

import { spriteConfigModules, allSpritePngs as allPngModules } from './sprite-data'
import { DEFAULT_SPRITE_MAP, DEFAULT_SIZE, SPRITE_METADATA } from './level-editor'
const spriteConfigs = spriteConfigModules as unknown as Record<string, SpriteConfig>

// Build lookup: spritePath → SpriteConfig
interface SpriteEntry {
  /** Relative path like 'player/trogg/walk' */
  path: string
  config: SpriteConfig
  /** Resolved URLs for frame PNGs in sorted order */
  frameUrls: string[]
}

const ALL_SPRITES: SpriteEntry[] = []

for (const [jsonPath, cfg] of Object.entries(spriteConfigs)) {
  const dir = jsonPath.replace('./assets/sprites/', '').replace('/sprite.json', '')
  const prefix = jsonPath.replace('sprite.json', '')
  // Gather PNGs in this directory
  const pngs: { name: string; url: string }[] = []
  for (const [pngPath, url] of Object.entries(allPngModules)) {
    if (pngPath.startsWith(prefix) && !pngPath.slice(prefix.length).includes('/')) {
      pngs.push({ name: pngPath.split('/').pop()!, url })
    }
  }
  pngs.sort((a, b) => a.name.localeCompare(b.name))
  ALL_SPRITES.push({ path: dir, config: cfg, frameUrls: pngs.map(p => p.url) })
}

ALL_SPRITES.sort((a, b) => a.path.localeCompare(b.path))

// Map kind → primary SpriteConfig (the one with defaultSize + role)
const KIND_PRIMARY = new Map<string, SpriteConfig>()
for (const entry of ALL_SPRITES) {
  const cfg = entry.config
  if (cfg.defaultSize && cfg.role && !KIND_PRIMARY.has(cfg.kind)) {
    KIND_PRIMARY.set(cfg.kind, cfg)
  }
}

// ── Sprite Editor class ──────────────────────────────────────────────────────

export class SpriteEditor {
  onClose: (() => void) | null = null

  private el!: HTMLElement
  private container: HTMLElement
  private paletteEl!: HTMLElement
  private propsPanel!: HTMLElement
  private previewCanvas!: HTMLCanvasElement
  private previewCtx!: CanvasRenderingContext2D
  private statusEl!: HTMLElement

  // State
  private selectedSprite: SpriteEntry | null = null
  private selectedCustom: CustomSprite | null = null
  private frameImages: HTMLImageElement[] = []
  private frameOrder: number[] = []
  private dragFrameIdx: number | null = null
  private dropTargetIdx: number | null = null
  private animTimer: number | null = null

  private customSprites: CustomSprite[] = []

  // Preview scale & player comparison
  private playerRefImg: HTMLImageElement | null = null
  private showPlayerRef = false
  private previewScale = 1.0

  // Importer state
  private importerModal!: HTMLElement
  private importerSheetImg: HTMLImageElement | null = null
  private importerExtracted: string[] = []

  constructor(container: HTMLElement) {
    this.container = container
    this.injectStyles()
    this.buildDOM()
    this.bindEvents()
    this.customSprites = loadCustomSprites()
    this.loadPlayerRefImage()
    this.rebuildPalette()
  }

  // ── CSS ───────────────────────────────────────────────────────────────────

  private injectStyles() {
    if (document.getElementById('se-styles')) return
    const s = document.createElement('style')
    s.id = 'se-styles'
    s.textContent = `
      #se-screen {
        position:fixed;inset:0;z-index:210;
        background:#0d1520;color:#d6e8f8;
        display:none;flex-direction:column;
        font-family:'Trebuchet MS','Verdana',sans-serif;font-size:13px;
        user-select:none;
      }
      #se-topbar {
        display:flex;align-items:center;gap:6px;flex-wrap:wrap;
        padding:5px 8px;background:#080f18;
        border-bottom:1px solid #1a3050;flex-shrink:0;
      }
      .se-btn {
        padding:4px 10px;border-radius:4px;
        border:1px solid #243a58;background:#0f2035;
        color:#c0d8f0;cursor:pointer;font-size:12px;white-space:nowrap;
        line-height:1.3;
      }
      .se-btn:hover { background:#182d46;border-color:#3a6090; }
      .se-btn.se-primary { border-color:#2090c0;color:#80d8ff; }
      .se-btn.se-primary:hover { background:#0a2840; }
      .se-btn.se-danger { border-color:#804040;color:#ffaaaa; }
      .se-btn.se-danger:hover { background:#200a0a; }
      .se-sep { width:1px;height:20px;background:#1a3050;flex-shrink:0; }
      .se-label { opacity:0.5;font-size:11px;white-space:nowrap; }
      #se-body { display:flex;flex:1;overflow:hidden; }
      /* ── Palette ── */
      #se-palette {
        width:200px;min-width:160px;flex-shrink:0;
        overflow-y:auto;background:#0a1525;
        border-right:1px solid #1a3050;padding:4px 0;
      }
      .se-pal-group-head {
        padding:5px 8px 2px;font-size:11px;font-weight:700;
        color:#6090c0;text-transform:uppercase;letter-spacing:0.5px;
      }
      .se-pal-item {
        display:flex;align-items:center;gap:6px;padding:4px 8px;
        cursor:pointer;border-left:3px solid transparent;
        font-size:12px;
      }
      .se-pal-item:hover { background:#0f2035; }
      .se-pal-item.active { background:#142a40;border-left-color:#40a0ff; }
      .se-pal-thumb {
        width:28px;height:28px;border-radius:3px;
        background:#071018;border:1px solid #1a3050;
        object-fit:contain;flex-shrink:0;
      }
      .se-pal-label { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      /* ── Main area ── */
      #se-main {
        flex:1;display:flex;flex-direction:column;overflow:hidden;
      }
      /* ── Frame strip ── */
      #se-frame-strip {
        display:flex;flex-wrap:wrap;gap:4px;padding:8px;
        overflow-y:auto;min-height:80px;max-height:200px;
        background:#07101a;border-bottom:1px solid #1a3050;
        align-content:flex-start;
      }
      .se-frame {
        width:64px;height:64px;border:2px solid #1a3050;border-radius:4px;
        background:#0a1a2a;cursor:grab;position:relative;
        display:flex;align-items:center;justify-content:center;
      }
      .se-frame img {
        max-width:60px;max-height:60px;object-fit:contain;pointer-events:none;
      }
      .se-frame.drag-over { border-color:#40a0ff;background:#102040; }
      .se-frame .se-frame-idx {
        position:absolute;bottom:1px;right:3px;font-size:9px;opacity:0.5;
      }
      .se-frame .se-frame-del {
        position:absolute;top:1px;right:2px;font-size:10px;opacity:0;
        cursor:pointer;color:#ff8080;background:rgba(0,0,0,.6);
        border:none;padding:0 2px;line-height:1;border-radius:2px;
      }
      .se-frame:hover .se-frame-del { opacity:1; }
      /* ── Center area (preview + props) ── */
      #se-center {
        flex:1;display:flex;overflow:hidden;
      }
      #se-preview-area {
        flex:1;display:flex;flex-direction:column;align-items:center;
        justify-content:center;padding:16px;overflow:auto;
        background:#07101a;
      }
      #se-preview-canvas {
        border:1px solid #1a3050;border-radius:4px;background:#0a1a2a;
      }
      #se-preview-controls {
        display:flex;align-items:center;gap:8px;margin-top:8px;
      }
      #se-scale-controls {
        display:flex;align-items:center;gap:8px;margin-top:6px;
        flex-wrap:wrap;justify-content:center;
      }
      #se-scale-slider { width:120px;cursor:pointer; }
      #se-scale-value { font-size:11px;opacity:0.7;min-width:36px;text-align:center; }
      #se-player-ref-row { display:flex;align-items:center;gap:4px; }
      #se-player-ref-row label { font-size:11px;opacity:0.7;cursor:pointer; }
      /* ── Properties panel ── */
      #se-props {
        width:260px;min-width:200px;flex-shrink:0;
        overflow-y:auto;background:#0a1525;
        border-left:1px solid #1a3050;padding:8px;
      }
      .se-section-head {
        font-size:11px;font-weight:700;color:#6090c0;
        text-transform:uppercase;letter-spacing:0.5px;
        margin:12px 0 4px;padding-bottom:2px;
        border-bottom:1px solid #1a3050;
      }
      .se-section-head:first-child { margin-top:0; }
      .se-prop-row {
        display:flex;align-items:center;gap:6px;margin:4px 0;
      }
      .se-prop-row label {
        width:80px;flex-shrink:0;font-size:11px;opacity:0.7;text-align:right;
      }
      .se-prop-row input, .se-prop-row select {
        flex:1;padding:3px 6px;border-radius:3px;
        border:1px solid #243a58;background:#0f2035;color:#c0d8f0;
        font-size:12px;min-width:0;
      }
      .se-prop-row input[type="color"] { padding:1px 2px;height:26px; }
      /* ── Status bar ── */
      #se-status {
        padding:3px 8px;background:#080f18;
        border-top:1px solid #1a3050;font-size:11px;opacity:0.6;
        flex-shrink:0;
      }
      /* ── Importer modal ── */
      #se-importer-modal {
        position:fixed;inset:0;z-index:220;
        background:rgba(0,0,0,.85);display:none;
        flex-direction:column;padding:16px;gap:8px;
        overflow:auto;
      }
      .se-importer-layout { display:flex;gap:12px;flex:1;overflow:hidden; }
      .se-importer-preview { flex:1;display:flex;align-items:center;justify-content:center;overflow:auto; }
      .se-importer-controls { width:220px;overflow-y:auto;flex-shrink:0; }
      .se-irow { display:flex;align-items:center;gap:6px;margin:3px 0; }
      .se-irow label { width:70px;flex-shrink:0;font-size:11px;opacity:0.7;text-align:right; }
      .se-irow input, .se-irow select {
        flex:1;padding:3px 6px;border-radius:3px;
        border:1px solid #243a58;background:#0f2035;color:#c0d8f0;font-size:12px;
      }
      #se-imp-frames-row {
        display:flex;flex-wrap:wrap;gap:4px;overflow-y:auto;max-height:80px;
      }
      .se-frame-thumb {
        width:48px;height:48px;object-fit:contain;
        border:1px solid #1a3050;border-radius:3px;background:#0a1a2a;
      }
      .se-anim-preview { display:flex;flex-direction:column;align-items:center;gap:4px; }
    `
    document.head.appendChild(s)
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  private buildDOM() {
    const el = document.createElement('div')
    el.id = 'se-screen'
    this.el = el

    // ── Top bar ──
    const topbar = document.createElement('div')
    topbar.id = 'se-topbar'
    topbar.innerHTML = `
      <button class="se-btn" id="se-back">← Exit Sprite Editor</button>
      <div class="se-sep"></div>
      <button class="se-btn" id="se-import-sprite">📂 Import Spritesheet</button>
      <div class="se-sep"></div>
      <button class="se-btn" id="se-export-zip">📦 Export ZIP</button>
      <button class="se-btn" id="se-export-png">🖼️ Export Spritesheet</button>
      <button class="se-btn" id="se-export-gif">🎞️ Export GIF</button>
      <div class="se-sep"></div>
      <button class="se-btn se-primary" id="se-save">💾 Save</button>
    `
    el.appendChild(topbar)

    // ── Body ──
    const body = document.createElement('div')
    body.id = 'se-body'

    // Palette
    const palette = document.createElement('div')
    palette.id = 'se-palette'
    this.paletteEl = palette
    body.appendChild(palette)

    // Main area
    const main = document.createElement('div')
    main.id = 'se-main'

    // Frame strip
    const frameStrip = document.createElement('div')
    frameStrip.id = 'se-frame-strip'
    main.appendChild(frameStrip)

    // Center area
    const center = document.createElement('div')
    center.id = 'se-center'

    // Preview
    const previewArea = document.createElement('div')
    previewArea.id = 'se-preview-area'
    const previewCanvas = document.createElement('canvas')
    previewCanvas.id = 'se-preview-canvas'
    previewCanvas.setAttribute('aria-label', 'Sprite preview')
    previewCanvas.width = 192
    previewCanvas.height = 192
    this.previewCanvas = previewCanvas
    this.previewCtx = previewCanvas.getContext('2d')!
    previewArea.appendChild(previewCanvas)

    const previewControls = document.createElement('div')
    previewControls.id = 'se-preview-controls'
    previewControls.innerHTML = `
      <button class="se-btn" id="se-anim-play">▶ Play</button>
      <button class="se-btn" id="se-anim-stop">⏹ Stop</button>
      <span class="se-label" id="se-anim-frame">Frame: 0/0</span>
    `
    previewArea.appendChild(previewControls)

    const scaleControls = document.createElement('div')
    scaleControls.id = 'se-scale-controls'
    scaleControls.innerHTML = `
      <span class="se-label">Scale:</span>
      <input type="range" id="se-scale-slider" min="0.1" max="3" step="0.05" value="1.0">
      <span id="se-scale-value">1.0×</span>
      <span id="se-player-ref-row" style="display:none">
        <input type="checkbox" id="se-show-player">
        <label for="se-show-player">Show player</label>
      </span>
    `
    previewArea.appendChild(scaleControls)
    center.appendChild(previewArea)

    // Props panel
    const props = document.createElement('div')
    props.id = 'se-props'
    this.propsPanel = props
    center.appendChild(props)

    main.appendChild(center)
    body.appendChild(main)
    el.appendChild(body)

    // Status bar
    const status = document.createElement('div')
    status.id = 'se-status'
    status.textContent = 'Select a sprite from the palette'
    this.statusEl = status
    el.appendChild(status)

    // ── Importer modal ──
    const modal = document.createElement('div')
    modal.id = 'se-importer-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', 'Import Sprite Sheet')
    modal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <span style="font-size:15px;font-weight:700;color:#c8e4ff">⊕ Import Sprite Sheet</span>
        <button class="se-btn" id="se-imp-close">✕ Cancel</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        <button class="se-btn" id="se-imp-file-btn">📂 Browse…</button>
        <input type="file" id="se-imp-file" accept="image/*" style="display:none">
        <span id="se-imp-filename" style="font-size:11px;opacity:0.5;font-style:italic">No file selected</span>
      </div>
      <div class="se-importer-layout">
        <div class="se-importer-preview">
          <canvas id="se-imp-canvas" style="display:block;"></canvas>
        </div>
        <div class="se-importer-controls">
          <div class="se-section-head">Grid</div>
          <div class="se-irow"><label>Columns</label><input id="se-imp-cols" type="number" value="5" min="1"></div>
          <div class="se-irow"><label>Rows</label><input id="se-imp-rows" type="number" value="5" min="1"></div>
          <div class="se-irow"><label>Max frames</label><input id="se-imp-frames" type="number" value="25" min="1"></div>
          <div class="se-irow"><label>Offset X</label><input id="se-imp-ox" type="number" value="0" min="0"></div>
          <div class="se-irow"><label>Offset Y</label><input id="se-imp-oy" type="number" value="0" min="0"></div>
          <div class="se-section-head" style="margin-top:8px">Sprite Entry</div>
          <div class="se-irow"><label>Category</label><select id="se-imp-cat"><option value="terrain">Terrain</option><option value="characters">Characters</option><option value="items" selected>Items</option><option value="hazards">Hazards</option><option value="obstacles">Obstacles</option></select></div>
          <div class="se-irow" id="se-imp-obstacle-row" style="display:none"><label>Type</label><select id="se-imp-obstacle-type"><option value="dangerous">Dangerous</option><option value="blocking">Blocking</option></select></div>
          <div class="se-irow"><label>ID</label><input id="se-imp-id" type="text" placeholder="stone_block"></div>
          <div class="se-irow"><label>Label</label><input id="se-imp-label" type="text" placeholder="Stone Block"></div>
          <div class="se-irow"><label>Icon</label><input id="se-imp-icon" type="text" value="🧱" style="width:40px;text-align:center"></div>
          <div class="se-irow"><label>Fill</label><input id="se-imp-fill" type="color" value="#606060"></div>
          <div class="se-irow"><label>Stroke</label><input id="se-imp-stroke" type="color" value="#909090"></div>
          <div class="se-section-head" style="margin-top:8px">Properties</div>
          <div class="se-irow"><label>Hitbox W</label><input id="se-imp-hw" type="number" step="0.25" min="0.25" value="1.5"></div>
          <div class="se-irow"><label>Hitbox H</label><input id="se-imp-hh" type="number" step="0.25" min="0.25" value="1.0"></div>
          <div class="se-irow"><label>FPS</label><input id="se-imp-fps" type="number" value="8" min="1"></div>
          <div class="se-irow"><label>Anim Mode</label><select id="se-imp-anim-mode"><option value="loop">Loop</option><option value="pingpong">Ping-Pong</option><option value="once">Once</option></select></div>
          <div class="se-irow"><label>Tiling</label><select id="se-imp-tiling"><option value="none" selected>None</option><option value="h">Horizontal</option><option value="v">Vertical</option></select></div>
          <div class="se-irow"><label>Resize Snap</label><select id="se-imp-snap"><option value="free" selected>Free (0.25 grid)</option><option value="tile">Whole tile</option></select></div>
          <div id="se-imp-anim-preview" class="se-anim-preview" style="display:none">
            <div class="se-section-head" style="margin-top:8px">Animation Preview</div>
            <canvas id="se-imp-anim-canvas" width="96" height="96" style="border:1px solid #1a3050;border-radius:4px;background:#07101a;display:block;"></canvas>
          </div>
        </div>
      </div>
      <div class="se-section-head" style="flex-shrink:0">Frame Preview</div>
      <div id="se-imp-frames-row" class="se-frames-row" style="display:flex;flex-wrap:wrap;gap:4px;overflow-y:auto;max-height:80px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">
        <button class="se-btn" id="se-imp-extract">🔍 Preview Frames</button>
        <button class="se-btn se-primary" id="se-imp-add" disabled>✓ Add to Palette</button>
      </div>
    `
    el.appendChild(modal)
    this.importerModal = modal

    this.container.appendChild(el)
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private bindEvents() {
    // Back
    document.getElementById('se-back')!.addEventListener('click', () => {
      this.hide()
      if (this.onClose) this.onClose()
    })

    // Save
    document.getElementById('se-save')!.addEventListener('click', () => this.saveCurrentSprite())

    // Export buttons
    document.getElementById('se-export-zip')!.addEventListener('click', () => this.exportZip())
    document.getElementById('se-export-png')!.addEventListener('click', () => this.exportSpritesheet())
    document.getElementById('se-export-gif')!.addEventListener('click', () => this.exportGif())

    // Animation controls
    document.getElementById('se-anim-play')!.addEventListener('click', () => this.startPreviewAnim())
    document.getElementById('se-anim-stop')!.addEventListener('click', () => this.stopPreviewAnim())

    // Scale slider
    document.getElementById('se-scale-slider')!.addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value)
      this.previewScale = v
      document.getElementById('se-scale-value')!.textContent = `${v.toFixed(2)}×`
      // Write back to config
      if (this.selectedSprite) {
        this.selectedSprite.config.spriteScale = v
        // Also update the number input in the props panel if present
        const inp = this.propsPanel.querySelector<HTMLInputElement>('input[data-field="spriteScale"]')
        if (inp) inp.value = String(v)
      }
      this.redrawCurrentFrame()
    })

    // Player comparison checkbox
    document.getElementById('se-show-player')!.addEventListener('change', (e) => {
      this.showPlayerRef = (e.target as HTMLInputElement).checked
      this.redrawCurrentFrame()
    })

    // Importer
    document.getElementById('se-import-sprite')!.addEventListener('click', () => this.openImporter())
    document.getElementById('se-imp-close')!.addEventListener('click', () => this.closeImporter())
    document.getElementById('se-imp-file-btn')!.addEventListener('click', () => {
      (document.getElementById('se-imp-file') as HTMLInputElement).click()
    })
    document.getElementById('se-imp-file')!.addEventListener('change', (e) => this.onImporterFileSelect(e))
    document.getElementById('se-imp-extract')!.addEventListener('click', () => this.extractImporterFrames())
    document.getElementById('se-imp-add')!.addEventListener('click', () => this.addImportedSprite())

    // Importer: grid controls update preview
    for (const id of ['se-imp-cols', 'se-imp-rows', 'se-imp-ox', 'se-imp-oy']) {
      document.getElementById(id)!.addEventListener('input', () => this.renderImporterPreview())
    }

    // Importer: category → obstacle row toggle
    document.getElementById('se-imp-cat')!.addEventListener('change', () => {
      const cat = (document.getElementById('se-imp-cat') as HTMLSelectElement).value
      document.getElementById('se-imp-obstacle-row')!.style.display = cat === 'obstacles' ? '' : 'none'
    })
  }

  // ── Palette ───────────────────────────────────────────────────────────────

  private rebuildPalette() {
    this.paletteEl.innerHTML = ''

    // Group built-in sprites by top-level directory
    const groups = new Map<string, SpriteEntry[]>()
    for (const entry of ALL_SPRITES) {
      const parts = entry.path.split('/')
      const group = parts[0] ?? 'Other'
      // Use a friendly name
      const friendlyGroup = group.charAt(0).toUpperCase() + group.slice(1).replace(/_/g, ' ')
      if (!groups.has(friendlyGroup)) groups.set(friendlyGroup, [])
      groups.get(friendlyGroup)!.push(entry)
    }

    for (const [group, entries] of groups) {
      const head = document.createElement('div')
      head.className = 'se-pal-group-head'
      head.textContent = group
      this.paletteEl.appendChild(head)

      for (const entry of entries) {
        const item = document.createElement('div')
        item.className = 'se-pal-item'
        item.dataset.path = entry.path

        // Thumbnail
        const thumb = document.createElement('img')
        thumb.className = 'se-pal-thumb'
        if (entry.frameUrls.length > 0) {
          thumb.src = entry.frameUrls[0]
        }
        item.appendChild(thumb)

        // Label
        const label = document.createElement('span')
        label.className = 'se-pal-label'
        const displayName = entry.config.color?.label ??
          entry.path.split('/').pop()?.replace(/_/g, ' ') ?? entry.path
        label.textContent = displayName
        label.title = entry.path
        item.appendChild(label)

        item.addEventListener('click', () => this.selectBuiltinSprite(entry))
        this.paletteEl.appendChild(item)
      }
    }

    // Custom sprites
    if (this.customSprites.length > 0) {
      const head = document.createElement('div')
      head.className = 'se-pal-group-head'
      head.textContent = 'Custom'
      this.paletteEl.appendChild(head)

      for (const cs of this.customSprites) {
        const item = document.createElement('div')
        item.className = 'se-pal-item'
        item.dataset.customId = cs.id

        const thumb = document.createElement('img')
        thumb.className = 'se-pal-thumb'
        if (cs.frames.length > 0) thumb.src = cs.frames[cs.iconFrame] ?? cs.frames[0]
        item.appendChild(thumb)

        const label = document.createElement('span')
        label.className = 'se-pal-label'
        label.textContent = cs.label
        item.appendChild(label)

        // Delete button
        const del = document.createElement('button')
        del.textContent = '×'
        del.style.cssText = 'background:none;border:none;color:#ff8080;cursor:pointer;font-size:14px;padding:0 4px;flex-shrink:0'
        del.addEventListener('click', (e) => {
          e.stopPropagation()
          if (!confirm(`Delete custom sprite "${cs.label}"?`)) return
          this.customSprites = this.customSprites.filter(s => s.id !== cs.id)
          saveCustomSprites(this.customSprites)
          this.rebuildPalette()
          if (this.selectedCustom?.id === cs.id) {
            this.selectedCustom = null
            this.clearSelection()
          }
        })
        item.appendChild(del)

        item.addEventListener('click', () => this.selectCustomSprite(cs))
        this.paletteEl.appendChild(item)
      }
    }
  }

  private highlightPaletteItem(path?: string, customId?: string) {
    this.paletteEl.querySelectorAll('.se-pal-item').forEach(el => el.classList.remove('active'))
    if (path) {
      const item = this.paletteEl.querySelector(`.se-pal-item[data-path="${CSS.escape(path)}"]`)
      if (item) item.classList.add('active')
    } else if (customId) {
      const item = this.paletteEl.querySelector(`.se-pal-item[data-custom-id="${CSS.escape(customId)}"]`)
      if (item) item.classList.add('active')
    }
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  private selectBuiltinSprite(entry: SpriteEntry) {
    this.stopPreviewAnim()
    this.selectedSprite = entry
    this.selectedCustom = null
    this.highlightPaletteItem(entry.path)

    // Load frames
    this.frameOrder = entry.config.frameOrder
      ? [...entry.config.frameOrder]
      : entry.frameUrls.map((_, i) => i)
    this.loadFrameImages(entry.frameUrls)

    this.syncScaleControls(entry.config.spriteScale ?? 1.0)
    this.buildPropsPanel()
    this.statusEl.textContent = `${entry.path}  ·  ${entry.frameUrls.length} frames`
  }

  private selectCustomSprite(cs: CustomSprite) {
    this.stopPreviewAnim()
    this.selectedSprite = null
    this.selectedCustom = cs
    this.highlightPaletteItem(undefined, cs.id)

    this.frameOrder = cs.frames.map((_, i) => i)
    this.loadFrameImages(cs.frames)

    this.syncScaleControls(1.0)
    this.buildPropsPanel()
    this.statusEl.textContent = `Custom: ${cs.label}  ·  ${cs.frames.length} frames`
  }

  private clearSelection() {
    this.stopPreviewAnim()
    this.selectedSprite = null
    this.selectedCustom = null
    this.frameImages = []
    this.frameOrder = []
    this.renderFrameStrip()
    this.propsPanel.innerHTML = ''
    this.clearPreview()
    this.statusEl.textContent = 'Select a sprite from the palette'
  }

  // ── Frame loading & rendering ─────────────────────────────────────────────

  private loadFrameImages(urls: string[]) {
    this.frameImages = []
    if (urls.length === 0) {
      this.renderFrameStrip()
      this.clearPreview()
      return
    }
    let loaded = 0
    const imgs: HTMLImageElement[] = new Array(urls.length)
    for (let i = 0; i < urls.length; i++) {
      const img = new Image()
      img.onload = () => {
        imgs[i] = img
        loaded++
        if (loaded === urls.length) {
          this.frameImages = imgs
          this.renderFrameStrip()
          this.showFrame(0)
        }
      }
      img.onerror = () => {
        loaded++
        if (loaded === urls.length) {
          this.frameImages = imgs.filter(Boolean)
          this.renderFrameStrip()
          if (this.frameImages.length > 0) this.showFrame(0)
        }
      }
      img.src = urls[i]
    }
  }

  private renderFrameStrip() {
    const strip = document.getElementById('se-frame-strip')!
    strip.innerHTML = ''

    for (let orderIdx = 0; orderIdx < this.frameOrder.length; orderIdx++) {
      const frameIdx = this.frameOrder[orderIdx]
      const frame = document.createElement('div')
      frame.className = 'se-frame'
      frame.draggable = true
      frame.dataset.orderIdx = String(orderIdx)

      if (this.frameImages[frameIdx]) {
        const img = document.createElement('img')
        img.src = this.frameImages[frameIdx].src
        frame.appendChild(img)
      }

      // Frame index label
      const idxLabel = document.createElement('span')
      idxLabel.className = 'se-frame-idx'
      idxLabel.textContent = String(frameIdx)
      frame.appendChild(idxLabel)

      // Delete button
      const del = document.createElement('button')
      del.className = 'se-frame-del'
      del.textContent = '×'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        if (this.frameOrder.length <= 1) return
        if (!confirm(`Remove frame ${frameIdx} from the sequence?`)) return
        this.frameOrder.splice(orderIdx, 1)
        this.renderFrameStrip()
        this.showFrame(0)
      })
      frame.appendChild(del)

      // Click to preview
      frame.addEventListener('click', () => {
        this.stopPreviewAnim()
        this.showFrame(orderIdx)
      })

      // Drag & drop reordering
      frame.addEventListener('dragstart', (e) => {
        this.dragFrameIdx = orderIdx
        e.dataTransfer!.effectAllowed = 'move'
        e.dataTransfer!.setData('text/plain', String(orderIdx))
      })
      frame.addEventListener('dragover', (e) => {
        e.preventDefault()
        e.dataTransfer!.dropEffect = 'move'
        // Highlight drop target
        strip.querySelectorAll('.se-frame').forEach(f => f.classList.remove('drag-over'))
        frame.classList.add('drag-over')
        this.dropTargetIdx = orderIdx
      })
      frame.addEventListener('dragleave', () => frame.classList.remove('drag-over'))
      frame.addEventListener('drop', (e) => {
        e.preventDefault()
        frame.classList.remove('drag-over')
        if (this.dragFrameIdx !== null && this.dropTargetIdx !== null && this.dragFrameIdx !== this.dropTargetIdx) {
          const [moved] = this.frameOrder.splice(this.dragFrameIdx, 1)
          this.frameOrder.splice(this.dropTargetIdx, 0, moved)
          this.renderFrameStrip()
        }
        this.dragFrameIdx = null
        this.dropTargetIdx = null
      })

      strip.appendChild(frame)
    }
  }

  private currentFrameOrderIdx = 0

  private showFrame(orderIdx: number) {
    if (orderIdx < 0 || orderIdx >= this.frameOrder.length) return
    this.currentFrameOrderIdx = orderIdx
    this.drawPreview()
    const label = document.getElementById('se-anim-frame')
    if (label) label.textContent = `Frame: ${orderIdx + 1}/${this.frameOrder.length}`
  }

  /** Re-draw the current frame (called when scale/player-ref changes). */
  private redrawCurrentFrame() {
    if (this.frameOrder.length > 0) {
      this.drawPreview()
    }
  }

  /** Core preview draw — game-accurate sizing with optional player reference. */
  private drawPreview() {
    const orderIdx = this.currentFrameOrderIdx
    if (orderIdx < 0 || orderIdx >= this.frameOrder.length) return
    const frameIdx = this.frameOrder[orderIdx]
    const img = this.frameImages[frameIdx]
    if (!img) return

    const cv = this.previewCanvas
    const ctx = this.previewCtx

    // Compute game-accurate visual sizes in world units
    const [gameW, gameH] = this.getGameVisualSize()
    const showPlayer = this.showPlayerRef && this.playerRefImg && !this.isPlayerSprite()

    // Both the sprite and the player reference share a single PPU so their
    // relative sizes are accurate (matching the game engine).
    // Player reference size comes from config (defaultSize × spriteScale)
    const playerPrimary = KIND_PRIMARY.get('player')
    const pds = playerPrimary?.defaultSize
    const pss = playerPrimary?.spriteScale ?? 1.0
    const playerGameW = (pds?.[0] ?? 0.85) * pss
    const playerGameH = (pds?.[1] ?? 1.7) * pss
    const maxH = showPlayer ? Math.max(gameH, playerGameH) : gameH
    const maxW = showPlayer ? gameW + playerGameW + 0.5 : gameW
    const PPU = Math.min(200 / maxH, 300 / maxW, 120)

    const sw = gameW * PPU
    const sh = gameH * PPU
    const pw = showPlayer ? playerGameW * PPU : 0
    const ph = showPlayer ? playerGameH * PPU : 0

    // Canvas sizing
    const pad = 16
    const totalW = showPlayer ? sw + pw + 16 : sw
    const totalH = Math.max(sh, ph)
    cv.width = Math.max(192, Math.round(totalW + pad * 2))
    cv.height = Math.max(192, Math.round(totalH + pad * 2 + 14))

    ctx.clearRect(0, 0, cv.width, cv.height)

    // Draw ground line
    const groundY = pad + totalH
    ctx.strokeStyle = '#1a3050'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, groundY + 0.5)
    ctx.lineTo(cv.width, groundY + 0.5)
    ctx.stroke()
    ctx.setLineDash([])

    // Sprite — drawn at its game-effective size but preserving the frame's
    // natural aspect ratio (the game engine stretches textures into
    // PlaneGeometry but the preview should not distort the artwork).
    const spriteRegionX = showPlayer ? pad + pw + 16 : (cv.width - sw) / 2
    const natAspect = img.naturalWidth / img.naturalHeight
    const gameAspect = sw / sh
    let drawW = sw
    let drawH = sh
    if (natAspect > gameAspect) {
      // Sprite is wider relative to its game rect — fit width, shrink height
      drawH = sw / natAspect
    } else {
      // Sprite is taller relative to its game rect — fit height, shrink width
      drawW = sh * natAspect
    }
    const drawX = spriteRegionX + (sw - drawW) / 2
    ctx.drawImage(img, drawX, groundY - drawH, drawW, drawH)

    // Player reference
    if (showPlayer && this.playerRefImg) {
      const px = pad
      const py = groundY - ph
      ctx.globalAlpha = 0.5
      ctx.drawImage(this.playerRefImg, px, py, pw, ph)
      ctx.globalAlpha = 1
      ctx.font = '9px sans-serif'
      ctx.fillStyle = '#6090c0'
      ctx.textAlign = 'center'
      ctx.fillText('Player', px + pw / 2, py - 3)
    }
  }

  /**
   * Compute the game-accurate visual size of the current sprite in world units.
   *
   * All sprites use: defaultSize × spriteScale (from config).
   * No role-based hardcoded multipliers — scaling is entirely config-driven.
   */
  private getGameVisualSize(): [number, number] {
    const scale = this.previewScale

    if (this.selectedSprite) {
      const cfg = this.selectedSprite.config
      const primary = KIND_PRIMARY.get(cfg.kind)
      const ds = cfg.defaultSize ?? primary?.defaultSize
      const ss = cfg.spriteScale ?? primary?.spriteScale ?? 1.0

      const bw = ds?.[0] ?? 1
      const bh = ds?.[1] ?? 1
      return [bw * ss * scale, bh * ss * scale]
    }

    if (this.selectedCustom) {
      const cs = this.selectedCustom
      return [cs.hitboxW * scale, cs.hitboxH * scale]
    }

    return [1, 1]
  }

  /** Load the player idle first frame for reference comparison. */
  private loadPlayerRefImage() {
    // Find the player/trogg/idle first frame URL from the build-time glob
    const prefix = './assets/sprites/player/trogg/idle/'
    const pngEntries = Object.entries(allPngModules)
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .sort(([a], [b]) => a.localeCompare(b))
    if (pngEntries.length === 0) return
    const img = new Image()
    img.onload = () => { this.playerRefImg = img }
    img.src = pngEntries[0][1]
  }

  /** Returns true if the currently selected sprite is the player (trogg). */
  private isPlayerSprite(): boolean {
    if (this.selectedSprite) return this.selectedSprite.config.kind === 'player'
    return false
  }

  /** Sync the scale slider and player-ref checkbox to match the selected sprite. */
  private syncScaleControls(scale: number) {
    this.previewScale = scale
    const slider = document.getElementById('se-scale-slider') as HTMLInputElement
    const valueEl = document.getElementById('se-scale-value')!
    const playerRow = document.getElementById('se-player-ref-row')!
    const playerCb = document.getElementById('se-show-player') as HTMLInputElement

    slider.value = String(scale)
    valueEl.textContent = `${scale.toFixed(2)}×`

    // Hide player-ref for the player's own sprites
    if (this.isPlayerSprite()) {
      playerRow.style.display = 'none'
      this.showPlayerRef = false
      playerCb.checked = false
    } else {
      playerRow.style.display = ''
    }
  }

  private clearPreview() {
    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height)
    const label = document.getElementById('se-anim-frame')
    if (label) label.textContent = 'Frame: 0/0'
  }

  // ── Animation preview ─────────────────────────────────────────────────────

  private startPreviewAnim() {
    this.stopPreviewAnim()
    if (this.frameOrder.length < 2) return
    const fps = this.getCurrentFps()
    const mode = this.getCurrentAnimMode()
    let tick = 0
    let lastTime = performance.now()
    let onceFinished = false
    const totalFrames = this.frameOrder.length

    const step = () => {
      const now = performance.now()
      tick += (now - lastTime) / 1000 * fps
      lastTime = now

      let frameIdx: number
      if (mode === 'pingpong') {
        if (totalFrames <= 1) { frameIdx = 0 }
        else {
          const period = 2 * (totalFrames - 1)
          const pos = ((Math.floor(tick) % period) + period) % period
          frameIdx = pos < totalFrames ? pos : period - pos
        }
      } else if (mode === 'once') {
        frameIdx = Math.min(Math.floor(tick), totalFrames - 1)
        if (frameIdx >= totalFrames - 1) onceFinished = true
      } else {
        frameIdx = Math.floor(tick) % totalFrames
      }

      this.showFrame(frameIdx)
      if (mode === 'once' && onceFinished) return
      this.animTimer = requestAnimationFrame(step)
    }
    this.animTimer = requestAnimationFrame(step)
  }

  private stopPreviewAnim() {
    if (this.animTimer !== null) {
      cancelAnimationFrame(this.animTimer)
      this.animTimer = null
    }
  }

  private getCurrentFps(): number {
    if (this.selectedSprite) return this.selectedSprite.config.fps ?? 8
    if (this.selectedCustom) return this.selectedCustom.fps
    return 8
  }

  private getCurrentAnimMode(): AnimMode {
    if (this.selectedSprite) return this.selectedSprite.config.animMode ?? 'loop'
    if (this.selectedCustom) return this.selectedCustom.animMode
    return 'loop'
  }

  // ── Properties panel ──────────────────────────────────────────────────────

  private buildPropsPanel() {
    this.propsPanel.innerHTML = ''

    if (this.selectedSprite) {
      this.buildBuiltinProps(this.selectedSprite)
    } else if (this.selectedCustom) {
      this.buildCustomProps(this.selectedCustom)
    }
  }

  private buildBuiltinProps(entry: SpriteEntry) {
    const cfg = entry.config
    const p = this.propsPanel

    // Info section
    this.addSectionHead(p, 'Info')
    this.addReadonlyRow(p, 'Path', entry.path)
    this.addReadonlyRow(p, 'Kind', cfg.kind)
    if (cfg.role) this.addReadonlyRow(p, 'Role', cfg.role)
    if (cfg.group) this.addReadonlyRow(p, 'Group', cfg.group)
    if (cfg.action) this.addReadonlyRow(p, 'Action', cfg.action)
    this.addReadonlyRow(p, 'Frames', String(cfg.frameCount ?? entry.frameUrls.length))

    // Editable properties
    this.addSectionHead(p, 'Animation')
    this.addNumberRow(p, 'FPS', cfg.fps ?? 8, 1, 60, 1, (v) => { cfg.fps = v })
    this.addSelectRow(p, 'Anim Mode', cfg.animMode ?? 'loop',
      [['loop', 'Loop'], ['pingpong', 'Ping-Pong'], ['once', 'Once']],
      (v) => { cfg.animMode = v as AnimMode })
    this.addNumberRow(p, 'Sprite Scale', cfg.spriteScale ?? 1.0, 0.1, 3, 0.05, (v) => {
      cfg.spriteScale = v
      this.syncScaleControls(v)
      this.redrawCurrentFrame()
    }, 'spriteScale')

    this.addSectionHead(p, 'Visual Size')
    this.addNumberRow(p, 'Visual W', cfg.visual_w ?? 1, 0.1, 20, 0.05, (v) => { cfg.visual_w = v; this.redrawCurrentFrame() })
    this.addNumberRow(p, 'Visual H', cfg.visual_h ?? 1, 0.1, 20, 0.05, (v) => { cfg.visual_h = v; this.redrawCurrentFrame() })

    if (cfg.tiling) {
      this.addSectionHead(p, 'Tiling')
      this.addReadonlyRow(p, 'Direction', cfg.tiling === 'h' ? 'Horizontal' : 'Vertical')
    }

    if (cfg.defaultSize) {
      this.addSectionHead(p, 'Default Size')
      this.addNumberRow(p, 'Width', cfg.defaultSize[0], 0.25, 50, 0.25, (v) => { if (cfg.defaultSize) cfg.defaultSize[0] = v })
      this.addNumberRow(p, 'Height', cfg.defaultSize[1], 0.25, 50, 0.25, (v) => { if (cfg.defaultSize) cfg.defaultSize[1] = v })
    }

    if (cfg.color) {
      this.addSectionHead(p, 'Editor Color')
      this.addTextRow(p, 'Label', cfg.color.label, (v) => { if (cfg.color) cfg.color.label = v })
      this.addTextRow(p, 'Icon', cfg.color.icon, (v) => { if (cfg.color) cfg.color.icon = v })
      this.addColorRow(p, 'Fill', cfg.color.fill, (v) => { if (cfg.color) cfg.color.fill = v })
      this.addColorRow(p, 'Stroke', cfg.color.stroke, (v) => { if (cfg.color) cfg.color.stroke = v })
    }

    // Frame order
    this.addSectionHead(p, 'Frame Order')
    const orderInfo = document.createElement('div')
    orderInfo.style.cssText = 'font-size:10px;opacity:0.5;margin:2px 0 4px;padding:0 4px'
    orderInfo.textContent = 'Drag frames in the strip above to reorder. Non-destructive.'
    p.appendChild(orderInfo)
    const resetBtn = document.createElement('button')
    resetBtn.className = 'se-btn'
    resetBtn.textContent = '↻ Reset Order'
    resetBtn.style.cssText = 'margin:4px 0'
    resetBtn.addEventListener('click', () => {
      this.frameOrder = entry.frameUrls.map((_, i) => i)
      this.renderFrameStrip()
      this.showFrame(0)
    })
    p.appendChild(resetBtn)
  }

  private buildCustomProps(cs: CustomSprite) {
    const p = this.propsPanel

    this.addSectionHead(p, 'Info')
    this.addReadonlyRow(p, 'ID', cs.id)
    this.addTextRow(p, 'Label', cs.label, (v) => { cs.label = v; this.saveCustom() })
    this.addTextRow(p, 'Icon', cs.icon, (v) => { cs.icon = v; this.saveCustom() })
    this.addSelectRow(p, 'Category', cs.category,
      [['terrain', 'Terrain'], ['characters', 'Characters'], ['items', 'Items'], ['hazards', 'Hazards'], ['obstacles', 'Obstacles']],
      (v) => { cs.category = v as SpriteCategory; this.saveCustom() })

    this.addSectionHead(p, 'Animation')
    this.addNumberRow(p, 'FPS', cs.fps, 1, 60, 1, (v) => { cs.fps = v; this.saveCustom() })
    this.addSelectRow(p, 'Anim Mode', cs.animMode,
      [['loop', 'Loop'], ['pingpong', 'Ping-Pong'], ['once', 'Once']],
      (v) => { cs.animMode = v as AnimMode; this.saveCustom() })

    this.addSectionHead(p, 'Hitbox')
    this.addNumberRow(p, 'Width', cs.hitboxW, 0.25, 20, 0.25, (v) => { cs.hitboxW = v; this.saveCustom() })
    this.addNumberRow(p, 'Height', cs.hitboxH, 0.25, 20, 0.25, (v) => { cs.hitboxH = v; this.saveCustom() })

    this.addSectionHead(p, 'Tiling & Snap')
    this.addSelectRow(p, 'Tiling', cs.tiling ?? 'none',
      [['none', 'None'], ['h', 'Horizontal'], ['v', 'Vertical']],
      (v) => { cs.tiling = v as TilingMode; this.saveCustom() })
    this.addSelectRow(p, 'Resize Snap', cs.snapUnit ?? 'free',
      [['free', 'Free (0.25 grid)'], ['tile', 'Whole tile']],
      (v) => { cs.snapUnit = v as SnapUnit; this.saveCustom() })

    this.addSectionHead(p, 'Editor Colors')
    this.addColorRow(p, 'Fill', cs.fill, (v) => { cs.fill = v; this.saveCustom() })
    this.addColorRow(p, 'Stroke', cs.stroke, (v) => { cs.stroke = v; this.saveCustom() })

    // Frame order
    this.addSectionHead(p, 'Frame Order')
    const orderInfo = document.createElement('div')
    orderInfo.style.cssText = 'font-size:10px;opacity:0.5;margin:2px 0 4px;padding:0 4px'
    orderInfo.textContent = 'Drag frames in the strip to reorder.'
    p.appendChild(orderInfo)
  }

  // ── Props helpers ─────────────────────────────────────────────────────────

  private addSectionHead(parent: HTMLElement, text: string) {
    const h = document.createElement('div')
    h.className = 'se-section-head'
    h.textContent = text
    parent.appendChild(h)
  }

  private addReadonlyRow(parent: HTMLElement, label: string, value: string) {
    const row = document.createElement('div')
    row.className = 'se-prop-row'
    const lbl = document.createElement('label')
    lbl.textContent = label
    const span = document.createElement('span')
    span.style.cssText = 'font-size:11px;opacity:0.7;word-break:break-all'
    span.textContent = value
    row.appendChild(lbl)
    row.appendChild(span)
    parent.appendChild(row)
  }

  private addNumberRow(parent: HTMLElement, label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, dataField?: string) {
    const row = document.createElement('div')
    row.className = 'se-prop-row'
    const lbl = document.createElement('label')
    lbl.textContent = label
    row.appendChild(lbl)
    const inp = document.createElement('input')
    inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.step = String(step)
    inp.value = String(value)
    if (dataField) inp.dataset.field = dataField
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value)
      if (!isNaN(v)) onChange(v)
    })
    row.appendChild(inp)
    parent.appendChild(row)
  }

  private addTextRow(parent: HTMLElement, label: string, value: string, onChange: (v: string) => void) {
    const row = document.createElement('div')
    row.className = 'se-prop-row'
    const lbl = document.createElement('label')
    lbl.textContent = label
    row.appendChild(lbl)
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.value = value
    inp.addEventListener('change', () => onChange(inp.value))
    row.appendChild(inp)
    parent.appendChild(row)
  }

  private addSelectRow(parent: HTMLElement, label: string, value: string, options: [string, string][], onChange: (v: string) => void) {
    const row = document.createElement('div')
    row.className = 'se-prop-row'
    const lbl = document.createElement('label')
    lbl.textContent = label
    row.appendChild(lbl)
    const sel = document.createElement('select')
    for (const [val, text] of options) {
      const o = document.createElement('option')
      o.value = val; o.textContent = text
      if (val === value) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => onChange(sel.value))
    row.appendChild(sel)
    parent.appendChild(row)
  }

  private addColorRow(parent: HTMLElement, label: string, value: string, onChange: (v: string) => void) {
    const row = document.createElement('div')
    row.className = 'se-prop-row'
    const lbl = document.createElement('label')
    lbl.textContent = label
    row.appendChild(lbl)
    const inp = document.createElement('input')
    inp.type = 'color'
    inp.value = value
    inp.addEventListener('change', () => onChange(inp.value))
    row.appendChild(inp)
    parent.appendChild(row)
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  private saveCustom() {
    saveCustomSprites(this.customSprites)
  }

  private async saveCurrentSprite() {
    if (this.selectedCustom) {
      this.saveCustom()
      this.statusEl.textContent = `Saved custom sprite "${this.selectedCustom.label}" to localStorage`
      return
    }

    if (!this.selectedSprite) return
    const entry = this.selectedSprite
    const cfg = { ...entry.config }

    // Add frameOrder if it differs from default
    const defaultOrder = entry.frameUrls.map((_, i) => i)
    const orderChanged = this.frameOrder.length !== defaultOrder.length ||
      this.frameOrder.some((v, i) => v !== defaultOrder[i])
    if (orderChanged) {
      cfg.frameOrder = [...this.frameOrder]
    } else {
      delete cfg.frameOrder
    }

    // Save to public/sprites/ via dev server
    const spritePath = entry.path + '/sprite.json'
    try {
      const resp = await fetch(`/__save_sprite/${encodeURIComponent(spritePath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg, null, 2),
      })
      if (resp.ok) {
        // Update in-memory maps so game engine picks up changes immediately
        const kind = cfg.kind
        if (kind && DEFAULT_SPRITE_MAP[kind]) {
          const mapEntry = DEFAULT_SPRITE_MAP[kind]
          if (cfg.spriteScale !== undefined) mapEntry.spriteScale = cfg.spriteScale
          if (cfg.fps !== undefined) mapEntry.fps = cfg.fps
          if (cfg.animMode) mapEntry.animMode = cfg.animMode
          if (cfg.defaultSize && Array.isArray(cfg.defaultSize) && cfg.defaultSize.length === 2) {
            DEFAULT_SIZE[kind] = [cfg.defaultSize[0], cfg.defaultSize[1]]
          }
        }
        // Update SPRITE_METADATA too
        const meta = SPRITE_METADATA.get(entry.path) ?? {}
        if (cfg.visual_w !== undefined) meta.visual_w = cfg.visual_w
        if (cfg.visual_h !== undefined) meta.visual_h = cfg.visual_h
        if (cfg.fps !== undefined) meta.fps = cfg.fps
        SPRITE_METADATA.set(entry.path, meta)

        this.statusEl.textContent = `Saved ${entry.path}/sprite.json to public/sprites/`
      } else {
        this.statusEl.textContent = `Save failed: ${resp.statusText}`
      }
    } catch {
      this.statusEl.textContent = 'Save failed — dev server may not be running'
    }
  }

  // ── Export: ZIP ────────────────────────────────────────────────────────────

  private async exportZip() {
    if (!this.selectedSprite && !this.selectedCustom) return

    const zip = new JSZip()

    if (this.selectedSprite) {
      const entry = this.selectedSprite
      // Add sprite.json
      const cfg = { ...entry.config }
      const defaultOrder = entry.frameUrls.map((_, i) => i)
      const orderChanged = this.frameOrder.length !== defaultOrder.length ||
        this.frameOrder.some((v, i) => v !== defaultOrder[i])
      if (orderChanged) cfg.frameOrder = [...this.frameOrder]
      zip.file('sprite.json', JSON.stringify(cfg, null, 2))

      // Add frame images in order
      for (let i = 0; i < this.frameOrder.length; i++) {
        const fIdx = this.frameOrder[i]
        const img = this.frameImages[fIdx]
        if (!img) continue
        const blob = await this.imageToBlob(img)
        zip.file(`${String(i).padStart(3, '0')}.png`, blob)
      }
    } else if (this.selectedCustom) {
      const cs = this.selectedCustom
      const cfg: SpriteConfig = {
        kind: cs.id,
        fps: cs.fps,
        animMode: cs.animMode,
        frameCount: cs.frames.length,
      }
      zip.file('sprite.json', JSON.stringify(cfg, null, 2))
      for (let i = 0; i < this.frameOrder.length; i++) {
        const fIdx = this.frameOrder[i]
        if (cs.frames[fIdx]) {
          const blob = await this.dataUrlToBlob(cs.frames[fIdx])
          zip.file(`${String(i).padStart(3, '0')}.png`, blob)
        }
      }
    }

    const blob = await zip.generateAsync({ type: 'blob' })
    this.downloadBlob(blob, `${this.getSpriteLabel()}.zip`)
  }

  // ── Export: Spritesheet PNG ────────────────────────────────────────────────

  private exportSpritesheet() {
    if (this.frameOrder.length === 0 || this.frameImages.length === 0) return

    // Determine grid: try to make it roughly square
    const total = this.frameOrder.length
    const cols = Math.ceil(Math.sqrt(total))
    const rows = Math.ceil(total / cols)

    // Use first valid frame for dimensions
    const sampleIdx = this.frameOrder.find(i => this.frameImages[i]) ?? 0
    const sample = this.frameImages[sampleIdx]
    if (!sample) return
    const fw = sample.naturalWidth
    const fh = sample.naturalHeight

    const canvas = document.createElement('canvas')
    canvas.width = cols * fw
    canvas.height = rows * fh
    const ctx = canvas.getContext('2d')!

    for (let i = 0; i < this.frameOrder.length; i++) {
      const img = this.frameImages[this.frameOrder[i]]
      if (!img) continue
      const col = i % cols
      const row = Math.floor(i / cols)
      ctx.drawImage(img, col * fw, row * fh, fw, fh)
    }

    canvas.toBlob((blob) => {
      if (blob) this.downloadBlob(blob, `${this.getSpriteLabel()}_sheet.png`)
    }, 'image/png')
  }

  // ── Export: GIF ────────────────────────────────────────────────────────────

  private async exportGif() {
    if (this.frameOrder.length === 0 || this.frameImages.length === 0) return

    // Use canvas-based GIF encoding (simple approach without gif.js dependency)
    // Build an animated PNG as a sequence — for true GIF we'd need gif.js.
    // Since gif.js has web worker requirements, we'll create a simple GIF
    // using a manual encoder.

    const fps = this.getCurrentFps()
    const delay = Math.round(1000 / fps)

    // For simplicity, export as an animated spritesheet with metadata
    // until gif.js can be properly integrated with workers
    const sampleIdx = this.frameOrder.find(i => this.frameImages[i]) ?? 0
    const sample = this.frameImages[sampleIdx]
    if (!sample) return
    const fw = sample.naturalWidth
    const fh = sample.naturalHeight

    // Create individual frame canvases and encode manually
    const frames: ImageData[] = []
    const canvas = document.createElement('canvas')
    canvas.width = fw
    canvas.height = fh
    const ctx = canvas.getContext('2d')!

    for (const orderIdx of this.frameOrder) {
      const img = this.frameImages[orderIdx]
      if (!img) continue
      ctx.clearRect(0, 0, fw, fh)
      ctx.drawImage(img, 0, 0, fw, fh)
      frames.push(ctx.getImageData(0, 0, fw, fh))
    }

    // Encode as GIF using inline encoder
    const gif = this.encodeGif(fw, fh, frames, delay)
    const blob = new Blob([gif.buffer as ArrayBuffer], { type: 'image/gif' })
    this.downloadBlob(blob, `${this.getSpriteLabel()}.gif`)
  }

  // Minimal GIF89a encoder — supports animation, transparency optional
  private encodeGif(width: number, height: number, frames: ImageData[], delay: number): Uint8Array {
    const buf: number[] = []
    const push = (...bytes: number[]) => buf.push(...bytes)
    const pushStr = (s: string) => { for (let i = 0; i < s.length; i++) buf.push(s.charCodeAt(i)) }
    const pushLE16 = (v: number) => { push(v & 0xff, (v >> 8) & 0xff) }

    // Quantize each frame to 256 colours (simple median-cut would be ideal,
    // but for reasonable quality we use a fast fixed palette approach)
    const buildPalette = (data: Uint8Array): { palette: number[]; indexed: Uint8Array } => {
      // Collect unique colours (max 256), with simple hash
      const colorMap = new Map<number, number>()
      const palette: number[] = []
      const indexed = new Uint8Array(width * height)
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2]
        const key = (r << 16) | (g << 8) | b
        let ci = colorMap.get(key)
        if (ci === undefined) {
          if (palette.length / 3 < 256) {
            ci = palette.length / 3
            palette.push(r, g, b)
            colorMap.set(key, ci)
          } else {
            // Find nearest colour
            let best = 0, bestDist = Infinity
            for (let c = 0; c < 256; c++) {
              const dr = palette[c * 3] - r, dg = palette[c * 3 + 1] - g, db = palette[c * 3 + 2] - b
              const d = dr * dr + dg * dg + db * db
              if (d < bestDist) { bestDist = d; best = c }
            }
            ci = best
          }
        }
        indexed[i / 4] = ci
      }
      // Pad palette to power of 2 size
      while (palette.length / 3 < 256) palette.push(0, 0, 0)
      return { palette, indexed }
    }

    // LZW encoder
    const lzwEncode = (indexed: Uint8Array, minCodeSize: number): number[] => {
      const clearCode = 1 << minCodeSize
      const eoiCode = clearCode + 1
      let codeSize = minCodeSize + 1
      let nextCode = eoiCode + 1
      const output: number[] = []
      let bits = 0
      let bitCount = 0

      const emit = (code: number) => {
        bits |= code << bitCount
        bitCount += codeSize
        while (bitCount >= 8) {
          output.push(bits & 0xff)
          bits >>= 8
          bitCount -= 8
        }
      }

      // Use a trie for the code table
      const table = new Map<string, number>()
      const reset = () => {
        table.clear()
        for (let i = 0; i < clearCode; i++) table.set(String(i), i)
        nextCode = eoiCode + 1
        codeSize = minCodeSize + 1
      }

      reset()
      emit(clearCode)

      let prefix = String(indexed[0])
      for (let i = 1; i < indexed.length; i++) {
        const c = String(indexed[i])
        const key = prefix + ',' + c
        if (table.has(key)) {
          prefix = key
        } else {
          emit(table.get(prefix)!)
          if (nextCode < 4096) {
            table.set(key, nextCode++)
            if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++
          } else {
            emit(clearCode)
            reset()
          }
          prefix = c
        }
      }
      emit(table.get(prefix)!)
      emit(eoiCode)
      if (bitCount > 0) output.push(bits & 0xff)
      return output
    }

    // Header
    pushStr('GIF89a')
    pushLE16(width)
    pushLE16(height)
    push(0xf7, 0, 0) // GCT flag, 256 colours, bg=0, aspect=0

    // Global colour table  (placeholder — first frame's palette)
    const firstResult = buildPalette(frames[0].data as unknown as Uint8Array)
    for (let i = 0; i < 768; i++) push(firstResult.palette[i])

    // Netscape extension for looping
    push(0x21, 0xff, 0x0b)
    pushStr('NETSCAPE2.0')
    push(3, 1); pushLE16(0); push(0) // loop forever

    // Frames
    for (let f = 0; f < frames.length; f++) {
      const { palette, indexed } = f === 0 ? firstResult : buildPalette(frames[f].data as unknown as Uint8Array)

      // Graphic control extension
      push(0x21, 0xf9, 4)
      push(0x00) // disposal: none, no transparency
      pushLE16(Math.round(delay / 10)) // delay in centiseconds
      push(0, 0) // transparent colour index, terminator

      // Image descriptor
      push(0x2c)
      pushLE16(0); pushLE16(0)  // position
      pushLE16(width); pushLE16(height)

      if (f === 0) {
        push(0x00) // no local colour table (use global)
      } else {
        push(0x87) // local colour table, 256 entries
        for (let i = 0; i < 768; i++) push(palette[i])
      }

      // LZW minimum code size
      const minCodeSize = 8
      push(minCodeSize)
      const lzwData = lzwEncode(indexed, minCodeSize)
      // Sub-blocks
      let pos = 0
      while (pos < lzwData.length) {
        const chunk = Math.min(255, lzwData.length - pos)
        push(chunk)
        for (let i = 0; i < chunk; i++) push(lzwData[pos + i])
        pos += chunk
      }
      push(0) // block terminator
    }

    push(0x3b) // GIF trailer
    return new Uint8Array(buf)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getSpriteLabel(): string {
    if (this.selectedSprite) return this.selectedSprite.path.replace(/\//g, '_')
    if (this.selectedCustom) return this.selectedCustom.id
    return 'sprite'
  }

  private async imageToBlob(img: HTMLImageElement): Promise<Blob> {
    const cv = document.createElement('canvas')
    cv.width = img.naturalWidth; cv.height = img.naturalHeight
    cv.getContext('2d')!.drawImage(img, 0, 0)
    return new Promise(resolve => {
      cv.toBlob(b => resolve(b!), 'image/png')
    })
  }

  private async dataUrlToBlob(dataUrl: string): Promise<Blob> {
    if (!dataUrl.startsWith('data:')) {
      throw new Error('Invalid data URL: must start with data:')
    }
    const resp = await fetch(dataUrl)
    return resp.blob()
  }

  private downloadBlob(blob: Blob, filename: string) {
    const a = document.createElement('a')
    const url = URL.createObjectURL(blob)
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // ── Importer ──────────────────────────────────────────────────────────────

  private openImporter() {
    this.importerSheetImg = null
    this.importerExtracted = []
    const canvas = this.importerModal.querySelector<HTMLCanvasElement>('#se-imp-canvas')
    if (canvas) canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height)
    const framesRow = document.getElementById('se-imp-frames-row')
    if (framesRow) framesRow.innerHTML = ''
    const fileInput = document.getElementById('se-imp-file') as HTMLInputElement
    if (fileInput) fileInput.value = ''
    const fname = document.getElementById('se-imp-filename')
    if (fname) fname.textContent = 'No file selected'
    const addBtn = document.getElementById('se-imp-add') as HTMLButtonElement
    if (addBtn) addBtn.disabled = true
    this.importerModal.style.display = 'flex'
    ;(document.getElementById('se-imp-close') as HTMLElement)?.focus()
  }

  private closeImporter() {
    this.importerModal.style.display = 'none'
    ;(document.getElementById('se-import-sprite') as HTMLElement)?.focus()
  }

  private onImporterFileSelect(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    const fname = document.getElementById('se-imp-filename')
    if (fname) fname.textContent = file.name

    const img = new Image()
    img.onload = () => {
      this.importerSheetImg = img
      this.renderImporterPreview()
    }
    const reader = new FileReader()
    reader.onload = () => { img.src = reader.result as string }
    reader.readAsDataURL(file)
  }

  private renderImporterPreview() {
    const canvas = document.getElementById('se-imp-canvas') as HTMLCanvasElement | null
    if (!canvas || !this.importerSheetImg) return
    const cols = parseInt((document.getElementById('se-imp-cols') as HTMLInputElement).value) || 1
    const rows = parseInt((document.getElementById('se-imp-rows') as HTMLInputElement).value) || 1
    const offX = parseInt((document.getElementById('se-imp-ox') as HTMLInputElement).value) || 0
    const offY = parseInt((document.getElementById('se-imp-oy') as HTMLInputElement).value) || 0

    const MAX = 480
    const aspect = this.importerSheetImg.naturalWidth / this.importerSheetImg.naturalHeight
    const dw = aspect >= 1 ? MAX : MAX * aspect
    const dh = aspect >= 1 ? MAX / aspect : MAX
    canvas.width = dw; canvas.height = dh
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, dw, dh)
    ctx.drawImage(this.importerSheetImg, 0, 0, dw, dh)

    ctx.strokeStyle = '#ffe000'; ctx.lineWidth = 1
    const cellW = (dw - offX) / cols, cellH = (dh - offY) / rows
    for (let c = 0; c <= cols; c++) { const x = offX + c * cellW; ctx.beginPath(); ctx.moveTo(x, offY); ctx.lineTo(x, dh); ctx.stroke() }
    for (let r = 0; r <= rows; r++) { const y = offY + r * cellH; ctx.beginPath(); ctx.moveTo(offX, y); ctx.lineTo(dw, y); ctx.stroke() }
  }

  private extractImporterFrames() {
    if (!this.importerSheetImg) return
    const cols = parseInt((document.getElementById('se-imp-cols') as HTMLInputElement).value) || 1
    const rows = parseInt((document.getElementById('se-imp-rows') as HTMLInputElement).value) || 1
    const offX = parseInt((document.getElementById('se-imp-ox') as HTMLInputElement).value) || 0
    const offY = parseInt((document.getElementById('se-imp-oy') as HTMLInputElement).value) || 0
    const maxFrames = parseInt((document.getElementById('se-imp-frames') as HTMLInputElement).value) || 0
    const iw = this.importerSheetImg.naturalWidth, ih = this.importerSheetImg.naturalHeight
    const cellW = (iw - offX) / cols, cellH = (ih - offY) / rows
    const frames: string[] = []
    const offscreen = document.createElement('canvas')
    offscreen.width = Math.floor(cellW); offscreen.height = Math.floor(cellH)
    const ctx = offscreen.getContext('2d')!
    const limit = maxFrames > 0 ? maxFrames : cols * rows

    for (let r = 0; r < rows && frames.length < limit; r++) {
      for (let c = 0; c < cols && frames.length < limit; c++) {
        ctx.clearRect(0, 0, offscreen.width, offscreen.height)
        ctx.drawImage(this.importerSheetImg,
          offX + c * cellW, offY + r * cellH, cellW, cellH,
          0, 0, offscreen.width, offscreen.height)
        frames.push(offscreen.toDataURL('image/png'))
      }
    }

    this.importerExtracted = frames
    const framesRow = document.getElementById('se-imp-frames-row')!
    framesRow.innerHTML = ''
    for (const src of frames) {
      const img = document.createElement('img')
      img.src = src; img.className = 'se-frame-thumb'
      framesRow.appendChild(img)
    }

    const addBtn = document.getElementById('se-imp-add') as HTMLButtonElement
    addBtn.disabled = frames.length === 0
  }

  private addImportedSprite() {
    if (this.importerExtracted.length === 0) return
    const id = (document.getElementById('se-imp-id') as HTMLInputElement).value.trim() || `custom_${Date.now()}`
    const label = (document.getElementById('se-imp-label') as HTMLInputElement).value.trim() || id
    const icon = (document.getElementById('se-imp-icon') as HTMLInputElement).value.trim() || '🧱'
    const category = (document.getElementById('se-imp-cat') as HTMLSelectElement).value as SpriteCategory
    const fill = (document.getElementById('se-imp-fill') as HTMLInputElement).value
    const stroke = (document.getElementById('se-imp-stroke') as HTMLInputElement).value
    const hitboxW = parseFloat((document.getElementById('se-imp-hw') as HTMLInputElement).value) || 1.5
    const hitboxH = parseFloat((document.getElementById('se-imp-hh') as HTMLInputElement).value) || 1.0
    const fps = parseInt((document.getElementById('se-imp-fps') as HTMLInputElement).value) || 8
    const animMode = (document.getElementById('se-imp-anim-mode') as HTMLSelectElement).value as AnimMode
    const tiling = (document.getElementById('se-imp-tiling') as HTMLSelectElement).value as TilingMode
    const snapUnit = (document.getElementById('se-imp-snap') as HTMLSelectElement).value as SnapUnit
    const obstacleType: ObstacleType | undefined = category === 'obstacles'
      ? (document.getElementById('se-imp-obstacle-type') as HTMLSelectElement).value as ObstacleType
      : undefined

    // Check for duplicate IDs
    if (this.customSprites.some(cs => cs.id === id)) {
      if (!confirm(`A sprite with ID "${id}" already exists. Replace it?`)) return
      this.customSprites = this.customSprites.filter(cs => cs.id !== id)
    }

    const cs: CustomSprite = {
      id, label, icon, iconFrame: 0,
      fill, stroke, hitboxW, hitboxH, fps, animMode,
      category, obstacleType,
      tiling: tiling !== 'none' ? tiling : undefined,
      snapUnit: snapUnit !== 'free' ? snapUnit : undefined,
      frames: this.importerExtracted,
    }
    this.customSprites.push(cs)
    saveCustomSprites(this.customSprites)
    this.rebuildPalette()
    this.closeImporter()
    this.selectCustomSprite(cs)
    this.statusEl.textContent = `Imported "${label}" with ${cs.frames.length} frames`
  }

  // ── Public API ────────────────────────────────────────────────────────────

  show() {
    this.customSprites = loadCustomSprites()
    this.rebuildPalette()
    this.el.style.display = 'flex'
    // Merge any public/sprites/ overrides into the in-memory sprite configs
    this.loadSpriteOverrides()
  }

  /**
   * Fetch sprite.json overrides saved to public/sprites/ via the dev server
   * and merge their fields into the corresponding ALL_SPRITES entries so the
   * editor reflects the latest saved state.
   */
  private async loadSpriteOverrides() {
    try {
      const resp = await fetch('/__sprite_index', { cache: 'no-store' })
      if (!resp.ok) return
      const files = (await resp.json()) as string[]
      await Promise.all(files.map(async (filePath) => {
        try {
          const r = await fetch(`/__read_sprite/${encodeURIComponent(filePath)}`, { cache: 'no-store' })
          if (!r.ok) return
          const override = await r.json() as Partial<SpriteConfig>
          const spritePath = filePath.replace(/\/sprite\.json$/, '')
          const entry = ALL_SPRITES.find(e => e.path === spritePath)
          if (!entry) return
          // Merge override fields into the entry's config
          Object.assign(entry.config, override)
        } catch { /* skip unreadable override */ }
      }))
      // If a sprite is currently selected, refresh its UI
      if (this.selectedSprite) {
        this.syncScaleControls(this.selectedSprite.config.spriteScale ?? 1.0)
        this.buildPropsPanel()
        this.redrawCurrentFrame()
      }
    } catch { /* no dev server — skip */ }
  }

  hide() {
    this.stopPreviewAnim()
    this.el.style.display = 'none'
  }
}
