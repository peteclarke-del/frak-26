"""
extract_sprites.py — Extract all animation frames from every sprite sheet.

Outputs RGBA PNGs trimmed to content + margin, scaled so that the sprite's height
matches its game-visual height (hitbox_h × sprite_visual_scale × WORLD_PPU).
Each character/action gets a subdirectory with numbered PNGs and a sprite.json.

The sprite.json is merged non-destructively: extraction metadata fields
(kind, action, visual_w, visual_h, fps, frameCount) are written/updated,
while existing editor fields (role, group, behavior, defaultSize, color,
editableAttrs, etc.) are preserved untouched.

Also writes flat first-frame PNGs (used by the level editor) directly in DEST.

Usage:
    python3 scripts/extract_sprites.py
"""

import json, os
from PIL import Image

ROOT  = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
SRC   = os.path.join(ROOT, 'src', 'assets', 'sprite_sheets')
# Some single-image "sheets" are stored directly in the sprites output folder
SRC2  = os.path.join(ROOT, 'src', 'assets', 'sprites')
DEST  = os.path.join(ROOT, 'src', 'assets', 'sprites')
MARGIN = 2       # px of transparent edge to keep around content bbox
WORLD_PPU = 128  # output pixels per game-world unit

os.makedirs(DEST, exist_ok=True)

# ── Visual-scale constants (mirrors main.ts) ──────────────────────────────────
SPRITE_VISUAL_SCALE  = 1.875
PLAYER_SPRITE_SCALE  = SPRITE_VISUAL_SCALE * 0.9   # 1.6875
MONSTER_SPRITE_SCALE = SPRITE_VISUAL_SCALE * 1.2   # 2.25
ITEM_SPRITE_SCALE    = SPRITE_VISUAL_SCALE * 0.5   # 0.9375  (key/bulb/diamond)

# ── Per-character spec ────────────────────────────────────────────────────────
# hitbox_w, hitbox_h come from level data / player.w & player.h in main.ts
# visual_scale is the mesh.scale factor applied in main.ts
CHAR_SPEC = {
    'trogg':   {'hitbox': (1.20, 1.10), 'scale': MONSTER_SPRITE_SCALE},
    'scrubbly':{'hitbox': (0.85, 1.70), 'scale': PLAYER_SPRITE_SCALE},
    'hooter':  {'hitbox': (1.20, 2.00), 'scale': SPRITE_VISUAL_SCALE},
    'poglet':  {'hitbox': (1.20, 1.20), 'scale': SPRITE_VISUAL_SCALE},
    'key':     {'hitbox': (0.90, 0.90), 'scale': ITEM_SPRITE_SCALE},
    'bulb':    {'hitbox': (0.90, 0.90), 'scale': ITEM_SPRITE_SCALE},
    'diamond': {'hitbox': (0.80, 0.80), 'scale': ITEM_SPRITE_SCALE},
    'balloon': {'hitbox': (0.80, 0.80), 'scale': SPRITE_VISUAL_SCALE},
    'dagger':  {'hitbox': (0.60, 0.60), 'scale': SPRITE_VISUAL_SCALE},
    'scrubbly_death': {'hitbox': (0.85, 1.70), 'scale': PLAYER_SPRITE_SCALE},
    # Terrain — no visual scale multiplier; 1 earth tile = 1×1 wu
    'earth':   {'hitbox': (1.00, 1.00), 'scale': 1.0},
    'ladder':  {'hitbox': (1.20, 2.20), 'scale': 1.0},
}

# ── Kind mapping (extraction char name → sprite.json "kind" field) ────────────
# Most map directly; override only where they differ.
KIND_MAP = {
    'trogg': 'player',
    'scrubbly': 'monster',
    'hooter': 'hooter',
    'poglet': 'poglet',
    'key': 'key',
    'bulb': 'bulb',
    'diamond': 'diamond',
    'balloon': 'balloon',
    'dagger': 'dagger',
    'scrubbly_death': 'scrubbly_death',
    'earth': 'earth',
    'ladder': 'ladder',
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def trim_frame(img: Image.Image) -> Image.Image:
    """Trim to non-transparent content + MARGIN."""
    alpha = img.split()[3]
    bbox  = alpha.getbbox()
    if bbox is None:
        return img
    l = max(0,         bbox[0] - MARGIN)
    t = max(0,         bbox[1] - MARGIN)
    r = min(img.width, bbox[2] + MARGIN)
    b = min(img.height,bbox[3] + MARGIN)
    return img.crop((l, t, r, b))


def scale_to_height(img: Image.Image, target_h: int) -> Image.Image:
    """Uniformly scale so height == target_h (maintain aspect ratio)."""
    if img.height == 0 or target_h <= 0:
        return img
    scale = target_h / img.height
    new_w = max(1, round(img.width  * scale))
    return img.resize((new_w, target_h), Image.LANCZOS)


def extract_cells(sheet: Image.Image,
                  cells: list[tuple[int,int,int,int]]) -> list[Image.Image]:
    """Crop each (x,y,w,h) cell from sheet, normalize all frames to a common
    bounding box so every frame has identical dimensions with aligned content."""
    raw_frames: list[Image.Image] = []
    content_bboxes: list[tuple[int,int,int,int] | None] = []
    for (cx, cy, cw, ch) in cells:
        cell = sheet.crop((cx, cy, cx+cw, cy+ch)).convert('RGBA')
        raw_frames.append(cell)
        content_bboxes.append(cell.split()[3].getbbox())

    # Compute the union bounding box across all frames (relative to cell origin)
    ul, ut, ur, ub = 999999, 999999, 0, 0
    has_content = False
    for bbox in content_bboxes:
        if bbox is None:
            continue
        has_content = True
        ul = min(ul, bbox[0])
        ut = min(ut, bbox[1])
        ur = max(ur, bbox[2])
        ub = max(ub, bbox[3])

    if not has_content:
        return []

    # Apply margin to the union bbox
    ul = max(0, ul - MARGIN)
    ut = max(0, ut - MARGIN)
    ur = ur + MARGIN
    ub = ub + MARGIN
    common_w = ur - ul
    common_h = ub - ut

    out: list[Image.Image] = []
    for i, cell in enumerate(raw_frames):
        if content_bboxes[i] is None:
            continue  # skip fully-transparent frames
        # Crop what we can from the cell
        crop_r = min(cell.width, ur)
        crop_b = min(cell.height, ub)
        cropped = cell.crop((ul, ut, crop_r, crop_b))
        # Paste into a uniform-size canvas so all frames are identical dimensions
        canvas = Image.new('RGBA', (common_w, common_h), (0, 0, 0, 0))
        canvas.paste(cropped, (0, 0))
        out.append(canvas)
    return out


def uniform_grid_cells(cols: int, rows: int,
                       sheet_w: int, sheet_h: int,
                       count: int | None = None) -> list[tuple[int,int,int,int]]:
    cw = sheet_w // cols
    ch = sheet_h // rows
    cells = [(c*cw, r*ch, cw, ch) for r in range(rows) for c in range(cols)]
    return cells[:count] if count else cells


def save_frames(frames: list[Image.Image], subdir: str,
                char: str, target_h: int) -> list[str]:
    """Scale + save frames; return list of paths relative to DEST."""
    os.makedirs(subdir, exist_ok=True)
    paths = []
    for i, f in enumerate(frames):
        scaled = scale_to_height(f, target_h)
        fname  = f'{i:03d}.png'
        fpath  = os.path.join(subdir, fname)
        scaled.save(fpath, 'PNG')
        paths.append(os.path.relpath(fpath, DEST))
    return paths


def write_sprite_json(subdir: str, char: str, anim_name: str,
                      visual_w: float, visual_h: float,
                      fps: int, frame_count: int) -> None:
    """Write or merge a sprite.json in the given directory.

    Extraction metadata (kind, action, visual_w, visual_h, fps, frameCount)
    is always written.  Existing editor-specific fields (role, group, behavior,
    defaultSize, color, editableAttrs, tiling, animMode, spriteScale) are
    preserved when the file already exists.
    """
    json_path = os.path.join(subdir, 'sprite.json')
    existing: dict = {}
    if os.path.exists(json_path):
        try:
            with open(json_path) as fh:
                existing = json.load(fh)
        except (json.JSONDecodeError, OSError):
            existing = {}

    # Extraction metadata — always overwritten
    existing['kind'] = KIND_MAP.get(char, char)
    if anim_name:
        existing['action'] = anim_name
    existing['visual_w'] = visual_w
    existing['visual_h'] = visual_h
    existing['fps'] = fps
    existing['frameCount'] = frame_count

    with open(json_path, 'w') as fh:
        json.dump(existing, fh, indent=2, ensure_ascii=False)
        fh.write('\n')


# ── Animation definitions (cell layout mirrors main.ts imageLoader calls) ─────

def cells_5x5(w=1280, h=1280):
    return uniform_grid_cells(5, 5, w, h)

def cells_trogg_walk():
    cols = [(63,117),(325,118),(575,120),(831,122),(1091,118)]
    rows = [(7,242),(263,241),(519,242),(774,243),(1031,241)]
    return [(cx,ry, cw,rh) for ry,rh in rows for cx,cw in cols]

def cells_trogg_jump():
    cols = [(60,126),(313,127),(573,129),(826,133),(1082,130)]
    rows = [(18,230),(265,239),(519,241),(779,237),(1034,238)]
    return [(cx,ry, cw,rh) for ry,rh in rows for cx,cw in cols]

def cells_hooter_stand():      # 5×4 grid on 1280×1024, 19 valid frames
    return uniform_grid_cells(5, 4, 1280, 1024, count=19)

def cells_poglet():
    # Irregular row heights; 5 cols × 5 rows = 25 frames; skip empty cells
    row_defs = [(0,163),(163,160),(323,161),(485,141),(626,142)]
    col_w = 275
    out = []
    for ry, rh in row_defs:
        for c in range(5):
            cx = c * col_w
            cw = 1376 - cx if c == 4 else col_w
            out.append((cx, ry, cw, rh))
    return out

def cells_single(img: Image.Image) -> list[tuple[int,int,int,int]]:
    """Treat the whole image as one frame."""
    return [(0, 0, img.width, img.height)]

def cells_balloon():
    # balloon.png: 160×169, 2 columns × 1 row
    return uniform_grid_cells(2, 1, 160, 169)

def cells_dagger():
    # dagger.png: 250×162, 3 content columns detected by gap analysis
    # Col 0: x=2-50, Col 1: x=81-154, Col 2: x=168-244
    return [(2, 0, 49, 162), (81, 0, 74, 162), (168, 0, 77, 162)]

def cells_scrubbly_death():
    # scrubbly_death.png: 771×1120, auto-detect rows (band 0: y=7-38, band 1: y=54-1119)
    # Treat as 2 cells (row bands)
    return [(0, 0, 771, 53), (0, 54, 771, 1066)]

# char → list of (anim_name, cells, fps)
ANIMATIONS: dict[str, list[tuple[str, list, int]]] = {
    'trogg': [
        ('idle',   cells_5x5(),           10),
        ('walk',   cells_trogg_walk(),     12),
        ('jump',   cells_trogg_jump(),     12),
        ('climb',  cells_5x5(),            10),
        ('yoyo',   cells_5x5(),            12),
        ('wave',   cells_5x5(),            10),
        ('sit',    cells_5x5(),             8),
        ('death',  cells_5x5(),             8),
    ],
    'scrubbly': [
        ('idle',   cells_5x5(),            10),
    ],
    'hooter': [
        ('stand',  cells_hooter_stand(),   10),
        ('crouch', cells_5x5(),            10),
    ],
    'poglet': [
        ('idle',   cells_poglet(),         10),
    ],
    'key':     [('spin', cells_5x5(), 12)],
    'bulb':    [('spin', cells_5x5(), 10)],
    'diamond': [('spin', cells_5x5(), 12)],
    'balloon': [('float', cells_balloon(), 10)],
    'dagger':  [('throw', cells_dagger(), 1)],
    'scrubbly_death': [('death', cells_scrubbly_death(), 8)],
    # Terrain tiles — single images, no animation
    'earth':   [('tile', None, 1)],   # cells resolved at runtime from the image
    'ladder':  [('tile', None, 1)],
}

SHEET_FILES = {
    'trogg':   {
        'idle':   'trogg_standing.png',
        'walk':   'trogg_walking.png',
        'jump':   'trog_jump.png',
        'climb':  'trogg_climbing.png',
        'yoyo':   'trogg_yoyo.png',
        'wave':   'trogg_wave.png',
        'sit':    'trogg_sitting.png',
        'death':  'trogg_death.png',
    },
    'scrubbly': {'idle': 'scrubbly_standing.png'},
    'hooter':   {'stand': 'hooter_standing.png', 'crouch': 'hooter_crouch.png'},
    'poglet':   {'idle': 'poglet.png'},
    'key':      {'spin': 'key.png'},
    'bulb':     {'spin': 'bulb.png'},
    'diamond':  {'spin': 'diamond.png'},
    'balloon':  {'float': 'balloon.png'},
    'dagger':   {'throw': 'dagger.png'},
    'scrubbly_death': {'death': 'scrubbly_death.png'},
    # Terrain — sourced from SRC2 (sprites dir, already present)
    'earth':    {'tile': 'earth.png'},
    'ladder':   {'tile': 'ladder.png'},
}

# ── Main extraction loop ──────────────────────────────────────────────────────

print('Extracting sprites …')

for char, anims in ANIMATIONS.items():
    spec     = CHAR_SPEC[char]
    vw       = round(spec['hitbox'][0] * spec['scale'], 4)
    vh       = round(spec['hitbox'][1] * spec['scale'], 4)
    target_h = max(16, round(vh * WORLD_PPU))

    first_frame_path = None

    for anim_name, cells, fps in anims:
        sheet_file = SHEET_FILES[char].get(anim_name)
        if not sheet_file:
            continue
        # Look in SRC first, then SRC2 (sprites/ for single-image terrain tiles)
        sheet_path = os.path.join(SRC, sheet_file)
        if not os.path.exists(sheet_path):
            sheet_path = os.path.join(SRC2, sheet_file)
        if not os.path.exists(sheet_path):
            print(f'  [skip] {sheet_file} not found'); continue

        sheet  = Image.open(sheet_path).convert('RGBA')
        # For terrain tiles, cells=None means treat the whole image as one frame
        actual_cells = cells if cells is not None else cells_single(sheet)
        frames = extract_cells(sheet, actual_cells)
        if not frames:
            print(f'  [warn] {char}/{anim_name} — no frames'); continue

        subdir = os.path.join(DEST, char, anim_name)
        paths  = save_frames(frames, subdir, char, target_h)

        # Write / merge sprite.json for this action directory
        write_sprite_json(subdir, char, anim_name, vw, vh, fps, len(frames))

        if first_frame_path is None and paths:
            first_frame_path = os.path.join(DEST, paths[0])

        print(f'  {char}/{anim_name}: {len(frames)} frames @ {target_h}px tall'
              f'  ({vw:.3f} × {vh:.3f} wu)')

    # ── Write flat first-frame PNGs (for the level editor tile/ghost) ─────────
    if first_frame_path:
        dest_flat = os.path.join(DEST, f'{char}.png')
        try:
            Image.open(first_frame_path).save(dest_flat)
        except Exception as e:
            print(f'  [warn] flat copy failed for {char}: {e}')

# ── Terrain tiles (single static images) ─────────────────────────────────────
TERRAIN_TILES = [
    # name, file, hitbox_w, hitbox_h, fps
    ('earth',  'earth.png',  1.5, 1.0, 1),
    ('ladder', 'ladder.png', 1.2, 2.2, 1),
]

print('\nExtracting terrain tiles …')
for (name, sheet_file, htbox_w, htbox_h, fps) in TERRAIN_TILES:
    sheet_path = os.path.join(SRC, sheet_file)
    if not os.path.exists(sheet_path):
        print(f'  [skip] {sheet_file} not found')
        continue
    raw = Image.open(sheet_path).convert('RGBA')
    frame = trim_frame(raw)
    if frame.split()[3].getbbox() is None:
        print(f'  [warn] {name} — fully transparent after trim'); continue
    target_h = max(8, round(htbox_h * WORLD_PPU))
    scaled = scale_to_height(frame, target_h)
    vw = round(htbox_w, 4)
    vh = round(htbox_h, 4)
    subdir = os.path.join(DEST, name, 'tile')
    os.makedirs(subdir, exist_ok=True)
    fpath = os.path.join(subdir, '000.png')
    scaled.save(fpath, 'PNG')
    scaled.save(os.path.join(DEST, f'{name}.png'), 'PNG')
    write_sprite_json(subdir, name, 'tile', vw, vh, fps, 1)
    print(f'  {name}: 1 frame @ {target_h}px tall  ({vw:.3f} × {vh:.3f} wu)')

print('\nDone — sprite.json files written per action directory.')

