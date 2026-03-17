# Frak!

A reimagining of the classic BBC Micro platformer **Frak!** (1984), built with Three.js, TypeScript, and Vite.

Guide **Trogg** the caveman through treacherous platforms, dodge hazards, and use your trusty **yoyo** to defeat enemies — Scrubblies, Hooters, and Poglets — while collecting all the keys to complete each level.

## Features

- **3 campaign levels** with distinct themes and sprite sets
- **Chiptune music** — authentic SN76489 PSG emulation (VGM/VGZ playback) with MP3 remaster option
- **Built-in level editor** — drag-and-drop element placement, resize, attribute editing, dry-run testing, import/export
- **Built-in sprite editor** — spritesheet import, frame reordering, animation preview, scale/FPS tuning
- **Remappable controls** — customise keyboard bindings with persistent localStorage save
- **Touch controls** — on-screen buttons for mobile/tablet play
- **Data-driven sprites** — all scaling and animation FPS configured via `sprite.json` files, no hardcoded multipliers
- **Custom level/sprite support** — save and load overrides from `public/` during development

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ (22 recommended)
- npm (included with Node.js)

### Install & Run

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```bash
npm run build
npm run preview
```

## Docker

### Using Docker Compose (recommended)

```bash
docker compose up
```

Opens the dev server at [http://localhost:5173](http://localhost:5173) with hot-reload and full editor support. Source files are mounted as volumes so edits on the host are reflected immediately.

### Using Docker directly

```bash
docker build -t frak .
docker run -p 5173:5173 frak
```

## Controls

| Action          | Default Keys          |
| --------------- | --------------------- |
| Move left/right | Arrow keys / A, D     |
| Climb up/down   | Arrow keys / W, S     |
| Jump            | Space                 |
| Throw yoyo      | X / Enter             |
| Toggle map      | M                     |
| Toggle zoom     | Z                     |
| Toggle music    | N                     |

Controls can be remapped from the in-game help screen (press **?**).

## Project Structure

```
src/
├── main.ts            # Game engine, physics, rendering, UI
├── level-editor.ts    # 2D level authoring tool
├── sprite-editor.ts   # Sprite authoring and import tool
├── vgm-player.ts      # SN76489 PSG chiptune emulator
├── custom-sprites.ts  # Custom sprite types & localStorage helpers
├── sprite-data.ts     # Centralised Vite glob imports
├── style.css          # UI styling
└── assets/
    ├── sprites/       # Character, enemy, item, platform sprites
    ├── levels/        # Built-in level JSON data
    ├── background/    # Level background images
    ├── music/         # VGZ chiptune + MP3 tracks
    ├── sfx/           # Sound effects
    └── title/         # Title screen backgrounds
```

## Tech Stack

- **[Three.js](https://threejs.org/)** — 2.5D rendering with OrthographicCamera
- **[TypeScript](https://www.typescriptlang.org/)** — strict mode, no unused locals/params
- **[Vite](https://vite.dev/)** — dev server with custom plugins for level/sprite persistence
- **[JSZip](https://stuk.github.io/jszip/)** — level and sprite export/import

## Level & Sprite Editing

Launch the **Level Editor** or **Sprite Editor** from the title screen. The dev server includes save plugins that persist changes to `public/levels/` and `public/sprites/` — these override the bundled assets at runtime.

Press **F1** in the level editor for keyboard shortcuts. Use the **Dry Run** button to test-play your level without leaving the editor.

## Licence

Private project — not currently published under an open-source licence.
