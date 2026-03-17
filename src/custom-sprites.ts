// ── Shared custom-sprite types & localStorage helpers ────────────────────────
// Used by both level-editor.ts and sprite-editor.ts.

export type AnimMode = 'loop' | 'pingpong' | 'once'

export type SpriteCategory = 'terrain' | 'characters' | 'items' | 'hazards' | 'obstacles'
export type ObstacleType = 'blocking' | 'dangerous'

export type TilingMode = 'none' | 'h' | 'v'
export type SnapUnit = 'free' | 'tile'

export interface CustomSprite {
  id: string
  label: string
  icon: string
  iconFrame: number
  fill: string
  stroke: string
  hitboxW: number
  hitboxH: number
  fps: number
  animMode: AnimMode
  category: SpriteCategory
  obstacleType?: ObstacleType
  tiling?: TilingMode     // 'none' (default) | 'h' = tile horizontally | 'v' = tile vertically
  snapUnit?: SnapUnit     // 'free' (default, 0.25 grid) | 'tile' = snap to whole tile multiples
  frames: string[]  // data:image/png URLs
}

const LS_SPRITES_KEY = 'frak_custom_sprites'

export const loadCustomSprites = (): CustomSprite[] => {
  try {
    const s = localStorage.getItem(LS_SPRITES_KEY)
    if (!s) return []
    const arr = JSON.parse(s)
    if (!Array.isArray(arr)) return []
    for (const cs of arr as CustomSprite[]) {
      if (!cs.animMode) cs.animMode = 'loop'
      if (cs.iconFrame == null) cs.iconFrame = 0
    }
    return arr as CustomSprite[]
  } catch (e) { console.warn('[custom-sprites] Failed to load:', e); return [] }
}

export const saveCustomSprites = (sprites: CustomSprite[]) => {
  localStorage.setItem(LS_SPRITES_KEY, JSON.stringify(sprites))
}
