import * as THREE from 'three'
import './style.css'
import yoyoSpriteUrl from './assets/sprites/weapons/yoyo/yoyo.png'
import frakBubbleUrl from './assets/sprites/frak.png'
const titleBgUrls = Object.values(
  import.meta.glob('./assets/title/*.png', { query: '?url', import: 'default', eager: true }) as Record<string, string>
)
import level1BgUrl from './assets/background/level1_background.png'
import level2BgUrl from './assets/background/level2_background.png'
import level3BgUrl from './assets/background/level3_background.png'
import level0MusicUrl from './assets/music/Frak-level0.vgz?url'
import level1MusicUrl from './assets/music/Frak-level1.vgz?url'
import level2MusicUrl from './assets/music/Frak-level2.vgz?url'
import level3MusicUrl from './assets/music/Frak-level3.vgz?url'
import level0Mp3Url from './assets/music/Frak-level0.mp3?url'
import level1Mp3Url from './assets/music/Frak-level1.mp3?url'
import level2Mp3Url from './assets/music/Frak-level2.mp3?url'
import level3Mp3Url from './assets/music/Frak-level3.mp3?url'
import sfxLifeLostOeUrl from './assets/sfx/lifelost.mp3?url'
import sfxLifeLostRemasterUrl from './assets/sfx/lifelost-remaster.mp3?url'
import { VgmPlayer } from './vgm-player'
import { LevelEditor, SPRITE_METADATA, DEFAULT_SPRITE_MAP, DEFAULT_SIZE } from './level-editor'
import type { LevelFile, SpriteMapEntry, AnimMode } from './level-editor'
import { SpriteEditor } from './sprite-editor'

type Rect = {
  x: number
  y: number
  w: number
  h: number
}

type PlayerState = {
  x: number
  y: number
  vx: number
  vy: number
  w: number
  h: number
  grounded: boolean
  climbing: boolean
  dead: boolean
  facing: -1 | 1
}

type Collectible = {
  rect: Rect
  mesh: THREE.Mesh
  active: boolean
  kind: string            // element kind from editor (e.g. 'key', 'bulb', 'diamond')
  mandatory: boolean      // must collect all mandatory items to complete level
  scoreValue: number      // points awarded on pickup
  hud: boolean            // show progress in HUD
  hudLabel: string         // HUD display label
  frames: THREE.MeshBasicMaterial[]
  animPhase: number
  animFps: number
  animMode: AnimMode
  visualY: number
}

type MonsterAnimEntry = { f: number; flip: boolean }

type Monster = {
  rect: Rect
  mesh: THREE.Mesh
  visualYOffset: number
  active: boolean
  knocked: boolean
  vx: number
  vy: number
  spin: number
  spriteScale: number
  invertedSprite: boolean
  frames: THREE.MeshBasicMaterial[] | null
  deathFrames: THREE.MeshBasicMaterial[] | null
  animTime: number
  deathAnimTime: number
  animRate: number
  animSeq: MonsterAnimEntry[] | null
  animSeqPos: number
}

type Hazard = {
  rect: Rect
  mesh: THREE.Mesh
  vx: number
  vy: number
  animTime: number
  kind: string
  animated: boolean
  animFps: number
  animMode: AnimMode
  hazardFrames: THREE.MeshBasicMaterial[] | null
}

type Obstacle = {
  rect: Rect
  mesh: THREE.Mesh
  kind: string
  blocking: boolean        // true = solid barrier, false = kills player on touch
  frames: THREE.MeshBasicMaterial[]
  animTime: number
  animFps: number
  animMode: AnimMode
}

type LevelData = {
  platforms: Rect[]
  ladders: Rect[]
  monsters: Rect[]
  keys: Rect[]
  treasures: Rect[]
  bulbs: Rect[]
  exit: Rect
}

type RectTuple = [number, number, number, number]

type RawLevelData = {
  platforms: RectTuple[]
  ladders: RectTuple[]
  monsters: RectTuple[]
  keys: RectTuple[]
  treasures: RectTuple[]
  bulbs?: RectTuple[]
  exit: RectTuple
}

const tupleToRect = ([x, y, w, h]: RectTuple): Rect => ({ x, y, w, h })
const tuplesToRects = (rows: RectTuple[]): Rect[] => rows.map(tupleToRect)

/** Compute ping-pong frame index: 0,1,…,N-1,…,1 repeating over `period = 2*(N-1)` */
const pingPongFrame = (tick: number, frameCount: number): number => {
  if (frameCount <= 1) return 0
  const period = 2 * (frameCount - 1)
  const pos = ((tick % period) + period) % period  // handle negative ticks
  return pos < frameCount ? pos : period - pos
}

const rawToLevelData = (raw: RawLevelData): LevelData => ({
  platforms: tuplesToRects(raw.platforms),
  ladders: tuplesToRects(raw.ladders),
  monsters: tuplesToRects(raw.monsters),
  keys: tuplesToRects(raw.keys),
  treasures: tuplesToRects(raw.treasures),
  bulbs: tuplesToRects(raw.bulbs ?? []),
  exit: tupleToRect(raw.exit),
})

// ── MP3 player (for 'new' / remaster music style) ───────────────────────────
class Mp3Player {
  private audio: HTMLAudioElement | null = null
  private _enabled = true

  play(url: string) {
    if (!this._enabled) return
    if (this.audio) { this.audio.pause(); this.audio.src = '' }
    const a = new Audio(url)
    a.loop = true
    a.volume = 0.7
    this.audio = a
    a.play().catch((e) => console.warn('[mp3 play]', e))
  }

  stop() {
    if (this.audio) { this.audio.pause(); this.audio.src = ''; this.audio = null }
  }

  setEnabled(on: boolean) {
    this._enabled = on
    if (!on) this.stop()
  }

  get enabled() { return this._enabled }
}

// ── Music style preference ───────────────────────────────────────────────────
// 'original' = VGZ chiptune, 'new' = MP3 remaster
const storedMusicStyle = localStorage.getItem('frak_music_style')
let musicStyle: 'original' | 'new' =
  storedMusicStyle === 'original' || storedMusicStyle === 'new' ? storedMusicStyle : 'original'

// Index 0 = title screen, 1-3 = levels 1-3
const vgzUrls = [level0MusicUrl, level1MusicUrl, level2MusicUrl, level3MusicUrl]
const mp3Urls  = [level0Mp3Url,  level1Mp3Url,  level2Mp3Url,  level3Mp3Url]

/** Format seconds as mm:ss for timer display. */
const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Stop all music playback (both VGM and MP3 players). */
const stopAllMusic = () => {
  vgmPlayer.stop()
  mp3Player.stop()
}

/** Play a music track by index (0=title, 1-3=levels) using current musicStyle. */
const playTrack = (trackIndex: number) => {
  stopAllMusic()
  if (musicStyle === 'new') {
    mp3Player.play(mp3Urls[trackIndex])
  } else {
    vgmPlayer.play(vgzUrls[trackIndex])
  }
}

const playTitleMusic = () => {
  if (!musicEnabled) return
  playTrack(0)
}

const vgmPlayer = new VgmPlayer()
// Pre-render VGZ tracks in the background so they're ready on first level load
vgzUrls.forEach((url) =>
  vgmPlayer.preload([url]).catch((e) => console.warn('[music preload]', e)),
)
const mp3Player = new Mp3Player()

let musicEnabled = (localStorage.getItem('frak_music_enabled') ?? 'true') === 'true'
let jumpZoomEnabled = (localStorage.getItem('frak_jump_zoom') ?? 'true') === 'true'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Missing #app container')

app.innerHTML = `
  <div class="game-shell">
    <div class="hud">
      <span id="lives">Lives: 3</span>
      <span id="score">Score: 0</span>
      <span id="level">Level: 1</span>
      <span id="keys">Keys: 0/0</span>
      <span id="timer"></span>
      <button id="game-help-btn" class="game-help-btn" title="How to play" aria-label="How to play">?</button>
      <label id="zoom-ui"><input id="jump-zoom-toggle" type="checkbox" ${jumpZoomEnabled ? 'checked' : ''} /> Zoom</label>
      <input id="music-toggle" type="checkbox" ${musicEnabled ? 'checked' : ''} style="display:none" />
      <span id="status" aria-live="polite"></span>
    </div>
    <div class="canvas-wrap">
      <canvas id="game-canvas" aria-label="Frak 2.5D prototype"></canvas>
      <div class="touch-controls" aria-hidden="true">
        <button data-control="left" aria-label="Move left">◀</button>
        <button data-control="right" aria-label="Move right">▶</button>
        <button data-control="up" aria-label="Climb up">▲</button>
        <button data-control="down" aria-label="Climb down">▼</button>
        <button data-control="jump" aria-label="Jump">JUMP</button>
        <button data-control="attack" aria-label="Throw yoyo">YOYO</button>
      </div>
    </div>
  </div>
  <div id="title-screen" class="overlay-screen title-screen">
    <header class="title-header">
      <canvas id="cv-title-logo" class="title-logo-cv" width="220" height="136" aria-label="Frak game logo"></canvas>
      <p class="title-subtitle">The Cast</p>
    </header>
    <!-- The Cast: character walk-in + showcase -->
    <div class="title-stage" aria-hidden="true">
      <div class="title-cast">
        <div class="cast-chars">
          <div class="cast-row" id="cr-trogg">
            <canvas id="cv-trogg" class="cast-cv" width="100" height="220"></canvas>
            <p class="cast-vs">Vs.</p>
            <span class="cast-name">Trogg</span>
          </div>
          <div class="cast-row cast-enemy-row" id="cr-scrubbly">
            <canvas id="cv-scrubbly" class="cast-cv" width="100" height="120"></canvas>
            <span class="cast-name">Scrubbly</span>
          </div>
          <div class="cast-row cast-enemy-row" id="cr-hooter">
            <canvas id="cv-hooter" class="cast-cv" width="100" height="120"></canvas>
            <span class="cast-name">Hooter</span>
          </div>
          <div class="cast-row cast-enemy-row" id="cr-poglet">
            <canvas id="cv-poglet" class="cast-cv" width="80" height="120"></canvas>
            <span class="cast-name">Poglet</span>
          </div>
        </div>
      </div>
    </div>
    <div class="title-options">
      <div class="title-options-col">
        <p class="opts-heading">Music</p>
        <label class="arcade-check">
          <input type="checkbox" id="title-music-toggle" ${musicEnabled ? 'checked' : ''} />
          <span class="chk-box"></span>
          <span class="chk-text">Sound on</span>
        </label>
        <div class="arcade-radio-row">
          <label class="arcade-radio-opt">
            <input type="radio" name="music-style" id="music-style-original" value="original" ${musicStyle === 'original' ? 'checked' : ''} />
            <span>Original</span>
          </label>
          <label class="arcade-radio-opt">
            <input type="radio" name="music-style" id="music-style-new" value="new" ${musicStyle === 'new' ? 'checked' : ''} />
            <span>Remaster</span>
          </label>
        </div>
      </div>
      <button id="title-start" class="title-start-btn">PRESS START</button>
      <div id="title-level-select-wrap" style="display:none;margin-top:0.4em">
        <select id="title-level-select" style="font-family:monospace;font-size:0.75em;padding:0.4em 0.8em;background:rgba(10,30,60,0.85);color:#a0d0ff;border:1px solid #3a80c0;border-radius:4px;cursor:pointer"></select>
      </div>
      <button id="title-editor" class="title-start-btn title-editor-btn">Level Editor</button>
      <button id="title-sprite-editor" class="title-start-btn title-editor-btn">Sprite Editor</button>
      <div class="title-options-col">
        <p class="opts-heading">Display</p>
        <label class="arcade-check">
          <input type="checkbox" id="title-jump-zoom" ${jumpZoomEnabled ? 'checked' : ''} />
          <span class="chk-box"></span>
          <span class="chk-text">Jump zoom</span>
        </label>
      </div>
    </div>
    <button id="title-help-btn" class="title-help-btn" title="How to play" aria-label="How to play">?</button>
  </div>
  <!-- Instructions modal -->
  <div id="help-modal" class="help-modal" style="display:none" role="dialog" aria-modal="true" aria-label="How to Play">
    <div class="help-modal-inner">
      <button id="help-modal-close" class="help-modal-close" aria-label="Close">&times;</button>
      <h2 class="help-title">How to Play</h2>
      <div class="help-body">
        <section class="help-section">
          <h3>🎯 Objective</h3>
          <p>Collect all the <strong>keys</strong> 🔑 in each level to advance. Avoid enemies and hazards! You have <strong>3 lives</strong> and a <strong>2-minute timer</strong> per level.</p>
        </section>
        <section class="help-section">
          <h3>🕹️ Controls</h3>
          <table class="help-keys" id="help-keys-table">
          </table>
          <button id="help-remap-btn" class="help-remap-btn">⌨️ Customise Keys</button>
          <p class="help-touch-note">📱 On mobile/touchscreen, use the on-screen buttons.</p>
        </section>
        <section class="help-section">
          <h3>⚔️ Characters</h3>
          <p><strong>Trogg</strong> — that's you! Use your trusty <strong>yoyo</strong> to knock out enemies.</p>
          <p>Enemies patrol the platforms. Hit them with your yoyo to knock them off!</p>
          <ul class="help-enemies">
            <li>🟠 <strong>Scrubbly</strong> — bounces along platforms</li>
            <li>🟣 <strong>Hooter</strong> — waddles back and forth</li>
            <li>🟢 <strong>Poglet</strong> — small but fast</li>
          </ul>
        </section>
        <section class="help-section">
          <h3>⚠️ Hazards</h3>
          <p>Watch out for <strong>balloons</strong> 🎈 floating up and <strong>daggers</strong> 🗡️ falling from the sky — both are instant death on contact!</p>
        </section>
        <section class="help-section">
          <h3>💡 Tips</h3>
          <ul>
            <li>Your yoyo has good reach — use it from a safe distance</li>
            <li>Knocked enemies fly off screen and respawn, so stay alert</li>
            <li>Press <kbd id="help-map-key">M</kbd> to see the full map and plan your route</li>
            <li>Collect all keys to complete the level</li>
          </ul>
        </section>
      </div>
      <button id="help-modal-ok" class="help-modal-ok">Got it!</button>
    </div>
  </div>
  <!-- Key remap dialog -->
  <div id="remap-modal" class="help-modal" style="display:none" role="dialog" aria-modal="true" aria-label="Customise Keys">
    <div class="help-modal-inner remap-modal-inner">
      <button id="remap-modal-close" class="help-modal-close" aria-label="Close">&times;</button>
      <h2 class="help-title">⌨️ Customise Keys</h2>
      <p class="remap-instructions">Click an action, then press the key you want to assign. Each action can have multiple keys.</p>
      <table class="help-keys remap-table" id="remap-table"></table>
      <div class="remap-buttons">
        <button id="remap-reset" class="remap-btn remap-reset-btn">Reset to Defaults</button>
        <button id="remap-done" class="help-modal-ok">Done</button>
      </div>
    </div>
  </div>
  <div id="gameover-screen" class="overlay-screen" style="display:none" role="alert" aria-label="Game Over">
    <h1 class="overlay-title">GAME OVER</h1>
    <p class="overlay-prompt">Press any key or tap to continue</p>
  </div>
  <div id="dry-run-banner" style="display:none;position:fixed;top:0;left:0;right:0;z-index:150;background:rgba(20,60,20,0.92);border-bottom:2px solid #40ff80;padding:6px 16px;align-items:center;gap:16px;font-family:monospace;font-size:13px;color:#90ff90">
    <span style="font-weight:700;letter-spacing:0.1em">▶ DRY RUN</span>
    <span style="opacity:0.7">All physics active · Complete the level or fall off to end</span>
    <button id="dry-run-back" style="margin-left:auto;padding:4px 14px;border-radius:4px;border:1px solid #40ff80;background:rgba(0,40,0,0.8);color:#80ff80;cursor:pointer;font-size:12px">← Back to Editor</button>
  </div>
`

const scoreEl = document.querySelector<HTMLSpanElement>('#score')!
const livesEl = document.querySelector<HTMLSpanElement>('#lives')!
const levelEl = document.querySelector<HTMLSpanElement>('#level')!
const keysEl = document.querySelector<HTMLSpanElement>('#keys')!
const statusEl = document.querySelector<HTMLSpanElement>('#status')!
const timerEl = document.querySelector<HTMLSpanElement>('#timer')!
const jumpZoomToggleEl = document.querySelector<HTMLInputElement>('#jump-zoom-toggle')!
const musicToggleEl = document.querySelector<HTMLInputElement>('#music-toggle')!
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!
const canvasWrap = document.querySelector<HTMLDivElement>('.canvas-wrap')!
const titleScreenEl = document.querySelector<HTMLDivElement>('#title-screen')!
const randomizeTitleBg = () => {
  const url = titleBgUrls[Math.floor(Math.random() * titleBgUrls.length)]
  titleScreenEl.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.65), rgba(0,0,0,0.65)), url(${url})`
}
randomizeTitleBg()
const gameoverScreenEl = document.querySelector<HTMLDivElement>('#gameover-screen')!
const titleMusicToggleEl = document.querySelector<HTMLInputElement>('#title-music-toggle')!
const titleJumpZoomEl = document.querySelector<HTMLInputElement>('#title-jump-zoom')!
const titleStartBtn = document.querySelector<HTMLButtonElement>('#title-start')!

// ── Title cast canvas refs ─────────────────────────────────────────────────
const castCvTrogg    = document.getElementById('cv-trogg')    as HTMLCanvasElement
const castCvScrubbly = document.getElementById('cv-scrubbly') as HTMLCanvasElement
const castCvHooter   = document.getElementById('cv-hooter')   as HTMLCanvasElement
const castCvPoglet   = document.getElementById('cv-poglet')   as HTMLCanvasElement
const castRowTrogg   = document.getElementById('cr-trogg')    as HTMLDivElement
const titleLogoCv    = document.getElementById('cv-title-logo') as HTMLCanvasElement

// ── Title logo animation frames ───────────────────────────────────────────
const logoFrames: HTMLImageElement[] = []
{
  const LOGO_FRAME_COUNT = 25
  for (let i = 0; i < LOGO_FRAME_COUNT; i++) {
    const img = new Image()
    img.src = new URL(`./assets/sprites/game_logo/${String(i).padStart(3, '0')}.png`, import.meta.url).href
    logoFrames.push(img)
  }
}

// ── Title cast animation ──────────────────────────────────────────────────
let castRafId = 0
const castState = {
  phase: 'walk' as 'walk' | 'idle' | 'wave' | 'sit' | 'standTransition',
  troggCX: -150,    // center-X of Trogg canvas (px from cast-chars left)
  walkTime: 0,
  idleTime: 0,
  boredTime: 0,   // time spent in idle before bored sequence triggers
  waveTime: 0,
  transTime: 0,
  sitTime: 0,
  enemyTime: 0,
  hooterAnimTime: 0,
  last: 0,
  logoTime: 0,
}

const drawCastFrame = (
  cv: HTMLCanvasElement,
  frames: THREE.MeshBasicMaterial[],
  tick: number,
  flipH = false,
): boolean => {
  if (frames.length === 0) return false
  const mat = frames[tick % frames.length]
  const src = mat.map?.image as HTMLCanvasElement | null
  if (!src || src.width === 0) return false
  if (cv.width !== src.width || cv.height !== src.height) {
    cv.width = src.width
    cv.height = src.height
  }
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, cv.width, cv.height)
  if (flipH) {
    ctx.save()
    ctx.translate(cv.width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(src, 0, 0)
    ctx.restore()
  } else {
    ctx.drawImage(src, 0, 0)
  }
  return true
}

const runCastAnim = (now: number) => {
  if (!overlayShowing) { castRafId = 0; return }
  const dt = Math.min((now - castState.last) / 1000, 0.05)
  castState.last = now

  const stageW = castRowTrogg.offsetWidth || 900
  const targetCX = stageW / 6

  // ── Trogg walk-in then idle ────────────────────────────────────────────
  if (castState.phase === 'walk') {
    const wf = troggPlayerFrames['walkA'] ?? []
    if (wf.length === 0) {
      // Frames not yet loaded — keep last time fresh to avoid dt spike
      castState.last = now
      castRafId = requestAnimationFrame(runCastAnim)
      return
    }
    castState.walkTime += dt * 24
    drawCastFrame(castCvTrogg, wf, Math.floor(castState.walkTime))
    castState.troggCX += dt * stageW * 0.15
    if (castState.troggCX >= targetCX) {
      castState.troggCX = targetCX
      castState.phase = 'idle'
      castState.idleTime = 0
    }
  } else if (castState.phase === 'idle') {
    const id = troggPlayerFrames['idle'] ?? []
    castState.idleTime += dt
    castState.boredTime += dt
    if (id.length > 0) {
      drawCastFrame(castCvTrogg, id, pingPongFrame(Math.floor(castState.idleTime * 3.5), id.length))
    }
    if (castState.boredTime >= 20) {
      castState.phase = 'wave'
      castState.waveTime = 0
    }
  } else if (castState.phase === 'wave') {
    const wf = troggPlayerFrames['wave'] ?? []
    castState.waveTime += dt
    const waveTick = Math.floor(castState.waveTime * 8)
    if (wf.length > 0) {
      drawCastFrame(castCvTrogg, wf, waveTick)
      // Advance after 2 full cycles
      if (waveTick >= wf.length * 2) {
        castState.phase = 'sit'
        castState.sitTime = 0
      }
    }
  } else if (castState.phase === 'sit') {
    const sf = troggPlayerFrames['sit'] ?? []
    castState.sitTime += dt
    if (sf.length > 24) {
      // Play frames 17→25 (indices 16→24) once and hold at 24
      const tick = Math.floor(castState.sitTime * 4)
      drawCastFrame(castCvTrogg, sf, Math.min(24, 16 + tick))
    } else if (sf.length > 0) {
      drawCastFrame(castCvTrogg, sf, 0)
    }
    if (castState.sitTime >= 30) {
      castState.phase = 'standTransition'
      castState.transTime = 0
    }
  } else if (castState.phase === 'standTransition') {
    // Play sit frames 24→16 (1-indexed 25→17) to animate standing up.
    const sf = troggPlayerFrames['sit'] ?? []
    castState.transTime += dt
    if (sf.length > 16) {
      const tick = Math.floor(castState.transTime * 8)  // 0..8 = 9 steps
      const frame = Math.max(16, 24 - tick)
      drawCastFrame(castCvTrogg, sf, frame)
      if (tick >= 8) {
        castState.phase = 'idle'
        castState.idleTime = 0
        castState.boredTime = 0
      }
    }
  }
  // Position Trogg canvas so its centre is at troggCX
  const tw = castCvTrogg.offsetWidth || 50
  castCvTrogg.style.left = `${castState.troggCX - tw / 2}px`
  castCvTrogg.style.transform = 'none'

  // ── Enemies ──────────────────────────────────────────────────────────
  castState.enemyTime += dt
  // Scrubbly: full ping-pong frames, no flip
  const scrubblyFrames = spriteFrameRegistry.get('enemies/scrubbly/idle') ?? []
  if (scrubblyFrames.length > 1) {
    const tick = Math.floor(castState.enemyTime * 10)
    drawCastFrame(castCvScrubbly, scrubblyFrames, pingPongFrame(tick, scrubblyFrames.length))
  }
  // Hooter: simple ping-pong through idle frames
  const hooterFrames = spriteFrameRegistry.get('enemies/hooter/idle') ?? []
  if (hooterFrames.length > 1) {
    castState.hooterAnimTime += dt
    const tick = Math.floor(castState.hooterAnimTime * 10)
    drawCastFrame(castCvHooter, hooterFrames, pingPongFrame(tick, hooterFrames.length))
  }

  // Poglet: ping-pong all frames
  const poglet = spriteFrameRegistry.get('enemies/poglet/idle') ?? []
  if (poglet.length > 1) {
    const tick = Math.floor(castState.enemyTime * 10)
    drawCastFrame(castCvPoglet, poglet, pingPongFrame(tick, poglet.length))
  }

  // ── Spinning logo ──────────────────────────────────────────────────────
  castState.logoTime += dt
  if (logoFrames.length > 0) {
    const LOGO_FPS = 12
    const frameIdx = pingPongFrame(Math.floor(castState.logoTime * LOGO_FPS), logoFrames.length)
    const img = logoFrames[frameIdx]
    if (img.complete && img.naturalWidth > 0) {
      if (titleLogoCv.width !== img.naturalWidth || titleLogoCv.height !== img.naturalHeight) {
        titleLogoCv.width = img.naturalWidth
        titleLogoCv.height = img.naturalHeight
      }
      const lctx = titleLogoCv.getContext('2d')!
      lctx.clearRect(0, 0, titleLogoCv.width, titleLogoCv.height)
      lctx.drawImage(img, 0, 0)
    }
  }

  castRafId = requestAnimationFrame(runCastAnim)
}

const startCastAnim = () => {
  castState.phase = 'walk'
  castState.troggCX = -150
  castState.walkTime = 0
  castState.idleTime = 0
  castState.boredTime = 0
  castState.waveTime = 0
  castState.transTime = 0
  castState.sitTime = 0
  castState.enemyTime = 0
  castState.hooterAnimTime = 0
  castState.logoTime = 0
  castState.last = performance.now()
  castCvTrogg.style.left = '-150px'
  castCvTrogg.style.transform = 'none'
  if (castRafId) cancelAnimationFrame(castRafId)
  castRafId = requestAnimationFrame(runCastAnim)
}
const musicStyleOrigEl = document.querySelector<HTMLInputElement>('#music-style-original')!
const musicStyleNewEl = document.querySelector<HTMLInputElement>('#music-style-new')!

let overlayShowing = true  // title screen is visible on launch

// ── Dry-run (level editor test mode) ─────────────────────────────────────────
let dryRunActive = false
let levelLoading = false
interface GameLevel {
  data: LevelData
  spawns: { x: number; y: number }[]
  bgIndex: number
  musicTrack: number
  timeLimit: number
  spriteMap: Record<string, SpriteMapEntry>
  chains: RectTuple[]
  chain_clamps: RectTuple[]
  girders: RectTuple[]
  customWorldBounds?: { left: number; right: number; bottom: number; top: number }
  disabledHazards?: string[]
  customElements?: { kind: string; x: number; y: number; w: number; h: number; attrs?: Record<string, unknown> }[]
  monsterKinds: string[]     // parallel to data.monsters — the spriteMap kind for each monster
}
let dryRunOverride: GameLevel | null = null

const clearInputs = () => {
  ;(Object.keys(inputState) as Array<keyof typeof inputState>).forEach((k) => {
    (inputState[k] as boolean) = false
  })
}

/** Show a full-screen overlay.
 *  If `startBtn` is given the overlay is dismissed only by clicking that button.
 *  Otherwise any keydown or pointerdown dismisses it (game-over style). */
const showOverlay = (el: HTMLDivElement, onDismiss: () => void, startBtn?: HTMLButtonElement) => {
  overlayShowing = true
  el.style.display = 'flex'
  const dismiss = (e: Event) => {
    e.preventDefault()
    el.style.display = 'none'
    overlayShowing = false
    if (!startBtn) {
      window.removeEventListener('keydown', dismiss)
      window.removeEventListener('pointerdown', dismiss)
    }
    // Clear all held inputs so the key/tap that dismissed the overlay doesn't
    // immediately move the player on the first game frame.
    clearInputs()
    onDismiss()
  }
  if (startBtn) {
    startBtn.addEventListener('click', dismiss, { once: true })
  } else {
    window.addEventListener('keydown', dismiss, { once: true })
    window.addEventListener('pointerdown', dismiss, { once: true })
  }
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

const scene = new THREE.Scene()
scene.background = new THREE.Color('#00d8d8')

const camera = new THREE.OrthographicCamera(-16, 16, 10, -10, 0.1, 100)
camera.position.set(0, 4, 18)
camera.lookAt(0, 4, 0)

// Keep visuals intentionally simple while mechanics are finalized.

let worldBounds = { left: 0, right: 52, top: 28, bottom: -2 }

/** Compute world bounds from level data with padding. */
const computeWorldBounds = (data: LevelData, spawns: { x: number; y: number }[]) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const expandRect = (r: Rect) => {
    minX = Math.min(minX, r.x)
    maxX = Math.max(maxX, r.x + r.w)
    minY = Math.min(minY, r.y)
    maxY = Math.max(maxY, r.y + r.h)
  }
  for (const arr of [data.platforms, data.ladders, data.monsters, data.keys, data.treasures, data.bulbs]) {
    for (const r of arr) expandRect(r)
  }
  expandRect(data.exit)
  for (const s of spawns) {
    minX = Math.min(minX, s.x - 1)
    maxX = Math.max(maxX, s.x + 1)
    minY = Math.min(minY, s.y - 1)
    maxY = Math.max(maxY, s.y + 1)
  }
  if (!isFinite(minX)) { minX = 0; maxX = 52; minY = -2; maxY = 28 }
  const pad = 2
  return {
    left:   Math.floor(minX - pad),
    right:  Math.ceil(maxX + pad),
    bottom: Math.floor(minY - pad),
    top:    Math.ceil(maxY + pad),
  }
}
let cameraViewWidth = 32
let cameraViewHeight = 24

const cameraConfig = {
  deadZoneX: 1.8,
  deadZoneY: 1.2,
  lookAheadX: 1.1,
  lookAheadY: 0.25,
  smoothness: 7.5,
}

const cameraZoomConfig = {
  baseZoom: 1.5,
  jumpZoom: 2.0,
  deathZoom: 2.8,
  mapZoom: 0.8,
  smoothness: 5,
}

const renderBands = {
  ladder: { order: 1, z: -0.25 },
  platform: { order: 2, z: 0 },
  exit: { order: 6, z: 0.15 },
  monster: { order: 18, z: 0.9 },
  item: { order: 24, z: 1.05 },
  player: { order: 30, z: 1.3 },
  hazard: { order: 32, z: 1.2 },
  yoyo: { order: 35, z: 1.35 },
} as const

// All sprite scaling is now driven by spriteScale in sprite.json / per-level
// spriteMap configs. The game engine applies entry.spriteScale (default 1.0)
// uniformly — no role-based hardcoded multipliers.
let currentPlayerScale = 1.0

let jumpZoomActive = false
let mapMode = false

// ── Level data (loaded from bundled assets, with public/ overrides) ──────────
const builtinLevelModules = import.meta.glob(
  './assets/levels/*.json',
  { eager: true, import: 'default' },
) as Record<string, LevelFile>

const levelFileToGameLevel = (lf: LevelFile): GameLevel => {
  const chains = lf.chains ?? []
  const chain_clamps = lf.chain_clamps ?? []
  const girders = lf.girders ?? []
  const raw: RawLevelData = {
    platforms:  [...lf.platforms, ...girders],
    ladders:    [...lf.ladders, ...chains, ...chain_clamps],
    monsters:   [...lf.monsters, ...(lf.hooters ?? []), ...(lf.poglets ?? [])],
    keys:       lf.keys,
    treasures:  lf.treasures,
    bulbs:      lf.bulbs ?? [],
    exit:       lf.exit ?? [0, 0, 0.1, 0.1],
  }
  // Build a parallel array of monster kinds so the engine can look up per-kind spriteMap entries
  const monsterKinds: string[] = [
    ...lf.monsters.map(() => 'monster'),
    ...(lf.hooters ?? []).map(() => 'hooter'),
    ...(lf.poglets ?? []).map(() => 'poglet'),
  ]
  const spawns = (lf.playerStarts && lf.playerStarts.length > 0)
    ? lf.playerStarts.map(([x, y]) => ({ x, y }))
    : [{ x: lf.playerStart[0], y: lf.playerStart[1] }]
  return {
    data: rawToLevelData(raw),
    spawns,
    bgIndex: lf.backgroundIndex,
    musicTrack: lf.musicTrack,
    timeLimit: lf.timeLimit ?? 120,
    spriteMap: lf.spriteMap ?? {},
    chains,
    chain_clamps,
    girders,
    customWorldBounds: lf.worldBounds ? { ...lf.worldBounds } : undefined,
    disabledHazards: lf.disabledHazards,
    customElements: lf.customElements,
    monsterKinds,
  }
}

// Start with bundled built-in levels (sorted by filename: 1.json, 2.json, 3.json …)
const builtinKeys = Object.keys(builtinLevelModules).sort()
const builtinCount = builtinKeys.length
const levelCycle: GameLevel[] = builtinKeys.map(k => levelFileToGameLevel(builtinLevelModules[k]))
// Parallel array of names for the title screen selector (custom levels only)
const levelNames: string[] = builtinKeys.map((_k, i) => `Level ${i + 1}`)

// Load sprite.json overrides from public/sprites/ and merge into SPRITE_METADATA
async function loadPublicSpriteOverrides() {
  try {
    const resp = await fetch('/__sprite_index', { cache: 'no-store' })
    if (!resp.ok) return
    const files = (await resp.json()) as string[]
    await Promise.all(files.map(async (filePath) => {
      try {
        const r = await fetch(`/__read_sprite/${encodeURIComponent(filePath)}`, { cache: 'no-store' })
        if (!r.ok) return
        const cfg = await r.json()
        // Derive sprite path from file path (e.g. "enemies/hooter/idle/sprite.json" → "enemies/hooter/idle")
        const spritePath = filePath.replace(/\/sprite\.json$/, '')
        const existing = SPRITE_METADATA.get(spritePath) ?? {}
        if (cfg.visual_w !== undefined) existing.visual_w = cfg.visual_w
        if (cfg.visual_h !== undefined) existing.visual_h = cfg.visual_h
        if (cfg.fps !== undefined) existing.fps = cfg.fps
        SPRITE_METADATA.set(spritePath, existing)

        // Merge editor-relevant fields into DEFAULT_SPRITE_MAP and DEFAULT_SIZE
        // so the level editor and game engine use the updated values.
        const kind = cfg.kind as string | undefined
        if (kind && DEFAULT_SPRITE_MAP[kind]) {
          const entry = DEFAULT_SPRITE_MAP[kind]
          if (cfg.spriteScale !== undefined) entry.spriteScale = cfg.spriteScale
          if (cfg.fps !== undefined) entry.fps = cfg.fps
          if (cfg.animMode) entry.animMode = cfg.animMode
          if (cfg.defaultSize && Array.isArray(cfg.defaultSize) && cfg.defaultSize.length === 2) {
            DEFAULT_SIZE[kind] = [cfg.defaultSize[0], cfg.defaultSize[1]]
          }
        }
      } catch { /* skip unreadable override */ }
    }))
  } catch { /* no sprite index endpoint — skip */ }
}

// Try to overlay built-in levels from public/levels/, then discover custom levels
async function loadPublicLevelOverrides() {
  // Override built-in levels 1-3
  const tasks = levelCycle.map(async (_gl, i) => {
    try {
      const resp = await fetch(`/levels/${i + 1}.json`, { cache: 'no-store' })
      if (resp.ok) {
        const lf = await resp.json() as LevelFile
        levelCycle[i] = levelFileToGameLevel(lf)
      }
    } catch { /* no public override — keep bundled */ }
  })
  await Promise.all(tasks)

  // Remove any previously loaded custom levels before re-discovering
  levelCycle.length = builtinCount
  levelNames.length = builtinCount

  // Discover custom levels via the level index
  try {
    const resp = await fetch('/__level_index', { cache: 'no-store' })
    if (!resp.ok) return
    const files = (await resp.json()) as string[]
    // Filter out built-in level files (1.json, 2.json, 3.json, etc.)
    const builtinSet = new Set(builtinKeys.map((_k, i) => `${i + 1}.json`))
    const customFiles = files.filter(f => !builtinSet.has(f))
    // Load each custom level
    const customTasks = customFiles.map(async (filename) => {
      try {
        const r = await fetch(`/levels/${filename}`, { cache: 'no-store' })
        if (r.ok) {
          const lf = (await r.json()) as LevelFile
          levelCycle.push(levelFileToGameLevel(lf))
          levelNames.push(lf.name || filename.replace(/\.json$/, ''))
        }
      } catch { /* skip unreadable file */ }
    })
    await Promise.all(customTasks)
  } catch { /* no index endpoint — skip custom level discovery */ }

  // Populate title screen level selector if custom levels exist
  const selectWrap = document.getElementById('title-level-select-wrap')
  const selectEl = document.getElementById('title-level-select') as HTMLSelectElement | null
  if (selectWrap && selectEl && levelCycle.length > builtinCount) {
    selectEl.innerHTML = ''
    const campOpt = document.createElement('option')
    campOpt.value = '0'
    campOpt.textContent = '▶ Campaign (Levels 1–3)'
    selectEl.appendChild(campOpt)
    for (let i = builtinCount; i < levelCycle.length; i++) {
      const opt = document.createElement('option')
      opt.value = String(i)
      opt.textContent = levelNames[i]
      selectEl.appendChild(opt)
    }
    selectWrap.style.display = ''
  }
}

const world = new THREE.Group()
scene.add(world)

const staticLayer = new THREE.Group()
const enemyLayer = new THREE.Group()
const itemLayer = new THREE.Group()
const hazardLayer = new THREE.Group()
world.add(staticLayer)
world.add(enemyLayer)
world.add(itemLayer)
world.add(hazardLayer)

type SpritePalette = Record<string, string>

const makeSpriteMaterial = (rows: string[], palette: SpritePalette): THREE.MeshBasicMaterial => {
  const width = rows[0]?.length ?? 1
  const height = rows.length || 1
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Cannot create sprite canvas context')

  ctx.clearRect(0, 0, width, height)
  for (let y = 0; y < height; y += 1) {
    const row = rows[y]
    for (let x = 0; x < width; x += 1) {
      const key = row[x] ?? '.'
      const color = palette[key]
      if (!color || color === 'transparent') continue
      ctx.fillStyle = color
      ctx.fillRect(x, y, 1, 1)
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true

  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.5,
    depthTest: false,
    depthWrite: false,
  })
}

const retroPalette = {
  '.': 'transparent',
  k: '#000000',
  y: '#f0e000',
  w: '#ffffff',
  c: '#00d8d8',
  m: '#f020f0',
} as const

const playerIdleSpriteRows = [
  '....yyyy....',
  '...yyyyyy...',
  '...ckkkkc...',
  '..ckwwwwkc..',
  '..ckwwwwkc..',
  '...ckkkkc...',
  '....cmmc....',
  '...cmmmmc...',
  '..cmmmmmmc..',
  '..cmmccmmc..',
  '..cmmccmmc..',
  '..cmm..mmc..',
  '..cmm..mmc..',
  '..cmm..mmc..',
  '...kk..kk...',
  '..kkkkkkkk..',
]

const playerWalkASpriteRows = [
  '....yyyy....',
  '...yyyyyy...',
  '...ckkkkc...',
  '..ckwwwwkc..',
  '..ckwwwwkc..',
  '...ckkkkc...',
  '....cmmc....',
  '...cmmmmc...',
  '..cmmmmmmc..',
  '..cmmccmmc..',
  '..cmmccmmc..',
  '..cmm..mmc..',
  '..cmm..mmc..',
  '..cmm..mmc..',
  '...kk..kk...',
  '..kkkkkkkk..',
]

const playerJumpSpriteRows = [
  '....yyyy....',
  '...yyyyyy...',
  '...ckkkkc...',
  '..ckwwwwkc..',
  '..ckwwwwkc..',
  '...ckkkkc...',
  '....cmmc....',
  '...cmmmmc...',
  '..cmmmmmmc..',
  '..cmmccmmc..',
  '...cmmmmc...',
  '....cmmc....',
  '...ck..kc...',
  '..ckk..kkc..',
  '..kk....kk..',
  '.kkkk..kkkk.',
]

const monsterSpriteRows = [
  '...kkkkkk...',
  '..kkkkkkkk..',
  '.kkwwkkwwkk.',
  '.kkkkkkkkkk.',
  '.kkkkkkkkkk.',
  '.kkkkyykkkk.',
  '.kkkkkkkkkk.',
  '.kkk....kkk.',
  '.kk......kk.',
  '.kk......kk.',
  '.kk......kk.',
  '.kkk....kkk.',
  '..kkk..kkk..',
  '..kkk..kkk..',
  '..kk....kk..',
  '.kkkk..kkkk.',
]

const balloonSpriteRows = [
  '....wwww....',
  '...wwwwww...',
  '..wwwwwwww..',
  '..wwwwwwww..',
  '..wwwwwwww..',
  '..wwwwwwww..',
  '...wwwwww...',
  '....wwww....',
  '.....ww.....',
  '.....ww.....',
  '.....ww.....',
  '.....ww.....',
  '....wyyw....',
  '.....yy.....',
  '.....yy.....',
  '.....yy.....',
]

const daggerSpriteRows = [
  '.....w......',
  '....www.....',
  '...wwwww....',
  '..wwwwwww...',
  '.wwwwwwwww..',
  'wwwwwwwwwww.',
  '.wwwwwwwww..',
  '..wwwwwww...',
  '...wwwww....',
  '....www.....',
  '.....ww.....',
  '.....ww.....',
  '.....ww.....',
  '.....ww.....',
  '.....yy.....',
  '.....yy.....',
]

const playerSpriteMaterials = {
  idle: makeSpriteMaterial(playerIdleSpriteRows, retroPalette),
  walkA: makeSpriteMaterial(playerWalkASpriteRows, retroPalette),
  jump: makeSpriteMaterial(playerJumpSpriteRows, retroPalette),
}
type PlayerVisualState = 'idle' | 'walkA' | 'jump' | 'climb' | 'attack' | 'death' | 'wave' | 'sit' | 'standUp'

const monsterSpriteMaterial = makeSpriteMaterial(monsterSpriteRows, retroPalette)
const balloonSpriteMaterial = makeSpriteMaterial(balloonSpriteRows, retroPalette)
const daggerSpriteMaterial = makeSpriteMaterial(daggerSpriteRows, retroPalette)

const TROGG_SPRITE_PATHS: Record<PlayerVisualState, string> = {
  idle: 'player/trogg/idle',
  walkA: 'player/trogg/walk',
  jump: 'player/trogg/jump',
  climb: 'player/trogg/climb',
  attack: 'player/trogg/yoyo',
  death: 'player/trogg/death',
  wave: 'player/trogg/wave',
  sit: 'player/trogg/sit',
  standUp: 'player/trogg/sit',
}
const troggFps = (state: PlayerVisualState): number =>
  SPRITE_METADATA.get(TROGG_SPRITE_PATHS[state])?.fps ?? 8

const troggPlayerFrames: Partial<Record<PlayerVisualState, THREE.MeshBasicMaterial[]>> = {}
const bgMeshes: Array<THREE.Mesh | null> = [null, null, null]

// ── Sprite frame registry ────────────────────────────────────────────────────
// Keyed by sprite path (e.g. "enemies/scrubbly/idle"). Populated at startup from
// loadSpriteFrames, then read by loadLevel to wire up the correct frames per level.
const spriteFrameRegistry = new Map<string, THREE.MeshBasicMaterial[]>()

// Player yoyo sequences: 25-frame sheet
// Throw: swing arm down frames 25→16 (indices 24→15), hold at 16 while yoyo is out
// Return: bring arm up frames 16→25 (indices 15→24)
const troggAttackThrowSeq = Array.from({ length: 10 }, (_, i) => 24 - i)  // 24→15

const platformMaterial = new THREE.MeshBasicMaterial({ color: '#f020f0' })
const ladderRailMaterial = new THREE.MeshBasicMaterial({ color: '#f0e000', depthTest: false, depthWrite: false })
const ladderRungMaterial = new THREE.MeshBasicMaterial({
  color: '#fff26a',
  transparent: true,
  opacity: 0.78,
  depthTest: false,
  depthWrite: false,
})

let currentPlatforms: Rect[] = []
let currentLadders: Rect[] = []
let monsters: Monster[] = []
let collectibles: Collectible[] = []
let mandatoryCollectibles: Collectible[] = []
let hazards: Hazard[] = []
let obstacles: Obstacle[] = []

let levelIndex = 0
let loopCount = 0
let invertedCycle = false

const player: PlayerState = {
  x: 1,
  y: 2,
  vx: 0,
  vy: 0,
  w: 0.85,
  h: 1.7,
  grounded: false,
  climbing: false,
  dead: false,
  facing: 1,
}

const playerMesh = new THREE.Mesh(new THREE.PlaneGeometry(player.w, player.h), playerSpriteMaterials.idle)
playerMesh.renderOrder = renderBands.player.order
world.add(playerMesh)

const yoyoS = 1.5375  // yoyo visual scale (weapon effect, not a level element)
const yoyoMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(0.24 * yoyoS, 0.24 * yoyoS),
  makeSpriteMaterial(
    [
      '.yyyy.',
      'yyyyyy',
      'yykkyy',
      'yykkyy',
      'yyyyyy',
      '.yyyy.',
    ],
    retroPalette,
  ),
)
yoyoMesh.visible = false
yoyoMesh.renderOrder = renderBands.yoyo.order
world.add(yoyoMesh)

const yoyoStringMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 0.05),
  new THREE.MeshBasicMaterial({ color: 0x000000 }),
)
yoyoStringMesh.visible = false
yoyoStringMesh.renderOrder = renderBands.yoyo.order - 1
world.add(yoyoStringMesh)

// Speech bubble ("FRAK!") shown on final death frame
const frakBubbleW = 1.2
const frakBubbleH = frakBubbleW * (77 / 192)  // preserve aspect ratio
const frakBubbleMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(frakBubbleW, frakBubbleH),
  new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }),
)
frakBubbleMesh.visible = false
frakBubbleMesh.renderOrder = renderBands.player.order + 1
world.add(frakBubbleMesh)

const imageLoader = new THREE.ImageLoader()

const normalizeFrameCanvases = (frames: THREE.MeshBasicMaterial[]): void => {
  if (frames.length <= 1) return
  let maxW = 0, maxH = 0
  for (const mat of frames) {
    const cvs = mat.map?.image as HTMLCanvasElement | null
    if (cvs) { maxW = Math.max(maxW, cvs.width); maxH = Math.max(maxH, cvs.height) }
  }
  if (maxW === 0 || maxH === 0) return
  for (const mat of frames) {
    const cvs = mat.map?.image as HTMLCanvasElement | null
    if (!cvs || (cvs.width === maxW && cvs.height === maxH)) continue
    const out = document.createElement('canvas')
    out.width = maxW; out.height = maxH
    const ctx = out.getContext('2d')!
    ctx.drawImage(cvs, Math.floor((maxW - cvs.width) / 2), Math.floor((maxH - cvs.height) / 2))
    const oldTex = mat.map
    const tex = new THREE.CanvasTexture(out)
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false; tex.needsUpdate = true
    mat.map = tex
    oldTex?.dispose()
  }
}

/**
 * Tight-crop each frame to its opaque content, then re-render all frames into
 * a shared canvas of the maximum content dimensions, bottom-anchored so the
 * character's feet stay at a consistent position across animation frames.
 */
const setTroggStateFrames = (state: PlayerVisualState, frames: THREE.MeshBasicMaterial[]) => {
  if (frames.length === 0) return
  normalizeFrameCanvases(frames)
  troggPlayerFrames[state] = frames
}

// Pre-extracted character sprite loader — loads individual frame PNGs produced by
// extract_sprites.py instead of splitting sprite sheets at runtime.
const allSpriteUrls = import.meta.glob(
  './assets/sprites/**/*.png',
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>

// ── Data-driven tiling material cache ────────────────────────────────────────
// Keyed by sprite path (e.g. "platforms/earth/tile"). Creates tiling-ready
// MeshBasicMaterial on first access, then caches for reuse across loadLevel calls.
const tilingMaterialCache = new Map<string, THREE.MeshBasicMaterial>()

/** Find the first PNG URL matching a sprite path from allSpriteUrls */
const findSpriteUrl = (spritePath: string): string | null => {
  // spritePath like "platforms/earth/tile" or "platforms/log"
  const prefix = `./assets/sprites/${spritePath}/`
  const match = Object.entries(allSpriteUrls)
    .filter(([k]) => k.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
  if (match.length > 0) return match[0][1]
  // Also try as a direct file (e.g. "platforms/log" → "platforms/log/log.png")
  const direct = Object.entries(allSpriteUrls)
    .filter(([k]) => k.startsWith(`./assets/sprites/${spritePath}`))
    .sort(([a], [b]) => a.localeCompare(b))
  return direct.length > 0 ? direct[0][1] : null
}

/** Create a canvas copy of an image with alpha-snapped pixels (>32 = opaque, else transparent). */
const alphaSnapCanvas = (img: HTMLImageElement): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const idata = ctx.getImageData(0, 0, c.width, c.height)
  const d = idata.data
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 32 ? 255 : 0
  ctx.putImageData(idata, 0, 0)
  return c
}

/** Load (or retrieve from cache) a tiling-ready material for the given sprite path. */
const loadTilingMaterial = (spritePath: string, tiling: 'h' | 'v'): Promise<THREE.MeshBasicMaterial | null> => {
  const cached = tilingMaterialCache.get(spritePath)
  if (cached) return Promise.resolve(cached)

  const url = findSpriteUrl(spritePath)
  if (!url) return Promise.resolve(null)

  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const c = alphaSnapCanvas(img)
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      tex.minFilter = THREE.NearestFilter
      tex.magFilter = THREE.NearestFilter
      tex.wrapS = tiling === 'h' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
      tex.wrapT = tiling === 'v' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping

      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: '#ffffff',
        transparent: true,
        alphaTest: 0.5,
        depthTest: false,
        depthWrite: false,
      })
      tilingMaterialCache.set(spritePath, mat)
      resolve(mat)
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}
const makeCanvasMaterial = (img: HTMLImageElement): THREE.MeshBasicMaterial => {
  const c = alphaSnapCanvas(img)
  const tex = new THREE.CanvasTexture(c)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.5,
    depthTest: false,
    depthWrite: false,
  })
}

const loadSpriteFrames = (name: string, anim: string): Promise<THREE.MeshBasicMaterial[]> => {
  const prefix = `./assets/sprites/${name}/${anim}/`
  const urls = Object.entries(allSpriteUrls)
    .filter(([k]) => k.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)
  return Promise.all(
    urls.map(url =>
      new Promise<THREE.MeshBasicMaterial>(resolve => {
        const img = new Image()
        img.onload = () => resolve(makeCanvasMaterial(img))
        img.src = url
      }),
    ),
  )
}

;(async () => {
  // Discover all sprite animation directories from the glob and load them
  // into the spriteFrameRegistry dynamically — no hardcoded paths needed.
  const SPRITE_PREFIX = './assets/sprites/'
  const animDirs = new Set<string>()
  for (const key of Object.keys(allSpriteUrls)) {
    if (!key.startsWith(SPRITE_PREFIX)) continue
    const rel = key.slice(SPRITE_PREFIX.length)  // e.g. "enemies/scrubbly/idle/000.png"
    const lastSlash = rel.lastIndexOf('/')
    if (lastSlash > 0) animDirs.add(rel.slice(0, lastSlash))  // e.g. "enemies/scrubbly/idle"
  }
  // Load all discovered animation directories in parallel
  const dirEntries = [...animDirs]
  const allFrames = await Promise.all(
    dirEntries.map(dir => {
      const parts = dir.split('/')
      const anim = parts.pop()!
      const name = parts.join('/')
      return loadSpriteFrames(name, anim)
    }),
  )
  for (let i = 0; i < dirEntries.length; i++) {
    if (allFrames[i].length > 0) spriteFrameRegistry.set(dirEntries[i], allFrames[i])
  }

  // Wire up Trogg player animation states from the registry
  for (const [state, path] of Object.entries(TROGG_SPRITE_PATHS) as [PlayerVisualState, string][]) {
    const frames = spriteFrameRegistry.get(path) ?? []
    if (frames.length > 0) setTroggStateFrames(state, frames)
  }

  // Ladder and earth platform materials are now loaded on-demand per level via
  // loadTilingMaterial() using the spriteMap, so no startup material creation needed.

  // Load sprite.json overrides from public/sprites/ and merge into SPRITE_METADATA
  await loadPublicSpriteOverrides()

  // Load any public/ level overrides before refreshing the level
  await loadPublicLevelOverrides()

  if (levelIndex >= 0) await loadLevel(levelIndex)
})()

// Yoyo — single sprite from extracted frame
imageLoader.load(yoyoSpriteUrl, (img) => {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  yoyoMesh.material = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })
})

// Speech bubble texture
imageLoader.load(frakBubbleUrl, (img) => {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  frakBubbleMesh.material = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })
})

const makeBgMesh = (img: HTMLImageElement, levelIdx: number) => {
  const bgCanvas = document.createElement('canvas')
  bgCanvas.width = img.width
  bgCanvas.height = img.height
  const bgCtx = bgCanvas.getContext('2d')
  if (!bgCtx) return
  bgCtx.drawImage(img, 0, 0)
  const bgTex = new THREE.CanvasTexture(bgCanvas)
  bgTex.minFilter = THREE.LinearFilter
  bgTex.magFilter = THREE.LinearFilter
  bgTex.needsUpdate = true
  const bgW = worldBounds.right - worldBounds.left
  const bgH = worldBounds.top - worldBounds.bottom
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(bgW, bgH),
    new THREE.MeshBasicMaterial({ map: bgTex, depthTest: false, depthWrite: false }),
  )
  mesh.position.set(
    (worldBounds.left + worldBounds.right) / 2,
    (worldBounds.bottom + worldBounds.top) / 2,
    -1,
  )
  mesh.renderOrder = 0
  bgMeshes[levelIdx] = mesh
  if (levelIndex === levelIdx) {
    scene.background = null
    world.add(mesh)
  }
}

imageLoader.load(level1BgUrl, (img) => makeBgMesh(img, 0))
imageLoader.load(level2BgUrl, (img) => makeBgMesh(img, 1))
imageLoader.load(level3BgUrl, (img) => makeBgMesh(img, 2))

let score = 0
let lives = 3
let respawnTimer = 0
let levelTimer = 0
let currentTimeLimit = 120
let lastTime = performance.now()
let hazardSpawnTimers: number[] = []
// Current-level hazard configs (set by loadLevel from spriteMap)
interface LevelHazardConfig {
  kind: string
  movement: 'rise' | 'fall'
  animated: boolean
  animFps: number
  animMode: AnimMode
  frames: THREE.MeshBasicMaterial[]
  naturalW: number
  naturalH: number
  spriteScale: number
  spawnInterval: number
  fallback: THREE.MeshBasicMaterial
}
let levelHazardConfigs: LevelHazardConfig[] = []
const yoyoConfig = {
  maxReachMultiplier: 10,
  extendSpeed: 6.5,
  retractSpeed: 5.2,
  minActiveReach: 0.18,
}
let yoyoReach = 0
let yoyoReturning = false
let yoyoCastLocked = false
let fallPeakY = 0
let wasGroundedLastFrame = false
let coyoteTimer = 0
let jumpBufferTimer = 0
let walkAnimTime = 0
let climbAnimDist = 0
let currentPlayerVisual: PlayerVisualState = 'idle'
let currentPlayerFrame = -1
let playerVisualTime = 0
let idleBoredTimer = 0
let boredPhase: 'none' | 'wave' | 'sit' | 'standUp' = 'none'
let bufferedMoveX = 0
let bufferedMoveY = 0
let playerVisualYOffset = 0.4
const spawn = { x: 1, y: 2 }
let activeSpawns: { x: number; y: number }[] = [spawn]

const movementConfig = {
  runSpeed: 8.8,
  groundAccel: 68,
  groundDecel: 56,
  airAccel: 14,
  climbSpeed: 5,
  jumpVelocity: 12.8,
  gravityUp: 33,
  gravityDown: 44,
  shortHopGravityBoost: 20,
  coyoteTime: 0.06,
  jumpBufferTime: 0.08,
  inputRiseRate: 6,
  inputFallRate: 8,
}

const inputState = {
  left: false,
  right: false,
  up: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  attackHeld: false,
}

type ControlButton = 'left' | 'right' | 'up' | 'down' | 'jump' | 'attack'

// ── Remappable key bindings ──────────────────────────────────────────────────
// Each action maps to an array of key codes (ev.code values).
type ActionKey = 'left' | 'right' | 'up' | 'down' | 'jump' | 'attack' | 'map' | 'jumpZoom' | 'musicToggle'

const DEFAULT_KEY_BINDINGS: Record<ActionKey, string[]> = {
  left:        ['ArrowLeft', 'KeyA'],
  right:       ['ArrowRight', 'KeyD'],
  up:          ['ArrowUp', 'KeyW'],
  down:        ['ArrowDown', 'KeyS'],
  jump:        ['Space'],
  attack:      ['KeyX', 'KeyK', 'Enter'],
  map:         ['KeyM'],
  jumpZoom:    ['KeyZ'],
  musicToggle: ['KeyQ'],
}

const ACTION_LABELS: Record<ActionKey, string> = {
  left:        'Move left',
  right:       'Move right',
  up:          'Climb up',
  down:        'Climb down',
  jump:        'Jump',
  attack:      'Throw yoyo',
  map:         'Toggle map',
  jumpZoom:    'Toggle jump zoom',
  musicToggle: 'Toggle music',
}

const STORAGE_KEY_BINDINGS = 'frak_key_bindings'

/** Escape HTML special characters for safe innerHTML insertion */
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Pretty label for a keyboard code */
const keyCodeLabel = (code: string): string => {
  if (code === 'Space') return 'Space'
  if (code === 'Enter') return 'Enter'
  if (code === 'ArrowLeft') return '←'
  if (code === 'ArrowRight') return '→'
  if (code === 'ArrowUp') return '↑'
  if (code === 'ArrowDown') return '↓'
  if (code === 'ShiftLeft') return 'L-Shift'
  if (code === 'ShiftRight') return 'R-Shift'
  if (code === 'ControlLeft') return 'L-Ctrl'
  if (code === 'ControlRight') return 'R-Ctrl'
  if (code === 'AltLeft') return 'L-Alt'
  if (code === 'AltRight') return 'R-Alt'
  if (code === 'Backslash') return '\\'
  if (code === 'BracketLeft') return '['
  if (code === 'BracketRight') return ']'
  if (code === 'Semicolon') return ';'
  if (code === 'Quote') return "'"
  if (code === 'Comma') return ','
  if (code === 'Period') return '.'
  if (code === 'Slash') return '/'
  if (code === 'Backquote') return '`'
  if (code === 'Minus') return '-'
  if (code === 'Equal') return '='
  if (code === 'Tab') return 'Tab'
  if (code === 'Backspace') return 'Backspace'
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6)
  return code
}

const loadKeyBindings = (): Record<ActionKey, string[]> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BINDINGS)
    if (raw) {
      const parsed = JSON.parse(raw)
      // Validate structure
      const result = { ...DEFAULT_KEY_BINDINGS }
      for (const key of Object.keys(DEFAULT_KEY_BINDINGS) as ActionKey[]) {
        if (Array.isArray(parsed[key]) && parsed[key].length > 0 &&
            parsed[key].every((k: unknown) => typeof k === 'string')) {
          result[key] = parsed[key]
        }
      }
      return result
    }
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULT_KEY_BINDINGS }
}

let keyBindings = loadKeyBindings()

const saveKeyBindings = () => {
  localStorage.setItem(STORAGE_KEY_BINDINGS, JSON.stringify(keyBindings))
}

/** Rebuild keyMap from current bindings */
const rebuildKeyMap = () => {
  // Clear
  for (const k of Object.keys(keyMap)) delete keyMap[k]
  for (const code of keyBindings.left) keyMap[code] = 'left'
  for (const code of keyBindings.right) keyMap[code] = 'right'
  for (const code of keyBindings.up) keyMap[code] = 'up'
  for (const code of keyBindings.down) keyMap[code] = 'down'
  // jump and attack codes stored in sets for the keydown/keyup handler
  jumpCodes = new Set(keyBindings.jump)
  attackCodes = new Set(keyBindings.attack)
  mapCodes = new Set(keyBindings.map)
  jumpZoomCodes = new Set(keyBindings.jumpZoom)
  musicToggleCodes = new Set(keyBindings.musicToggle)
}

const keyMap: Record<string, keyof typeof inputState | undefined> = {}
let jumpCodes = new Set<string>()
let attackCodes = new Set<string>()
let mapCodes = new Set<string>()
let jumpZoomCodes = new Set<string>()
let musicToggleCodes = new Set<string>()
rebuildKeyMap()

window.addEventListener('keydown', (ev) => {
  if (jumpCodes.has(ev.code)) {
    if (!inputState.jumpHeld) inputState.jumpPressed = true
    inputState.jumpHeld = true
    ev.preventDefault()
    return
  }

  if (attackCodes.has(ev.code)) {
    inputState.attackHeld = true
    ev.preventDefault()
    return
  }

  if (jumpZoomCodes.has(ev.code)) {
    setJumpZoomEnabled(!jumpZoomEnabled)
    ev.preventDefault()
    return
  }

  if (mapCodes.has(ev.code)) {
    mapMode = !mapMode
    ev.preventDefault()
    return
  }

  if (musicToggleCodes.has(ev.code)) {
    musicToggleEl.checked = !musicToggleEl.checked
    musicToggleEl.dispatchEvent(new Event('change'))
    ev.preventDefault()
    return
  }

  const mapped = keyMap[ev.code]
  if (mapped) {
    inputState[mapped] = true
    ev.preventDefault()
  }
})

window.addEventListener('keyup', (ev) => {
  if (jumpCodes.has(ev.code)) {
    inputState.jumpHeld = false
    ev.preventDefault()
    return
  }

  if (attackCodes.has(ev.code)) {
    inputState.attackHeld = false
    ev.preventDefault()
    return
  }

  const mapped = keyMap[ev.code]
  if (mapped) {
    inputState[mapped] = false
    ev.preventDefault()
  }
})

const controlButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-control]')]
for (const button of controlButtons) {
  const control = button.dataset.control as ControlButton
  if (!control) continue

  const press = (ev: PointerEvent) => {
    if (control === 'jump') {
      if (!inputState.jumpHeld) inputState.jumpPressed = true
      inputState.jumpHeld = true
    } else if (control === 'attack') {
      inputState.attackHeld = true
    } else {
      inputState[control] = true
    }
    button.setPointerCapture(ev.pointerId)
    ev.preventDefault()
  }

  const release = (ev: PointerEvent) => {
    if (control === 'jump') {
      inputState.jumpHeld = false
    } else if (control === 'attack') {
      inputState.attackHeld = false
    } else {
      inputState[control] = false
    }
    button.releasePointerCapture(ev.pointerId)
    ev.preventDefault()
  }

  button.addEventListener('pointerdown', press)
  button.addEventListener('pointerup', release)
  button.addEventListener('pointercancel', release)
  button.addEventListener('pointerleave', release)
}

jumpZoomToggleEl.addEventListener('change', () => {
  setJumpZoomEnabled(jumpZoomToggleEl.checked, false)
})
const resumeMusic = () => {
  if (!musicEnabled) return
  if (overlayShowing) {
    playTitleMusic()
    return
  }
  // In-game: play the correct level track
  const levelIdx = Math.min(levelIndex + 1, vgzUrls.length - 1)
  playTrack(levelIdx)
}

const setMusicEnabled = (on: boolean) => {
  musicEnabled = on
  localStorage.setItem('frak_music_enabled', String(on))
  if (!on) {
    vgmPlayer.setEnabled(false)
    mp3Player.setEnabled(false)
  } else {
    vgmPlayer.setEnabled(true, false)
    mp3Player.setEnabled(true)
    resumeMusic()
  }
  musicToggleEl.checked = on
  titleMusicToggleEl.checked = on
}

musicToggleEl.addEventListener('change', () => setMusicEnabled(musicToggleEl.checked))

// ── Title screen controls ──────────────────────────────────────────────────
titleMusicToggleEl.addEventListener('change', () => setMusicEnabled(titleMusicToggleEl.checked))

musicStyleOrigEl.addEventListener('change', () => {
  if (musicStyleOrigEl.checked) {
    musicStyle = 'original'
    localStorage.setItem('frak_music_style', 'original')
    // If we're on the title screen, switch to VGZ live
    if (overlayShowing) playTitleMusic()
  }
})
musicStyleNewEl.addEventListener('change', () => {
  if (musicStyleNewEl.checked) {
    musicStyle = 'new'
    localStorage.setItem('frak_music_style', 'new')
    // If we're on the title screen, switch to MP3 live
    if (overlayShowing) playTitleMusic()
  }
})

titleJumpZoomEl.addEventListener('change', () => {
  setJumpZoomEnabled(titleJumpZoomEl.checked, false)
  jumpZoomToggleEl.checked = titleJumpZoomEl.checked
})

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

// Reusable mutable rects to avoid per-frame allocations
const _bodyRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
const _sampleRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
const _probeRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
const _hitRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

const getPlayerRect = (): Rect => {
  _bodyRect.x = player.x - player.w / 2
  _bodyRect.y = player.y - player.h / 2
  _bodyRect.w = player.w
  _bodyRect.h = player.h
  return _bodyRect
}

const isOnLadder = (): boolean => {
  const body = getPlayerRect()
  _sampleRect.x = body.x + body.w * 0.3
  _sampleRect.y = body.y + 0.1
  _sampleRect.w = body.w * 0.4
  _sampleRect.h = body.h - 0.2
  return currentLadders.some((ladder) => intersects(_sampleRect, ladder))
}

// Returns true when there is a ladder whose top opening sits just below the
// player's feet — needed to start climbing down from a platform.
// Probe depth is 1.25 units below feet to account for platforms 1 unit tall
// (ladder top sits at platform bottom, not platform top).
const isLadderBelow = (): boolean => {
  const body = getPlayerRect()
  _probeRect.x = body.x + body.w * 0.2
  _probeRect.y = body.y - 1.25
  _probeRect.w = body.w * 0.6
  _probeRect.h = 1.4
  return currentLadders.some((ladder) => intersects(_probeRect, ladder))
}

const clearGroup = (group: THREE.Group) => {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i]
    group.remove(child)
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
      // Materials are shared via spriteFrameRegistry/tilingMaterialCache — do NOT dispose them
    }
  }
}

const setStatus = (text: string, timeoutMs = 1200) => {
  statusEl.textContent = text
  if (timeoutMs > 0) {
    window.setTimeout(() => {
      if (statusEl.textContent === text) statusEl.textContent = ''
    }, timeoutMs)
  }
}

const setJumpZoomEnabled = (enabled: boolean, showStatus = true) => {
  jumpZoomEnabled = enabled
  jumpZoomToggleEl.checked = enabled
  localStorage.setItem('frak_jump_zoom', String(enabled))
  if (!enabled) jumpZoomActive = false
  if (showStatus) setStatus(enabled ? 'Jump Zoom On' : 'Jump Zoom Off', 900)
}

const updateCollectibleHUD = () => {
  // Show progress for each group of HUD-tracked collectibles
  const hudItems = collectibles.filter((c) => c.hud)
  if (hudItems.length === 0) { keysEl.textContent = ''; return }
  // Group by hudLabel
  const groups = new Map<string, { found: number; total: number }>()
  for (const c of hudItems) {
    const label = c.hudLabel || c.kind
    const g = groups.get(label) ?? { found: 0, total: 0 }
    g.total++
    if (!c.active) g.found++
    groups.set(label, g)
  }
  keysEl.textContent = [...groups.entries()]
    .map(([label, g]) => `${label}: ${g.found}/${g.total}`)
    .join('  ')
}

const setInvertedMode = (enabled: boolean) => {
  canvasWrap.classList.toggle('inverted', enabled)
}

const clampCameraAxis = (value: number, min: number, max: number): number => {
  if (min > max) return (min + max) * 0.5
  return THREE.MathUtils.clamp(value, min, max)
}

const _cameraBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 }
const cameraBounds = () => {
  const halfW = cameraViewWidth / (camera.zoom * 2)
  const halfH = cameraViewHeight / (camera.zoom * 2)
  _cameraBounds.minX = worldBounds.left + halfW
  _cameraBounds.maxX = worldBounds.right - halfW
  _cameraBounds.minY = worldBounds.bottom + halfH
  _cameraBounds.maxY = worldBounds.top - halfH
  return _cameraBounds
}

const snapCameraToPlayer = () => {
  camera.zoom = cameraZoomConfig.baseZoom
  camera.updateProjectionMatrix()
  const bounds = cameraBounds()
  camera.position.x = clampCameraAxis(player.x, bounds.minX, bounds.maxX)
  camera.position.y = clampCameraAxis(player.y + 1.4, bounds.minY, bounds.maxY)
}

const resetHazards = () => {
  // Remove only hazard meshes (not obstacle meshes) from the layer
  for (const h of hazards) hazardLayer.remove(h.mesh)
  hazards = []
  hazardSpawnTimers = levelHazardConfigs.map((c) => c.spawnInterval * (0.5 + Math.random() * 0.5))
}

async function loadLevel(index: number) {
  mapMode = false   // always return to normal play view on level load
  levelLoading = true

  const gl = dryRunOverride ?? levelCycle[index]
  if (!gl) { levelLoading = false; return }

  // Only change music when the game is actually running (not while on the title/gameover overlay).
  // Async sprite-sheet loaders also call loadLevel to refresh visuals — we must not let them
  // start level music while the title screen is still showing.
  if (!overlayShowing) {
    const musicIdx = Math.min(gl.musicTrack, vgzUrls.length - 1)
    stopAllMusic()
    if (musicEnabled) {
      playTrack(musicIdx)
    }
  }

  // Background: swap in per-level image plane, fall back to teal
  bgMeshes.forEach((m) => { if (m) world.remove(m) })
  const bgIndex = gl.bgIndex
  const bg = bgIndex >= 0 ? bgMeshes[bgIndex] : null
  if (bg) {
    scene.background = null
    world.add(bg)
  } else {
    scene.background = new THREE.Color('#00d8d8')
  }

  const data = gl.data

  // Recompute world bounds from level geometry (or use custom bounds if set)
  worldBounds = gl.customWorldBounds
    ? { ...gl.customWorldBounds }
    : computeWorldBounds(data, gl.spawns)

  currentPlatforms = data.platforms.map((r) => ({ ...r }))
  currentLadders = data.ladders.map((r) => ({ ...r }))

  // Resize and reposition background mesh to fit computed world bounds
  const bgW = worldBounds.right - worldBounds.left
  const bgH = worldBounds.top - worldBounds.bottom
  if (bg) {
    bg.geometry.dispose()
    bg.geometry = new THREE.PlaneGeometry(bgW, bgH)
    bg.position.set(
      (worldBounds.left + worldBounds.right) / 2,
      (worldBounds.bottom + worldBounds.top) / 2,
      -1,
    )
  }

  activeSpawns = gl.spawns
  const levelSpawn = activeSpawns[0]
  if (levelSpawn) {
    spawn.x = levelSpawn.x
    spawn.y = levelSpawn.y
  }

  clearGroup(staticLayer)
  clearGroup(enemyLayer)
  clearGroup(itemLayer)
  clearGroup(hazardLayer)
  hazards = []
  obstacles = []

  // Determine sprite rendering from spriteMap (data-driven).
  // Merge DEFAULT_SPRITE_MAP values as fallbacks — the level's own spriteMap
  // takes priority so that level-editor overrides (spriteScale, fps, animMode)
  // are respected during dry runs and normal play.
  const sm: Record<string, SpriteMapEntry> = {}
  for (const [kind, entry] of Object.entries(gl.spriteMap)) {
    const def = DEFAULT_SPRITE_MAP[kind]
    if (def) {
      sm[kind] = { ...entry }
      if (sm[kind].spriteScale === undefined && def.spriteScale !== undefined) sm[kind].spriteScale = def.spriteScale
      if (sm[kind].fps === undefined && def.fps !== undefined) sm[kind].fps = def.fps
      if (!sm[kind].animMode && def.animMode) sm[kind].animMode = def.animMode
    } else {
      sm[kind] = entry
    }
  }

  // Resize player mesh from config-driven spriteScale
  currentPlayerScale = sm['player']?.spriteScale ?? DEFAULT_SPRITE_MAP['player']?.spriteScale ?? 1.0
  playerMesh.geometry.dispose()
  playerMesh.geometry = new THREE.PlaneGeometry(player.w * currentPlayerScale, player.h * currentPlayerScale)
  // Adjust vertical offset so feet stay at the same position regardless of scale
  const meshH = player.h * currentPlayerScale
  playerVisualYOffset = (meshH - player.h) * 0.342

  // Build hazard configs from spriteMap entries with behavior.hazard
  const disabledHazards = new Set(gl.disabledHazards ?? [])
  levelHazardConfigs = []
  for (const [kind, entry] of Object.entries(sm)) {
    const beh = entry.behavior
    if (!beh.hazard) continue
    if (disabledHazards.has(kind)) continue  // skip disabled hazards
    const frames = entry.sprite ? (spriteFrameRegistry.get(entry.sprite) ?? []) : []
    const movement = (beh.hazardMovement as 'rise' | 'fall') ?? 'rise'
    const animated = beh.hazardAnimated ?? (frames.length > 1)
    const animFps = entry.fps ?? beh.hazardAnimFps ?? SPRITE_METADATA.get(entry.sprite)?.fps ?? 3.5
    // Use defaultSize from sprite.json config when available
    const ds = DEFAULT_SIZE[kind]
    let naturalW = ds?.[0] ?? (movement === 'fall' ? 0.7 : 0.8)
    let naturalH = ds?.[1] ?? (movement === 'fall' ? 0.7 : 0.8)
    if (frames.length > 0) {
      const cvs = frames[0].map?.image as HTMLCanvasElement | null
      if (cvs && cvs.width > 0 && cvs.height > 0) {
        const aspect = cvs.width / cvs.height
        naturalW = naturalH * aspect
      }
    }
    levelHazardConfigs.push({
      kind,
      movement,
      animated,
      animFps,
      animMode: entry.animMode ?? 'loop',
      frames,
      naturalW,
      naturalH,
      spriteScale: entry.spriteScale ?? 1.0,
      spawnInterval: movement === 'rise' ? 1.3 : 1.7,
      fallback: movement === 'rise' ? balloonSpriteMaterial : daggerSpriteMaterial,
    })
  }
  // Initialise spawn timers now that configs are built (must come AFTER the
  // config loop so there is one timer per hazard kind).
  hazardSpawnTimers = levelHazardConfigs.map((c) => c.spawnInterval * (0.5 + Math.random() * 0.5))

  // Build static obstacles from customElements with obstacle behavior in spriteMap
  for (const ce of gl.customElements ?? []) {
    const entry = sm[ce.kind]
    if (!entry?.behavior.obstacle) continue
    const frames = entry.sprite ? (spriteFrameRegistry.get(entry.sprite) ?? []) : []
    const aMode: AnimMode = entry.animMode ?? 'loop'
    const fps = entry.fps ?? entry.behavior.hazardAnimFps ?? SPRITE_METADATA.get(entry.sprite)?.fps ?? 4
    const blocking = entry.behavior.obstacleBlocking ?? false
    const mat = frames[0] ?? platformMaterial
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(ce.w, ce.h), mat)
    const obsScale = entry.spriteScale ?? 1.0
    mesh.scale.set(obsScale, obsScale, 1)
    mesh.position.set(ce.x + ce.w / 2, ce.y + ce.h / 2, renderBands.hazard.z)
    mesh.renderOrder = renderBands.hazard.order
    hazardLayer.add(mesh)
    obstacles.push({
      rect: { x: ce.x, y: ce.y, w: ce.w, h: ce.h },
      mesh, kind: ce.kind, blocking, frames, animTime: 0, animFps: fps, animMode: aMode,
    })
  }

  // Helper: render a set of platform rects with a given tiling material
  const renderPlatforms = (rects: Rect[], tileMat: THREE.MeshBasicMaterial | null) => {
    for (const r of rects) {
      let m: THREE.Mesh
      if (tileMat && tileMat.map) {
        const tileImg = tileMat.map.image as HTMLCanvasElement
        const tileAspect = tileImg.width / Math.max(tileImg.height, 1)
        const tileWorldW = tileAspect * r.h
        const repeatX = r.w / tileWorldW
        const tex = tileMat.map.clone()
        tex.needsUpdate = true
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = THREE.RepeatWrapping
        tex.repeat.set(repeatX, 1)
        const mat = tileMat.clone()
        mat.map = tex
        m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), mat)
        m.position.set(r.x + r.w / 2, r.y + r.h / 2, renderBands.platform.z)
      } else {
        m = new THREE.Mesh(new THREE.BoxGeometry(r.w, r.h, 2), platformMaterial)
        m.position.set(r.x + r.w / 2, r.y + r.h / 2, renderBands.platform.z)
      }
      m.renderOrder = renderBands.platform.order
      staticLayer.add(m)
    }
  }

  // Main platforms (earth / log — whichever non-girder h-tiled kind is in the spriteMap)
  const platformKind = Object.keys(sm).find(k => sm[k].tiling === 'h' && k !== 'girder') ?? ''
  const platformSprite = platformKind ? sm[platformKind].sprite : ''
  const platformTileMat = platformSprite ? await loadTilingMaterial(platformSprite, 'h') : null
  // Only the base platforms array (girders have been merged into data.platforms
  // for collision but are rendered separately below).
  const basePlatformSet = new Set(gl.girders.map(([x, y, w, h]) => `${x},${y},${w},${h}`))
  const basePlatforms = currentPlatforms.filter(r => !basePlatformSet.has(`${r.x},${r.y},${r.w},${r.h}`))
  renderPlatforms(basePlatforms, platformTileMat)

  // Girder platforms
  const girderEntry = sm.girder
  const girderSprite = girderEntry?.sprite ?? ''
  const girderTileMat = girderSprite ? await loadTilingMaterial(girderSprite, 'h') : null
  const girderRects = gl.girders.map(([x, y, w, h]) => ({ x, y, w, h }))
  renderPlatforms(girderRects, girderTileMat)

  const ladderKind = Object.keys(sm).find(k => sm[k].tiling === 'v' && k !== 'chain') ?? ''
  const ladderSprite = ladderKind ? sm[ladderKind].sprite : ''
  const ladderTileMat = ladderSprite ? await loadTilingMaterial(ladderSprite, 'v') : null

  // Separate chain rects and chain_clamp rects from base ladders for rendering
  const chainSet = new Set(gl.chains.map(([x, y, w, h]) => `${x},${y},${w},${h}`))
  const clampSet = new Set(gl.chain_clamps.map(([x, y, w, h]) => `${x},${y},${w},${h}`))
  const baseLadders = currentLadders.filter(r => !chainSet.has(`${r.x},${r.y},${r.w},${r.h}`) && !clampSet.has(`${r.x},${r.y},${r.w},${r.h}`))

  for (const r of baseLadders) {
    const z = renderBands.ladder.z
    if (ladderTileMat && ladderTileMat.map) {
      const img = ladderTileMat.map.image as HTMLCanvasElement
      // Single quad with vertical texture repeat — clips exactly to the
      // rope/ladder rect height so tiles never extend above the platform.
      const tileWorldH = (r.w * img.height) / img.width
      const repeatY = r.h / tileWorldH
      const tex = ladderTileMat.map.clone()
      tex.needsUpdate = true
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(1, repeatY)
      const mat = ladderTileMat.clone()
      mat.map = tex
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), mat)
      m.position.set(r.x + r.w / 2, r.y + r.h / 2, z)
      m.renderOrder = renderBands.ladder.order
      staticLayer.add(m)
    } else {
      const railW = Math.max(0.08, r.w * 0.18)
      const rungH = 0.08
      const rungInset = railW * 0.7
      const rungSpanW = Math.max(0.12, r.w - rungInset * 2)
      const rungStep = 0.48
      const leftRail = new THREE.Mesh(new THREE.BoxGeometry(railW, r.h, 0.12), ladderRailMaterial)
      leftRail.position.set(r.x + railW * 0.5, r.y + r.h * 0.5, z)
      leftRail.renderOrder = renderBands.ladder.order
      staticLayer.add(leftRail)
      const rightRail = new THREE.Mesh(new THREE.BoxGeometry(railW, r.h, 0.12), ladderRailMaterial)
      rightRail.position.set(r.x + r.w - railW * 0.5, r.y + r.h * 0.5, z)
      rightRail.renderOrder = renderBands.ladder.order
      staticLayer.add(rightRail)
      const startY = r.y + 0.16
      const endY = r.y + r.h - 0.16
      for (let ly = startY; ly <= endY; ly += rungStep) {
        const rung = new THREE.Mesh(new THREE.BoxGeometry(rungSpanW, rungH, 0.1), ladderRungMaterial)
        rung.position.set(r.x + r.w * 0.5, ly, z)
        rung.renderOrder = renderBands.ladder.order
        staticLayer.add(rung)
      }
    }
  }

  // ── Chain rendering (with chain_attachment at top) ───────────────────────
  const chainEntry = sm.chain
  const chainSprite = chainEntry?.sprite ?? ''
  const chainTileMat = chainSprite ? await loadTilingMaterial(chainSprite, 'v') : null
  // Load chain_attachment as a one-off material
  const chainAttachUrl = findSpriteUrl('platform_links/chain/chain_attachment')
  const chainAttachMat: THREE.MeshBasicMaterial | null = await new Promise(resolve => {
    if (!chainAttachUrl) { resolve(null); return }
    const img = new Image()
    img.onload = () => resolve(makeCanvasMaterial(img))
    img.onerror = () => resolve(null)
    img.src = chainAttachUrl
  })
  const chainRects = gl.chains.map(([x, y, w, h]) => ({ x, y, w, h }))
  for (const r of chainRects) {
    const z = renderBands.ladder.z
    if (chainTileMat && chainTileMat.map) {
      const img = chainTileMat.map.image as HTMLCanvasElement
      const tileWorldH = (r.w * img.height) / img.width
      const repeatY = r.h / tileWorldH
      const tex = chainTileMat.map.clone()
      tex.needsUpdate = true
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(1, repeatY)
      const mat = chainTileMat.clone()
      mat.map = tex
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), mat)
      m.position.set(r.x + r.w / 2, r.y + r.h / 2, z)
      m.renderOrder = renderBands.ladder.order
      staticLayer.add(m)
    }
    // Chain attachment at the top centre
    if (chainAttachMat) {
      const cvs = chainAttachMat.map?.image as HTMLCanvasElement | null
      if (cvs && cvs.width > 0 && cvs.height > 0) {
        const aspect = cvs.width / cvs.height
        const attachW = r.w * 2.2
        const attachH = attachW / aspect
        const am = new THREE.Mesh(new THREE.PlaneGeometry(attachW, attachH), chainAttachMat)
        am.position.set(r.x + r.w / 2, r.y + r.h - attachH * 0.35, z + 0.01)
        am.renderOrder = renderBands.ladder.order + 1
        staticLayer.add(am)
      }
    }
  }

  // ── Chain clamp rendering ─────────────────────────────────────────────────
  const clampEntry = sm.chain_clamp
  const clampSpritePath = clampEntry?.sprite ?? ''
  const clampMat: THREE.MeshBasicMaterial | null = clampSpritePath
    ? await new Promise(resolve => {
        const url = findSpriteUrl(clampSpritePath)
        if (!url) { resolve(null); return }
        const img = new Image()
        img.onload = () => resolve(makeCanvasMaterial(img))
        img.onerror = () => resolve(null)
        img.src = url
      })
    : null
  const clampRects = gl.chain_clamps.map(([x, y, w, h]) => ({ x, y, w, h }))
  for (const r of clampRects) {
    const z = renderBands.ladder.z
    if (clampMat) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), clampMat)
      m.position.set(r.x + r.w / 2, r.y + r.h / 2, z)
      m.renderOrder = renderBands.ladder.order
      staticLayer.add(m)
    }
  }

  // Pre-build per-enemy-kind frame sets and animation sequences from spriteMap
  const enemyFrameCache = new Map<string, { frames: THREE.MeshBasicMaterial[] | null; animSeq: MonsterAnimEntry[] | null; scale: number; fps: number }>()
  for (const [kind, entry] of Object.entries(sm)) {
    if (!entry.behavior.enemy) continue
    const frames = entry.sprite ? (spriteFrameRegistry.get(entry.sprite) ?? null) : null
    const animSeq: MonsterAnimEntry[] | null = frames && frames.length > 1
      ? [
          ...Array.from({ length: frames.length }, (_, i) => ({ f: i, flip: false })),
          ...Array.from({ length: Math.max(0, frames.length - 2) }, (_, i) => ({ f: frames.length - 2 - i, flip: false })),
        ]
      : null
    // fps priority: spriteMap entry > sprite.json metadata > default
    const spriteFps = entry.fps ?? SPRITE_METADATA.get(entry.sprite)?.fps
    const fps = spriteFps ?? (frames && frames.length > 1 ? 12 : 8)
    enemyFrameCache.set(kind, { frames, animSeq, scale: entry.spriteScale ?? 1.0, fps })
  }
  // Fallback entry for monsters with no specific spriteMap kind
  const fallbackEnemy = enemyFrameCache.values().next().value ?? { frames: null, animSeq: null, scale: 1.0, fps: 10 }

  monsters = data.monsters.map((r, idx) => {
    const kind = gl.monsterKinds[idx] ?? 'monster'
    const kindData = enemyFrameCache.get(kind) ?? fallbackEnemy
    const useFrames = kindData.frames
    const useAnimSeq = kindData.animSeq
    const hasFrames = useFrames && useFrames.length > 0
    const invertedSprite = Math.random() < 0.5
    // Scale comes entirely from config (sprite.json / per-level spriteMap)
    const spriteScale = kindData.scale

    // Place mesh with feet at the bottom of the placement rect (r.y).
    const meshW = r.w * spriteScale
    const meshH = r.h * spriteScale
    const visualCX = r.x + r.w / 2
    const visualCY = r.y + meshH / 2

    // Collision rect centred on the visual sprite
    const collW = meshW * 0.4
    const collH = meshH * 0.55
    const collRect: Rect = {
      x: visualCX - collW / 2,
      y: visualCY - collH / 2,
      w: collW,
      h: collH,
    }

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(r.w * spriteScale, r.h * spriteScale), hasFrames ? useFrames[0] : monsterSpriteMaterial)
    mesh.position.set(visualCX, visualCY, renderBands.monster.z)
    mesh.renderOrder = renderBands.monster.order
    if (hasFrames) mesh.scale.x = invertedSprite ? 1 : -1
    else if (invertedSprite) mesh.scale.x = -1
    enemyLayer.add(mesh)
    return {
      rect: collRect,
      mesh,
      visualYOffset: 0,  // rect is already centred on the visual
      active: true,
      knocked: false,
      vx: 0,
      vy: 0,
      spin: 0,
      spriteScale,
      frames: useFrames,
      deathFrames: useFrames,  // reuse standing frames for death
      animTime: Math.random() * 10,
      deathAnimTime: 0,
      animRate: kindData.fps,
      animSeq: useAnimSeq,
      animSeqPos: 0,
      invertedSprite,
    }
  })

  // Compute the visual Y for an item: find the nearest platform at the item's x
  // and float the item so its visual bottom sits at the platform top.
  const itemVisualY = (r: Rect, kindScale = 1.0): number => {
    const cx = r.x + r.w / 2
    let best: { dist: number; top: number } | null = null
    for (const p of data.platforms) {
      const pt = p.y + p.h
      if (cx >= p.x - 0.5 && cx <= p.x + p.w + 0.5 && Math.abs(r.y - pt) < 2.5) {
        const dist = Math.abs(r.y - pt)
        if (!best || dist < best.dist) best = { dist, top: pt }
      }
    }
    const platTop = best ? best.top : r.y
    return platTop + (r.h * kindScale) / 2
  }

  // Build collectibles from data arrays + spriteMap behavior (data-driven)
  // Map from spriteMap kind → the corresponding rect array in LevelData
  const collectibleDataMap: Record<string, Rect[]> = {
    key: data.keys,
    bulb: data.bulbs,
    diamond: data.treasures,
  }
  const collectibleSources: Array<{ kind: string; rects: Rect[]; frames: THREE.MeshBasicMaterial[] }> = []
  for (const [kind, entry] of Object.entries(sm)) {
    if (!entry.behavior.collectible) continue
    const rects = collectibleDataMap[kind]
    if (!rects || rects.length === 0) continue
    const frames = entry.sprite ? (spriteFrameRegistry.get(entry.sprite) ?? []) : []
    collectibleSources.push({ kind, rects, frames })
  }
  collectibles = collectibleSources.flatMap(({ kind, rects, frames }) => {
    const entry = sm[kind]
    const beh = entry?.behavior ?? {}
    const aMode: AnimMode = entry?.animMode ?? 'loop'
    return rects.map((r) => {
      const kindScale = entry?.spriteScale ?? 1.0
      const collectScale = kindScale
      let geoW = r.w * collectScale
      const geoH = r.h * collectScale
      // Preserve sprite frame's natural aspect ratio so tall/narrow
      // sprites (e.g. key) aren't stretched into a square geometry.
      if (frames.length > 0 && frames[0].map) {
        const img = frames[0].map.image as { width: number; height: number }
        if (img.width && img.height) geoW = geoH * (img.width / img.height)
      }
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(geoW, geoH),
        frames[0],
      )
      const visualY = itemVisualY(r, kindScale)
      mesh.position.set(r.x + r.w / 2, visualY, renderBands.item.z)
      mesh.renderOrder = renderBands.item.order
      itemLayer.add(mesh)
      const startPhase = beh.collectible === 'mandatory' ? 0 : Math.random() * 10
      const itemFps = entry?.fps ?? SPRITE_METADATA.get(entry?.sprite ?? '')?.fps ?? 7
      return {
        rect: { ...r }, kind, mandatory: beh.collectible === 'mandatory',
        scoreValue: beh.scoreValue ?? 0, hud: beh.hud ?? false,
        hudLabel: beh.hudLabel ?? kind, frames, mesh,
        active: true, animPhase: startPhase, animFps: itemFps, animMode: aMode, visualY,
      }
    })
  })

  levelEl.textContent = `Level: ${index + 1}${invertedCycle ? ' (Inverted)' : ''}`
  mandatoryCollectibles = collectibles.filter((c) => c.mandatory)
  updateCollectibleHUD()
  // Set the level countdown timer from the level data (defaults to 120s).
  currentTimeLimit = gl.timeLimit
  levelTimer = currentTimeLimit
  timerEl.textContent = formatTime(currentTimeLimit)
  timerEl.classList.remove('timer-critical')
  snapCameraToPlayer()
  levelLoading = false
}

const nextLevel = async () => {
  if (dryRunActive) { stopDryRun(); return }
  if (levelLoading) return
  mandatoryCollectibles = []  // prevent re-entrant calls while loadLevel is async
  levelIndex += 1
  if (levelIndex >= levelCycle.length) {
    levelIndex = 0
    loopCount += 1
    invertedCycle = !invertedCycle
    setInvertedMode(invertedCycle)
    setStatus(invertedCycle ? 'Screen Flipped!' : 'Screen Restored!')
  }

  await loadLevel(levelIndex)
  respawn()
}

const respawn = () => {
  const s = activeSpawns[Math.floor(Math.random() * activeSpawns.length)]
  player.x = s.x
  player.y = s.y
  player.vx = 0
  player.vy = 0
  player.grounded = false
  player.climbing = false
  player.dead = false
  player.facing = 1
  frakBubbleMesh.visible = false
  yoyoReach = 0
  yoyoReturning = false
  yoyoCastLocked = false
  jumpZoomActive = false
  fallPeakY = player.y
  wasGroundedLastFrame = false
  coyoteTimer = 0
  jumpBufferTimer = 0
  walkAnimTime = 0
  climbAnimDist = 0
  currentPlayerVisual = 'idle'
  currentPlayerFrame = -1
  playerVisualTime = 0
  idleBoredTimer = 0
  boredPhase = 'none'
  bufferedMoveX = 0
  bufferedMoveY = 0
  levelTimer = currentTimeLimit
  timerEl.textContent = formatTime(currentTimeLimit)
  timerEl.classList.remove('timer-critical')
  snapCameraToPlayer()
}

const playSfx = (url: string, maxDuration?: number) => {
  const a = new Audio(url)
  a.volume = 0.85
  if (maxDuration !== undefined) {
    // Stop after maxDuration seconds
    const stop = () => { a.pause(); a.src = '' }
    a.addEventListener('canplaythrough', () => {
      setTimeout(stop, maxDuration * 1000)
    }, { once: true })
    // fallback in case canplaythrough fires late
    setTimeout(stop, maxDuration * 1000 + 500)
  }
  a.play().catch((e) => console.warn('[sfx]', e))
  return a
}

const killPlayer = (deathMsg = 'FRAK!') => {
  if (player.dead) return
  frakBubbleMesh.visible = false
  lives -= 1
  livesEl.textContent = `Lives: ${Math.max(lives, 0)}`
  player.dead = true
  yoyoReach = 0
  yoyoReturning = false
  yoyoCastLocked = false
  jumpZoomActive = false
  respawnTimer = 3.0
  playerMesh.visible = true
  yoyoMesh.visible = false
  setStatus(deathMsg, 1800)
  // Clear all active hazards so they can't chain-kill the player on respawn.
  resetHazards()

  if (lives <= 0) {
    // Game over – stop BGM then play full life-lost track
    stopAllMusic()
    let gameOverSfx: HTMLAudioElement | null = null
    if (musicStyle === 'new') {
      gameOverSfx = playSfx(sfxLifeLostRemasterUrl)  // full remaster
    } else {
      gameOverSfx = playSfx(sfxLifeLostOeUrl)        // full OE
    }
    lives = 3
    score = 0
    scoreEl.textContent = 'Score: 0'
    livesEl.textContent = 'Lives: 3'
    levelIndex = 0
    loopCount = 0
    invertedCycle = false
    setInvertedMode(false)
    respawnTimer = 9999  // freeze auto-respawn until overlay is dismissed
    showOverlay(gameoverScreenEl, () => {
      // Stop game-over music before returning to title
      if (gameOverSfx) { gameOverSfx.pause(); gameOverSfx.src = ''; gameOverSfx = null }
      stopAllMusic()
      if (dryRunActive) {
        stopDryRun()
        return
      }
      titleScreenEl.style.display = 'flex'
      overlayShowing = true
      randomizeTitleBg()
      startCastAnim()
      playTitleMusic()
      const startHandler = async () => {
        titleScreenEl.style.display = 'none'
        overlayShowing = false
        clearInputs()
        respawnTimer = 0
        await loadPublicSpriteOverrides()
        await loadLevel(levelIndex)
        respawn()
      }
      titleStartBtn.addEventListener('click', startHandler, { once: true })
    })
  } else {
    // Lost a life but still have lives remaining – stop BGM, play sting, then resume BGM
    stopAllMusic()
    if (musicStyle === 'new') {
      playSfx(sfxLifeLostRemasterUrl, 2.5)  // first 2.5s of remaster
      setTimeout(() => resumeMusic(), 2600)
    } else {
      const sfx = playSfx(sfxLifeLostOeUrl)              // full OE (it's short)
      sfx.addEventListener('ended', () => resumeMusic())
    }
  }
}

const spawnHazard = (config: LevelHazardConfig) => {
  let spawnX: number
  let spawnY: number
  let vx: number
  let vy: number
  let frameIdx = 0

  if (config.movement === 'rise') {
    // Rise from below (balloon-style)
    spawnX = 1.5 + Math.random() * (worldBounds.right - 3)
    spawnY = worldBounds.bottom - 0.5
    vx = (Math.random() - 0.5) * 0.8
    vy = 2.8 + Math.random() * 1.8
  } else {
    // Fall from above (dagger-style) — three directions
    const dirRoll = Math.random()
    if (dirRoll < 0.33) {
      spawnX = worldBounds.left + 2 + Math.random() * (worldBounds.right - worldBounds.left - 4)
      vx = (Math.random() - 0.5) * 0.6
      vy = -8
      frameIdx = 0
    } else if (dirRoll < 0.66) {
      spawnX = worldBounds.right - 1
      vx = -4.7
      vy = -5.2
      frameIdx = 1
    } else {
      spawnX = worldBounds.left + 1
      vx = 4.7
      vy = -5.2
      frameIdx = 2
    }
    spawnY = worldBounds.top - 1
  }

  const hw = config.naturalW
  const hh = config.naturalH
  const mat = config.frames.length > frameIdx ? config.frames[frameIdx] : config.fallback
  // For falling hazards with directional frames, preserve aspect ratio per frame
  let geomW = hw
  let geomH = hh
  if (config.movement === 'fall') {
    const cvs = mat.map?.image as HTMLCanvasElement | null
    const natW = cvs?.width ?? 1
    const natH = cvs?.height ?? 1
    const aspect = natH > 0 ? natW / natH : 1
    geomH = config.naturalH
    geomW = geomH * aspect
  }
  const rect: Rect = { x: spawnX, y: spawnY, w: geomW, h: geomH }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(geomW, geomH), mat)
  const hazScale = config.spriteScale
  mesh.scale.set(hazScale, hazScale, 1)
  mesh.position.set(spawnX + geomW / 2, spawnY + geomH / 2, renderBands.hazard.z)
  mesh.renderOrder = renderBands.hazard.order
  hazardLayer.add(mesh)

  hazards.push({
    rect,
    mesh,
    vx,
    vy,
    animTime: 0,
    kind: config.kind,
    animated: config.animated,
    animFps: config.animFps,
    animMode: config.animMode,
    hazardFrames: config.frames.length > 0 ? config.frames : null,
  })
}

const attackRect = (): Rect => {
  const reach = Math.max(yoyoReach, player.w * 0.45)
  const body = getPlayerRect()
  _hitRect.x = player.facing > 0 ? body.x + body.w : body.x - reach
  _hitRect.y = body.y + 0.05
  _hitRect.w = reach
  _hitRect.h = body.h - 0.1
  return _hitRect
}

const stepPhysics = (dt: number) => {
  let moveX = Number(inputState.right) - Number(inputState.left)
  const moveY = Number(inputState.up) - Number(inputState.down)
  // Block all movement while the stand-up animation is playing
  if (boredPhase === 'standUp') {
    moveX = 0
    inputState.jumpPressed = false
    jumpBufferTimer = 0
  }
  const ladderNow = isOnLadder()

  const updateBufferedAxis = (current: number, target: number) => {
    const rate = Math.abs(target) > Math.abs(current) ? movementConfig.inputRiseRate : movementConfig.inputFallRate
    const step = rate * dt
    return THREE.MathUtils.clamp(current + THREE.MathUtils.clamp(target - current, -step, step), -1, 1)
  }
  bufferedMoveX = updateBufferedAxis(bufferedMoveX, moveX)
  bufferedMoveY = updateBufferedAxis(bufferedMoveY, moveY)

  if (player.grounded) coyoteTimer = movementConfig.coyoteTime
  else coyoteTimer = Math.max(0, coyoteTimer - dt)

  if (inputState.jumpPressed) jumpBufferTimer = movementConfig.jumpBufferTime
  else jumpBufferTimer = Math.max(0, jumpBufferTimer - dt)

  if ((moveY !== 0 || inputState.up) && ladderNow) player.climbing = true
  // Climbing down: only enter climbing if already airborne on a ladder
  // (grounded climb-down is handled by the isLadderBelow() block below)
  if (inputState.down && ladderNow && !player.grounded) player.climbing = true
  if (inputState.down && !ladderNow && player.grounded && isLadderBelow()) {
    // Find the closest ladder below and snap to its centre so the player
    // always goes down the intended ladder, not the nearest-to-right one.
    const body2 = getPlayerRect()
    const probe: Rect = { x: body2.x + body2.w * 0.2, y: body2.y - 1.25, w: body2.w * 0.6, h: 1.4 }
    const belowLadders = currentLadders.filter((l) => intersects(probe, l))
    if (belowLadders.length > 0) {
      const nearest = belowLadders.reduce((best, l) =>
        Math.abs(player.x - (l.x + l.w / 2)) < Math.abs(player.x - (best.x + best.w / 2)) ? l : best
      )
      player.x = nearest.x + nearest.w / 2   // snap X to ladder centre
      player.y -= 1.2
      player.grounded = false
      player.climbing = true
    }
  }
  if (!ladderNow && !player.grounded && !isLadderBelow()) player.climbing = false

  const targetVx = bufferedMoveX * movementConfig.runSpeed
  const accel = player.grounded
    ? Math.abs(bufferedMoveX) < 0.01
      ? movementConfig.groundDecel
      : movementConfig.groundAccel
    : movementConfig.airAccel
  const vxDelta = targetVx - player.vx
  const vxStep = accel * dt
  player.vx += THREE.MathUtils.clamp(vxDelta, -vxStep, vxStep)
  if (Math.abs(bufferedMoveX) > 0.05) player.facing = bufferedMoveX > 0 ? 1 : -1

  if (player.climbing) {
    player.vx = 0   // lock horizontal movement while on a ladder
    player.vy = bufferedMoveY * movementConfig.climbSpeed
    if (Math.abs(bufferedMoveY) < 0.01 && !ladderNow) player.climbing = false
  } else {
    const gravityBase = player.vy > 0 ? movementConfig.gravityUp : movementConfig.gravityDown
    const gravityBoost = player.vy > 0 && !inputState.jumpHeld ? movementConfig.shortHopGravityBoost : 0
    player.vy -= (gravityBase + gravityBoost) * dt
  }

  if (jumpBufferTimer > 0 && (player.grounded || coyoteTimer > 0)) {
    player.vy = movementConfig.jumpVelocity
    player.grounded = false
    player.climbing = false
    jumpZoomActive = true
    coyoteTimer = 0
    jumpBufferTimer = 0
  }
  inputState.jumpPressed = false

  player.x += player.vx * dt
  let body = getPlayerRect()
  // Platforms are one-way: solid only from above.  The player walks freely
  // left/right and can jump up through platforms from below.

  // Remember feet position before vertical movement so we can tell whether
  // the player was genuinely above a platform (valid landing) or walked
  // horizontally into its side (should be ignored).
  const prevFeetY = player.y - player.h / 2

  player.y += player.vy * dt
  body = getPlayerRect()
  player.grounded = false

  // ── One-way platform collision ────────────────────────────────────────
  // A platform is a valid landing target only if the player's feet were
  // previously at or above its top edge.  This small tolerance lets the
  // player step up onto adjacent platforms at the same height while
  // preventing horizontal walks from snapping them onto higher ledges.
  const STEP_UP = 0.35

  if (player.vy <= 0) {
    // Falling or stationary — find the highest valid platform to land on
    let landPlatform: Rect | null = null
    let landTop = -Infinity
    for (const platform of currentPlatforms) {
      if (!intersects(body, platform)) continue
      const platTop = platform.y + platform.h
      // Only land if player was above this platform's top before this frame
      if (prevFeetY < platTop - STEP_UP) continue
      if (platTop > landTop) {
        landTop = platTop
        landPlatform = platform
      }
    }
    if (landPlatform) {
      if (player.climbing && moveY < 0 && isOnLadder() && isLadderBelow()) {
        // Climbing down through a platform — let player descend
      } else {
        player.y = landPlatform.y + landPlatform.h + player.h / 2
        player.vy = 0
        player.grounded = true
        player.climbing = false
      }
      body = getPlayerRect()
    }
  } else {
    // Moving upward — platforms are pass-through from below (one-way).
    // Exception: ladder-top assist transfers the player onto the platform.
    if (player.climbing && moveY > 0 && isOnLadder()) {
      for (const platform of currentPlatforms) {
        if (!intersects(body, platform)) continue
        player.y = platform.y + platform.h + player.h / 2
        player.vy = 0
        player.grounded = true
        player.climbing = false
        body = getPlayerRect()
        break
      }
    }
    // Otherwise: jump freely through platforms from below
  }

  if (player.y < worldBounds.bottom - 2) killPlayer()

  if (!player.grounded && !wasGroundedLastFrame) {
    // While climbing intentionally, reset fallPeakY to the current position each
    // frame so a long ladder descent never triggers fall-damage on landing.
    fallPeakY = player.climbing ? player.y : Math.max(fallPeakY, player.y)
  }

  if (player.grounded && !wasGroundedLastFrame) {
    jumpZoomActive = false
    const drop = fallPeakY - player.y
    if (drop > 4.8) {
      killPlayer()
      return
    }
  }

  if (!player.grounded && wasGroundedLastFrame) {
    fallPeakY = player.y
  }
  wasGroundedLastFrame = player.grounded

  player.x = THREE.MathUtils.clamp(player.x, worldBounds.left + player.w / 2, worldBounds.right - player.w / 2)
  player.y = THREE.MathUtils.clamp(player.y, worldBounds.bottom - 1, worldBounds.top)
}

const updateGame = (dt: number, elapsed: number) => {
  if (overlayShowing) return
  if (player.dead) {
    respawnTimer -= dt
    if (respawnTimer <= 0) {
      playerMesh.visible = true
      respawn()
    }
    return
  }

  stepPhysics(dt)

  // ── Level countdown timer ────────────────────────────────────────────────
  if (levelTimer > 0) {
    levelTimer -= dt
    if (levelTimer <= 0) {
      levelTimer = 0
      timerEl.textContent = '0:00'
      timerEl.classList.add('timer-critical')
      killPlayer('Time Out!')
      return
    }
    timerEl.textContent = formatTime(levelTimer)
    timerEl.classList.toggle('timer-critical', levelTimer < 30)
  }

  const yoyoMaxReach = player.h * 3.0  // max 3 character heights
  if (!inputState.attackHeld) yoyoCastLocked = false

  const castStarted = inputState.attackHeld && !yoyoCastLocked && yoyoReach <= 0 && !yoyoReturning
  if (castStarted) yoyoCastLocked = true
  const castExtending = inputState.attackHeld && yoyoCastLocked && yoyoReach > 0 && !yoyoReturning

  if (!inputState.attackHeld && yoyoReach > 0) yoyoReturning = true

  // Retract immediately when the player jumps or moves horizontally
  if (yoyoReach > 0 && !yoyoReturning && (!player.grounded || Math.abs(player.vx) > 0.5)) {
    yoyoReturning = true
  }

  if (castStarted || castExtending) {
    yoyoReach = Math.min(yoyoMaxReach, yoyoReach + yoyoConfig.extendSpeed * dt)
    if (yoyoReach >= yoyoMaxReach) yoyoReturning = true
  }

  if (yoyoReturning) {
    yoyoReach = Math.max(0, yoyoReach - yoyoConfig.retractSpeed * dt)
    if (yoyoReach <= 0) {
      yoyoReach = 0
      yoyoReturning = false
    }
  }

  // Anchor at the player's throwing hand – mirrors with facing direction.
  // Derive arm position from yoyo reach fraction so animation, anchor, and
  // string all stay perfectly in sync.  reachFrac 0 = arm down (resting),
  // reachFrac 1 = arm fully thrown forward/up.
  const reachFrac = yoyoMaxReach > 0 ? THREE.MathUtils.clamp(yoyoReach / yoyoMaxReach, 0, 1) : 0
  // X: hand starts close to body (arm down) and extends forward during throw
  const handXOffset = THREE.MathUtils.lerp(0.2, 0.65, reachFrac)
  // Y: hand starts low (arm down, at side) and rises during throw
  const handYOffset = THREE.MathUtils.lerp(0.1, 0.5, reachFrac)
  const yoyoAnchorX = player.x + player.facing * handXOffset
  const yoyoAnchorY = player.y + handYOffset
  const isYoyoActive = yoyoReach > 0.01
  yoyoMesh.visible = isYoyoActive
  yoyoMesh.position.set(yoyoAnchorX + player.facing * yoyoReach, yoyoAnchorY, renderBands.yoyo.z)
  if (isYoyoActive) {
    // String mesh: stretches from player hand to disc while cast.
    yoyoStringMesh.visible = true
    yoyoStringMesh.scale.x = yoyoReach * player.facing
    yoyoStringMesh.position.set(yoyoAnchorX + player.facing * yoyoReach * 0.5, yoyoAnchorY, renderBands.yoyo.z - 0.02)
  } else {
    yoyoStringMesh.visible = false
  }

  const body = getPlayerRect()

  for (let hi = 0; hi < levelHazardConfigs.length; hi++) {
    hazardSpawnTimers[hi] -= dt
    if (hazardSpawnTimers[hi] <= 0) {
      const cfg = levelHazardConfigs[hi]
      hazardSpawnTimers[hi] = cfg.spawnInterval + Math.random() * cfg.spawnInterval * 1.2
      spawnHazard(cfg)
    }
  }

  const hitRect = yoyoReach >= yoyoConfig.minActiveReach ? attackRect() : null

  for (let i = hazards.length - 1; i >= 0; i -= 1) {
    const hazard = hazards[i]
    hazard.rect.x += hazard.vx * dt
    hazard.rect.y += hazard.vy * dt

    hazard.mesh.position.set(hazard.rect.x + hazard.rect.w / 2, hazard.rect.y + hazard.rect.h / 2, renderBands.hazard.z)
    if (hazard.animated && hazard.hazardFrames && hazard.hazardFrames.length > 1) {
      hazard.animTime += dt * hazard.animFps
      const fc = hazard.hazardFrames.length
      let fi: number
      if (hazard.animMode === 'pingpong') {
        fi = pingPongFrame(Math.floor(hazard.animTime), fc)
      } else if (hazard.animMode === 'once') {
        fi = Math.min(Math.floor(hazard.animTime), fc - 1)
      } else {
        fi = Math.floor(hazard.animTime) % fc
      }
      hazard.mesh.material = hazard.hazardFrames[fi]
    }

    const out =
      hazard.rect.y < worldBounds.bottom - 3 ||
      hazard.rect.y > worldBounds.top + 3 ||
      hazard.rect.x < worldBounds.left - 3 ||
      hazard.rect.x > worldBounds.right + 3
    if (out) {
      hazardLayer.remove(hazard.mesh)
      hazards.splice(i, 1)
      continue
    }

    if (hitRect && intersects(hitRect, hazard.rect)) {
      hazardLayer.remove(hazard.mesh)
      hazards.splice(i, 1)
      score += 60
      scoreEl.textContent = `Score: ${score}`
      yoyoReturning = true   // retract immediately on hit
      continue
    }

    if (intersects(body, hazard.rect)) {
      killPlayer()
      return
    }
  }

  // ── Obstacle collision ──
  for (const obs of obstacles) {
    // Animate
    if (obs.frames.length > 1) {
      obs.animTime += dt * obs.animFps
      const fc = obs.frames.length
      let fi: number
      if (obs.animMode === 'pingpong') {
        fi = pingPongFrame(Math.floor(obs.animTime), fc)
      } else if (obs.animMode === 'once') {
        fi = Math.min(Math.floor(obs.animTime), fc - 1)
      } else {
        fi = Math.floor(obs.animTime) % fc
      }
      obs.mesh.material = obs.frames[fi]
    }
    if (intersects(body, obs.rect)) {
      if (obs.blocking) {
        // Push player out of obstacle (solid barrier)
        const dx = (body.x + body.w / 2) - (obs.rect.x + obs.rect.w / 2)
        const dy = (body.y + body.h / 2) - (obs.rect.y + obs.rect.h / 2)
        if (Math.abs(dx) > Math.abs(dy)) {
          if (dx > 0) player.x = obs.rect.x + obs.rect.w
          else player.x = obs.rect.x - body.w
          player.vx = 0
        } else {
          if (dy > 0) player.y = obs.rect.y + obs.rect.h
          else { player.y = obs.rect.y - body.h; player.vy = 0 }
        }
      } else {
        // Dangerous — kills player
        killPlayer()
        return
      }
    }
  }

  for (const monster of monsters) {
    if (!monster.active) continue

    if (!monster.knocked && monster.frames && monster.frames.length > 1) {
      monster.animTime += dt * monster.animRate
      if (monster.animSeq) {
        // Advance discrete sequence position each whole-number tick
        monster.animSeqPos = Math.floor(monster.animTime) % monster.animSeq.length
        const entry = monster.animSeq[monster.animSeqPos]
        const fi = Math.min(entry.f, monster.frames.length - 1)
        monster.mesh.material = monster.frames[fi]
        const faceFlip = monster.invertedSprite ? !entry.flip : entry.flip
        monster.mesh.scale.x = faceFlip ? 1 : -1
      } else {
        const frameIdx = Math.floor(monster.animTime) % monster.frames.length
        monster.mesh.material = monster.frames[frameIdx]
        // For non-seq monsters, invertedSprite flips the facing direction
        monster.mesh.scale.x = monster.invertedSprite ? -1 : 1
      }
    }

    if (monster.knocked) {
      // Hold the single death frame — no further animation cycling
      monster.vy -= 26 * dt
      monster.rect.x += monster.vx * dt
      monster.rect.y += monster.vy * dt
      monster.mesh.position.set(
        monster.rect.x + monster.rect.w / 2,
        monster.rect.y + monster.rect.h / 2 + monster.visualYOffset,
        renderBands.monster.z,
      )
      monster.mesh.rotation.z += monster.spin * dt

      const outOfWorld =
        monster.rect.x < worldBounds.left - 4 ||
        monster.rect.x > worldBounds.right + 4 ||
        monster.rect.y < worldBounds.bottom - 4 ||
        monster.rect.y > worldBounds.top + 4
      if (outOfWorld) {
        monster.active = false
        monster.mesh.visible = false
      }
      continue
    }

    if (hitRect && intersects(hitRect, monster.rect)) {
      const playerCenterX = body.x + body.w * 0.5
      const monsterCenterX = monster.rect.x + monster.rect.w * 0.5
      const launchDir = playerCenterX <= monsterCenterX ? 1 : -1

      monster.knocked = true
      monster.deathAnimTime = 0
      // Keep the current live-animation frame — applying the death sprite sheet
      // frame to the existing geometry causes aspect-ratio distortion.  Instead
      // give the monster a tumble spin so it reads as defeated while flying off.
      monster.vx = launchDir * 22
      monster.vy = 4.0
      monster.spin = launchDir * 5.5  // radians/sec tumble

      score += 200
      scoreEl.textContent = `Score: ${score}`
      yoyoReturning = true   // retract immediately on hit
      continue
    }
    if (intersects(body, monster.rect)) {
      killPlayer()
      return
    }
  }

  for (const item of collectibles) {
    if (!item.active) continue
    item.animPhase += dt * item.animFps
    if (item.frames.length > 1) {
      const fc = item.frames.length
      let fi: number
      if (item.animMode === 'pingpong') {
        fi = pingPongFrame(Math.floor(item.animPhase), fc)
      } else if (item.animMode === 'once') {
        fi = Math.min(Math.floor(item.animPhase), fc - 1)
      } else {
        fi = Math.floor(item.animPhase) % fc
      }
      item.mesh.material = item.frames[fi]
    }
    item.mesh.position.y = item.visualY + Math.sin(elapsed * 3 + item.rect.x) * 0.12

    if (intersects(body, item.rect)) {
      item.active = false
      item.mesh.visible = false
      score += item.scoreValue
      scoreEl.textContent = `Score: ${score}`
      if (item.hud) updateCollectibleHUD()
    }
  }

  if (mandatoryCollectibles.length > 0 && mandatoryCollectibles.every((i) => !i.active)) {
    score += 500
    scoreEl.textContent = `Score: ${score}`
    nextLevel()
  }
}

const updateCamera = (dt: number) => {
  const targetZoom = mapMode
    ? Math.min(
        cameraViewWidth  / (worldBounds.right - worldBounds.left),
        cameraViewHeight / (worldBounds.top   - worldBounds.bottom),
      )
    : player.dead
      ? cameraZoomConfig.deathZoom
      : jumpZoomEnabled && jumpZoomActive
        ? cameraZoomConfig.jumpZoom
        : cameraZoomConfig.baseZoom
  const zoomBlend = 1 - Math.exp(-cameraZoomConfig.smoothness * dt)
  const nextZoom = THREE.MathUtils.lerp(camera.zoom, targetZoom, zoomBlend)
  if (Math.abs(nextZoom - camera.zoom) > 0.0005) {
    camera.zoom = nextZoom
    camera.updateProjectionMatrix()
  }

  let targetX: number
  let targetY: number
  if (mapMode) {
    // Pan to level centre so the whole level is visible
    targetX = (worldBounds.left + worldBounds.right) / 2
    targetY = (worldBounds.bottom + worldBounds.top) / 2
  } else {
    const bounds = cameraBounds()
    targetX = clampCameraAxis(player.x, bounds.minX, bounds.maxX)
    targetY = clampCameraAxis(player.y + 1.4, bounds.minY, bounds.maxY)
  }

  const blend = 1 - Math.exp(-cameraConfig.smoothness * dt)
  camera.position.x = THREE.MathUtils.lerp(camera.position.x, targetX, blend)
  camera.position.y = THREE.MathUtils.lerp(camera.position.y, targetY, blend)
}

const resize = () => {
  const width = window.innerWidth
  const height = window.innerHeight
  renderer.setSize(width, height, false)

  const aspect = width / Math.max(height, 1)
  const viewHeight = 24
  const viewWidth = viewHeight * aspect
  cameraViewWidth = viewWidth
  cameraViewHeight = viewHeight
  camera.left = -viewWidth / 2
  camera.right = viewWidth / 2
  camera.top = viewHeight / 2
  camera.bottom = -viewHeight / 2
  camera.updateProjectionMatrix()
  snapCameraToPlayer()
}

window.addEventListener('resize', resize)
resize()

// Start title screen music then show overlay.
// playTitleMusic() is attempted immediately; browsers that enforce autoplay
// policy will silently refuse it, so we also re-fire on the first interaction.
vgmPlayer.preload([level0MusicUrl]).catch((e) => console.warn('[music preload level0]', e))
playTitleMusic()
// Re-fire title music on first user interaction (browsers block autoplay until then).
const playOnFirstInteraction = () => {
  if (overlayShowing) playTitleMusic()
}
window.addEventListener('pointerdown', playOnFirstInteraction, { once: true })
window.addEventListener('keydown',     playOnFirstInteraction, { once: true })
showOverlay(titleScreenEl, async () => {
  const selectEl = document.getElementById('title-level-select') as HTMLSelectElement | null
  if (selectEl) {
    levelIndex = parseInt(selectEl.value, 10) || 0
  }
  await loadLevel(levelIndex)
  respawn()
}, titleStartBtn)
startCastAnim()

// ── Level editor & dry-run ───────────────────────────────────────────────────

const levelEditor = new LevelEditor(document.getElementById('app')!)
const dryRunBannerEl = document.getElementById('dry-run-banner') as HTMLDivElement

const stopDryRun = () => {
  dryRunActive = false
  dryRunOverride = null
  dryRunBannerEl.style.display = 'none'
  stopAllMusic()
  if (musicEnabled) playTitleMusic()
  levelEditor.show()
}

const startDryRun = async (lf: LevelFile) => {
  // Re-load sprite overrides so any edits made in the sprite editor are
  // reflected immediately in the dry run.
  await loadPublicSpriteOverrides()

  dryRunOverride = levelFileToGameLevel(lf)
  dryRunActive = true

  levelEditor.hide()
  titleScreenEl.style.display = 'none'
  overlayShowing = false
  dryRunBannerEl.style.display = 'flex'

  score = 0
  lives = 3
  loopCount = 0
  invertedCycle = false
  setInvertedMode(false)
  livesEl.textContent = 'Lives: 3'
  scoreEl.textContent = 'Score: 0'

  levelIndex = 0  // index is irrelevant during dry run (dryRunOverride takes precedence)
  await loadLevel(levelIndex)
  respawn()
}

levelEditor.onDryRun = startDryRun
levelEditor.onClose = () => {
  levelEditor.hide()
  titleScreenEl.style.display = 'flex'
  overlayShowing = true
  randomizeTitleBg()
  startCastAnim()
  playTitleMusic()
}
levelEditor.onOpenSpriteEditor = () => {
  levelEditor.hide()
  spriteEditor.onClose = async () => {
    spriteEditor.hide()
    await loadPublicSpriteOverrides()
    levelEditor.reloadSprites()
    levelEditor.show()
  }
  spriteEditor.show()
}

document.getElementById('dry-run-back')!.addEventListener('click', stopDryRun)

const titleEditorBtn = document.getElementById('title-editor') as HTMLButtonElement
titleEditorBtn.addEventListener('click', () => {
  titleScreenEl.style.display = 'none'
  // Keep overlayShowing = true so the game loop doesn't run while the editor is open
  stopAllMusic()
  if (castRafId) { cancelAnimationFrame(castRafId); castRafId = 0 }
  levelEditor.show()
})

const spriteEditor = new SpriteEditor(document.getElementById('app')!)
const defaultSpriteEditorClose = () => {
  spriteEditor.hide()
  titleScreenEl.style.display = 'flex'
  overlayShowing = true
  randomizeTitleBg()
  startCastAnim()
  playTitleMusic()
}
spriteEditor.onClose = defaultSpriteEditorClose

document.getElementById('title-sprite-editor')!.addEventListener('click', () => {
  titleScreenEl.style.display = 'none'
  stopAllMusic()
  if (castRafId) { cancelAnimationFrame(castRafId); castRafId = 0 }
  spriteEditor.onClose = defaultSpriteEditorClose
  spriteEditor.show()
})

// ── Instructions modal wiring ──────────────────────────────────────────────
const helpModal = document.getElementById('help-modal') as HTMLDivElement
let helpOpener: HTMLElement | null = null
const openHelp = () => {
  helpOpener = document.activeElement as HTMLElement | null
  helpModal.style.display = 'flex'
  ;(document.getElementById('help-modal-close') as HTMLElement).focus()
}
const closeHelp = () => {
  helpModal.style.display = 'none'
  helpOpener?.focus()
  helpOpener = null
}
document.getElementById('title-help-btn')!.addEventListener('click', openHelp)
document.getElementById('game-help-btn')!.addEventListener('click', openHelp)
document.getElementById('help-modal-close')!.addEventListener('click', closeHelp)
document.getElementById('help-modal-ok')!.addEventListener('click', closeHelp)
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp() })
helpModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeHelp(); return }
  if (e.key !== 'Tab') return
  const focusable = helpModal.querySelectorAll<HTMLElement>('button, [tabindex]')
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
})

// ── Help controls table — built from current key bindings ──────────────────
const helpKeysTable = document.getElementById('help-keys-table') as HTMLTableElement

/** Grouped rows that merge related actions (e.g. left+right → "Move left / right") */
const HELP_ROWS: { actions: ActionKey[]; label: string; merge?: boolean }[] = [
  { actions: ['left', 'right'], label: 'Move left / right', merge: true },
  { actions: ['up', 'down'],   label: 'Climb ladders',      merge: true },
  { actions: ['jump'],         label: 'Jump' },
  { actions: ['attack'],       label: 'Throw yoyo' },
  { actions: ['map'],          label: 'Toggle map view' },
  { actions: ['jumpZoom'],     label: 'Toggle jump zoom' },
  { actions: ['musicToggle'],  label: 'Toggle music' },
]

const refreshHelpKeysTable = () => {
  helpKeysTable.innerHTML = ''
  for (const row of HELP_ROWS) {
    const tr = document.createElement('tr')
    const tdKeys = document.createElement('td')
    tdKeys.className = 'help-key-col'
    if (row.merge && row.actions.length === 2) {
      const k1 = keyBindings[row.actions[0]].map(keyCodeLabel).map(l => `<kbd>${escHtml(l)}</kbd>`).join(' ')
      const k2 = keyBindings[row.actions[1]].map(keyCodeLabel).map(l => `<kbd>${escHtml(l)}</kbd>`).join(' ')
      tdKeys.innerHTML = `${k1} &nbsp;/&nbsp; ${k2}`
    } else {
      tdKeys.innerHTML = keyBindings[row.actions[0]].map(keyCodeLabel).map(l => `<kbd>${escHtml(l)}</kbd>`).join(' &nbsp;/&nbsp; ')
    }
    const tdLabel = document.createElement('td')
    tdLabel.textContent = row.label
    tr.appendChild(tdKeys)
    tr.appendChild(tdLabel)
    helpKeysTable.appendChild(tr)
  }
  // Update inline map-key reference in tips
  const mapKeyEl = document.getElementById('help-map-key')
  if (mapKeyEl) mapKeyEl.textContent = keyBindings.map.map(keyCodeLabel).join(' / ')
}
refreshHelpKeysTable()

// ── Key remap dialog ───────────────────────────────────────────────────────
const remapModal = document.getElementById('remap-modal') as HTMLDivElement
const remapTable = document.getElementById('remap-table') as HTMLTableElement
let remapListeningAction: ActionKey | null = null
let remapKeyHandler: ((ev: KeyboardEvent) => void) | null = null

const REMAP_ACTIONS: ActionKey[] = ['left', 'right', 'up', 'down', 'jump', 'attack', 'map', 'jumpZoom', 'musicToggle']

const stopListening = () => {
  if (remapKeyHandler) {
    window.removeEventListener('keydown', remapKeyHandler, true)
    remapKeyHandler = null
  }
  remapListeningAction = null
  // Remove listening class from all buttons
  remapTable.querySelectorAll('.remap-add-btn.listening').forEach(b => b.classList.remove('listening'))
}

const refreshRemapTable = () => {
  stopListening()
  remapTable.innerHTML = ''
  for (const action of REMAP_ACTIONS) {
    const tr = document.createElement('tr')
    const tdAction = document.createElement('td')
    tdAction.className = 'remap-action-col'
    tdAction.textContent = ACTION_LABELS[action]

    const tdKeys = document.createElement('td')
    tdKeys.className = 'remap-keys-col'
    for (const code of keyBindings[action]) {
      const tag = document.createElement('span')
      tag.className = 'remap-key-tag'
      tag.innerHTML = `${escHtml(keyCodeLabel(code))}<span class="remap-key-remove" title="Remove">&times;</span>`
      tag.querySelector('.remap-key-remove')!.addEventListener('click', () => {
        if (keyBindings[action].length <= 1) return // must keep at least one
        keyBindings[action] = keyBindings[action].filter(c => c !== code)
        saveKeyBindings()
        rebuildKeyMap()
        refreshRemapTable()
      })
      tdKeys.appendChild(tag)
    }

    const tdBtn = document.createElement('td')
    tdBtn.className = 'remap-btn-col'
    const addBtn = document.createElement('button')
    addBtn.className = 'remap-add-btn'
    addBtn.textContent = '+ Key'
    addBtn.addEventListener('click', () => {
      stopListening()
      remapListeningAction = action
      addBtn.classList.add('listening')
      addBtn.textContent = 'Press key…'
      remapKeyHandler = (ev: KeyboardEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
        if (ev.code === 'Escape') { stopListening(); refreshRemapTable(); return }
        // Don't allow duplicate within same action
        if (!keyBindings[action].includes(ev.code)) {
          // Remove this code from any other action that has it
          for (const a of REMAP_ACTIONS) {
            if (a !== action) {
              keyBindings[a] = keyBindings[a].filter(c => c !== ev.code)
              // If we emptied another action, skip removal (keep at least 1)
              if (keyBindings[a].length === 0) {
                keyBindings[a] = [ev.code] // will be overwritten below
              }
            }
          }
          keyBindings[action].push(ev.code)
        }
        saveKeyBindings()
        rebuildKeyMap()
        stopListening()
        refreshRemapTable()
      }
      window.addEventListener('keydown', remapKeyHandler, true)
    })
    tdBtn.appendChild(addBtn)

    tr.appendChild(tdAction)
    tr.appendChild(tdKeys)
    tr.appendChild(tdBtn)
    remapTable.appendChild(tr)
  }
}

const openRemapDialog = () => {
  refreshRemapTable()
  remapModal.style.display = 'flex'
  ;(document.getElementById('remap-modal-close') as HTMLElement).focus()
}

const closeRemapDialog = () => {
  stopListening()
  remapModal.style.display = 'none'
  refreshHelpKeysTable()
}

document.getElementById('help-remap-btn')!.addEventListener('click', () => {
  closeHelp()
  openRemapDialog()
})
document.getElementById('remap-modal-close')!.addEventListener('click', closeRemapDialog)
document.getElementById('remap-done')!.addEventListener('click', closeRemapDialog)
document.getElementById('remap-reset')!.addEventListener('click', () => {
  keyBindings = { ...DEFAULT_KEY_BINDINGS }
  // Deep copy the arrays
  for (const k of Object.keys(keyBindings) as ActionKey[]) keyBindings[k] = [...DEFAULT_KEY_BINDINGS[k]]
  saveKeyBindings()
  rebuildKeyMap()
  refreshRemapTable()
})
remapModal.addEventListener('click', (e) => { if (e.target === remapModal) closeRemapDialog() })
remapModal.addEventListener('keydown', (e) => {
  if (remapListeningAction) return // don't intercept when listening for a key
  if (e.key === 'Escape') { closeRemapDialog(); return }
  if (e.key !== 'Tab') return
  const focusable = remapModal.querySelectorAll<HTMLElement>('button, [tabindex]')
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
})

const tick = (now: number) => {
  const dt = Math.min((now - lastTime) / 1000, 0.033)
  lastTime = now
  const elapsed = now / 1000

  updateGame(dt, elapsed)

  const moveSpeed = Math.abs(player.vx)
  const walkBlend = THREE.MathUtils.clamp(moveSpeed / movementConfig.runSpeed, 0, 1)
  const walking = player.grounded && !player.climbing && walkBlend > 0.08
  walkAnimTime += dt * (0.15 + walkBlend * 0.85)
  if (player.climbing) {
    climbAnimDist += Math.abs(player.vy) * dt
  }

  let nextVisual: PlayerVisualState = 'idle'
  if (player.dead) nextVisual = 'death'
  else if (yoyoReach > 0 || yoyoReturning) nextVisual = 'attack'
  else if (player.climbing) nextVisual = 'climb'
  else if (!player.grounded) nextVisual = 'jump'
  else if (walking) nextVisual = 'walkA'

  // Bored idle sequence: ≥10s idle → wave×2 → sit; any action while sit → standUp first
  if (boredPhase === 'standUp') {
    // Block all other visuals until the get-up animation finishes
    nextVisual = 'standUp'
  } else if (nextVisual === 'idle') {
    idleBoredTimer += dt
    if (boredPhase === 'none' && idleBoredTimer >= 10) {
      boredPhase = 'wave'
    }
    if (boredPhase === 'wave') nextVisual = 'wave'
    else if (boredPhase === 'sit') nextVisual = 'sit'
  } else if (boredPhase === 'sit') {
    // Any action (move, jump, attack, climb) while sitting → stand up first, then act
    boredPhase = 'standUp'
    currentPlayerVisual = 'standUp'
    currentPlayerFrame = -1
    playerVisualTime = 0
    nextVisual = 'standUp'
  } else {
    // Any physical action breaks out of bored mode
    idleBoredTimer = 0
    boredPhase = 'none'
  }

  if (nextVisual !== currentPlayerVisual) {
    currentPlayerVisual = nextVisual
    currentPlayerFrame = -1
    playerVisualTime = 0
  }

  playerVisualTime += dt

  // Animation FPS is now data-driven from sprite.json via troggFps()

  // Advance bored phase when the current phase animation has completed
  if (boredPhase === 'wave') {
    const waveN = troggPlayerFrames.wave?.length ?? 25
    if (Math.floor(playerVisualTime * troggFps('wave')) >= waveN * 2) {
      boredPhase = 'sit'
      currentPlayerVisual = 'sit'
      currentPlayerFrame = -1
      playerVisualTime = 0
    }
  } else if (boredPhase === 'standUp') {
    if (playerVisualTime >= 9 / troggFps('standUp')) {
      boredPhase = 'none'
      idleBoredTimer = 0
    }
  }

  const stateFrames = troggPlayerFrames[currentPlayerVisual]
  if (stateFrames && stateFrames.length > 0) {
    let frame: number
    if (currentPlayerVisual === 'death') {
      const deathTick = Math.min(stateFrames.length - 1, Math.floor(playerVisualTime * troggFps(currentPlayerVisual)))
      frame = deathTick
      // Show speech bubble on the final held frame
      if (deathTick >= stateFrames.length - 1) {
        frakBubbleMesh.visible = true
        const headY = player.y + playerVisualYOffset - player.h * currentPlayerScale * 0.3
        const bubbleX = player.x + player.facing * (player.w * 0.3 + frakBubbleW * 0.5)
        frakBubbleMesh.position.set(bubbleX, headY + frakBubbleH, renderBands.player.z + 0.01)
      }
    } else if (currentPlayerVisual === 'attack') {
      // Drive arm frame directly from yoyo reach fraction so the animation
      // stays perfectly synced with the disc position.
      const yoyoMaxReachLocal = player.h * 3.0
      const reachFracLocal = yoyoMaxReachLocal > 0 ? THREE.MathUtils.clamp(yoyoReach / yoyoMaxReachLocal, 0, 1) : 0
      const throwFrames = troggAttackThrowSeq.filter(f => f < stateFrames.length)
      if (throwFrames.length > 0) {
        // reachFrac 0→1 maps through throwSeq (frames 24→15: arm up → thrown)
        // reachFrac 1→0 naturally reverses (frames 15→24: thrown → arm up)
        const seqIdx = Math.round(reachFracLocal * (throwFrames.length - 1))
        frame = throwFrames[Math.min(seqIdx, throwFrames.length - 1)]
      } else {
        frame = 0
      }
    } else if (currentPlayerVisual === 'walkA') {
      // Drive walk frame from walkAnimTime (which is already speed-scaled) so
      // the animation pace exactly matches the character's movement speed.
      frame = Math.floor(walkAnimTime * troggFps(currentPlayerVisual)) % stateFrames.length
    } else if (currentPlayerVisual === 'idle') {
      frame = pingPongFrame(Math.floor(playerVisualTime * troggFps('idle')), stateFrames.length)
    } else if (currentPlayerVisual === 'wave') {
      // Simple forward loop
      frame = Math.floor(playerVisualTime * troggFps('wave')) % stateFrames.length
    } else if (currentPlayerVisual === 'sit') {
      // Play frames 17→25 (indices 16→24) once, hold at 24 until player moves
      frame = Math.min(24, 16 + Math.floor(playerVisualTime * troggFps('sit')))
    } else if (currentPlayerVisual === 'standUp') {
      // Play sit sheet frames 24→16 once (1-indexed 25→17), then resume normal
      const tick = Math.floor(playerVisualTime * troggFps('standUp'))
      frame = Math.max(16, 24 - tick)
    } else if (currentPlayerVisual === 'climb') {
      // Advance one frame per ~0.15 world units of vertical movement
      const unitsPerFrame = 0.15
      frame = Math.floor(climbAnimDist / unitsPerFrame) % stateFrames.length
    } else {
      frame = Math.floor(playerVisualTime * troggFps(currentPlayerVisual)) % stateFrames.length
    }
    if (frame !== currentPlayerFrame) {
      playerMesh.material = stateFrames[frame]
      currentPlayerFrame = frame
    }
  } else {
    const fallback: Record<PlayerVisualState, THREE.MeshBasicMaterial> = {
      idle: playerSpriteMaterials.idle,
      walkA: playerSpriteMaterials.walkA,
      jump: playerSpriteMaterials.jump,
      climb: playerSpriteMaterials.idle,
      attack: playerSpriteMaterials.walkA,
      death: playerSpriteMaterials.jump,
      wave: playerSpriteMaterials.idle,
      sit: playerSpriteMaterials.idle,
      standUp: playerSpriteMaterials.idle,
    }
    if (currentPlayerFrame !== 0) {
      playerMesh.material = fallback[currentPlayerVisual]
      currentPlayerFrame = 0
    }
  }

  const walkBob = player.grounded ? Math.sin(walkAnimTime * Math.PI * 2) * (0.01 + walkBlend * 0.045) : 0
  const tiltTarget = player.climbing ? 0 : THREE.MathUtils.clamp(player.vx * 0.015, -0.11, 0.11)
  playerMesh.rotation.z = THREE.MathUtils.lerp(playerMesh.rotation.z, tiltTarget, 1 - Math.exp(-10 * dt))

  // Always keep player in the transparent render queue so renderOrder
  // correctly places it in front of ladder tiles (which are also transparent).
  // Setting transparent=false here would move the player to the opaque queue
  // which renders BEFORE transparent objects — making the player appear
  // behind the ladder regardless of renderOrder.
  playerMesh.renderOrder = player.climbing ? 100 : renderBands.player.order
  playerMesh.position.set(player.x, player.y + playerVisualYOffset + walkBob, renderBands.player.z)

  // Always correct for the actual canvas aspect ratio vs the base mesh geometry
  // (player.w × player.h = 0.85 × 1.7 = aspect 0.5).  Each animation state
  // can have a different natural width after bottomAnchorFrames crops it, so
  // applying the correction universally keeps every state the right width.
  let frameAspectCorrection = 1
  const cvs = (playerMesh.material as THREE.MeshBasicMaterial).map?.image as HTMLCanvasElement | null
  if (cvs && cvs.width > 0 && cvs.height > 0) {
    frameAspectCorrection = (cvs.width / cvs.height) / (player.w / player.h)
  }
  playerMesh.scale.x = player.facing * frameAspectCorrection
  ;(playerMesh.material as THREE.MeshBasicMaterial).opacity = 1

  updateCamera(dt)
  renderer.render(scene, camera)

  requestAnimationFrame(tick)
}

requestAnimationFrame(tick)
