import { defineConfig } from 'vite'
import { writeFile, mkdir, readdir, readFile, stat, unlink } from 'fs/promises'
import { join, relative, normalize, extname } from 'path'

// Dev-only plugin: saves level JSON files to public/levels/ via POST requests
// and maintains an index.json manifest for level discovery.
function saveLevelPlugin() {
  const levelsDir = join(process.cwd(), 'public', 'levels')

  async function rebuildIndex() {
    await mkdir(levelsDir, { recursive: true })
    const files = (await readdir(levelsDir)).filter(f => f.endsWith('.json') && f !== 'index.json').sort()
    await writeFile(join(levelsDir, 'index.json'), JSON.stringify(files), 'utf-8')
  }

  return {
    name: 'save-level',
    configureServer(server: { middlewares: { use: Function } }) {
      // Rebuild index on server start so it reflects any manually added files
      rebuildIndex().catch(() => {})

      server.middlewares.use(async (req: any, res: any, next: Function) => {
        // Serve level index
        if (req.url === '/__level_index' && req.method === 'GET') {
          try {
            await rebuildIndex()
            const files = (await readdir(levelsDir)).filter(f => f.endsWith('.json') && f !== 'index.json').sort()
            res.setHeader('Content-Type', 'application/json')
            res.statusCode = 200
            res.end(JSON.stringify(files))
          } catch {
            res.statusCode = 200
            res.end('[]')
          }
          return
        }

        // Save level file
        const match = req.url?.match(/^\/__save_level\/([a-zA-Z0-9_-]+\.json)$/)
        if (!match || req.method !== 'POST') return next()

        const filename = match[1]
        // Validate filename to prevent path traversal
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(filename)) {
          res.statusCode = 400
          res.end('Invalid filename')
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks).toString('utf-8')

        // Validate it's valid JSON before writing
        try {
          JSON.parse(body)
        } catch {
          res.statusCode = 400
          res.end('Invalid JSON')
          return
        }

        await mkdir(levelsDir, { recursive: true })
        await writeFile(join(levelsDir, filename), body, 'utf-8')
        await rebuildIndex()

        res.statusCode = 200
        res.end('OK')
      })
    },
  }
}

// Dev-only plugin: saves sprite.json overrides to public/sprites/ and serves
// a listing of all overridden sprites for the sprite editor.
function saveSpritePlugin() {
  const spritesDir = join(process.cwd(), 'public', 'sprites')

  // Recursively collect all sprite.json paths relative to spritesDir
  async function listSpriteJsons(dir: string, base: string): Promise<string[]> {
    const out: string[] = []
    let entries: string[]
    try { entries = await readdir(dir) } catch { return out }
    for (const e of entries) {
      const full = join(dir, e)
      const s = await stat(full).catch(() => null)
      if (!s) continue
      if (s.isDirectory()) out.push(...await listSpriteJsons(full, base))
      else if (e === 'sprite.json') out.push(relative(base, full).replace(/\\/g, '/'))
    }
    return out
  }

  return {
    name: 'save-sprite',
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use(async (req: any, res: any, next: Function) => {
        // List all sprite.json overrides in public/sprites/
        if (req.url === '/__sprite_index' && req.method === 'GET') {
          const files = await listSpriteJsons(spritesDir, spritesDir)
          res.setHeader('Content-Type', 'application/json')
          res.statusCode = 200
          res.end(JSON.stringify(files))
          return
        }

        // Read a sprite.json override: GET /__read_sprite/<path>
        const readMatch = req.url?.match(/^\/__read_sprite\/(.+)$/)
        if (readMatch && req.method === 'GET') {
          const reqPath = decodeURIComponent(readMatch[1])
          // Validate: must end with sprite.json and not escape spritesDir
          const resolved = normalize(join(spritesDir, reqPath))
          if (!resolved.startsWith(spritesDir) || !resolved.endsWith('sprite.json')) {
            res.statusCode = 400; res.end('Invalid path'); return
          }
          try {
            const data = await readFile(resolved, 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.statusCode = 200; res.end(data)
          } catch {
            res.statusCode = 404; res.end('Not found')
          }
          return
        }

        // Save a sprite.json override: POST /__save_sprite/<path>
        const saveMatch = req.url?.match(/^\/__save_sprite\/(.+)$/)
        if (saveMatch && req.method === 'POST') {
          const reqPath = decodeURIComponent(saveMatch[1])
          const resolved = normalize(join(spritesDir, reqPath))
          if (!resolved.startsWith(spritesDir) || !resolved.endsWith('sprite.json')) {
            res.statusCode = 400; res.end('Invalid path'); return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk)
          const body = Buffer.concat(chunks).toString('utf-8')
          try { JSON.parse(body) } catch { res.statusCode = 400; res.end('Invalid JSON'); return }
          await mkdir(join(resolved, '..'), { recursive: true })
          await writeFile(resolved, body, 'utf-8')
          res.statusCode = 200; res.end('OK')
          return
        }

        return next()
      })
    },
  }
}

// Dev-only plugin: saves/lists/deletes custom background images and music files
// in public/background/ and public/music/ (mirroring src/assets/ structure).
function saveAssetPlugin() {
  const publicDir = join(process.cwd(), 'public')

  // Allowed asset folders and their accepted extensions
  const ASSET_TYPES: Record<string, { dir: string; exts: string[] }> = {
    background: { dir: join(publicDir, 'background'), exts: ['.png', '.jpg', '.jpeg', '.webp'] },
    music:      { dir: join(publicDir, 'music'),      exts: ['.mp3', '.ogg', '.vgz'] },
  }

  return {
    name: 'save-asset',
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use(async (req: any, res: any, next: Function) => {
        // List files: GET /__asset_list/<type>
        const listMatch = req.url?.match(/^\/__asset_list\/(background|music)$/)
        if (listMatch && req.method === 'GET') {
          const cfg = ASSET_TYPES[listMatch[1]]
          try {
            await mkdir(cfg.dir, { recursive: true })
            const files = (await readdir(cfg.dir))
              .filter(f => cfg.exts.includes(extname(f).toLowerCase()))
              .sort()
            res.setHeader('Content-Type', 'application/json')
            res.statusCode = 200
            res.end(JSON.stringify(files))
          } catch {
            res.statusCode = 200
            res.end('[]')
          }
          return
        }

        // Save file: POST /__asset_save/<type>/<filename>
        const saveMatch = req.url?.match(/^\/__asset_save\/(background|music)\/([a-zA-Z0-9_.-]+)$/)
        if (saveMatch && req.method === 'POST') {
          const cfg = ASSET_TYPES[saveMatch[1]]
          const filename = saveMatch[2]
          const ext = extname(filename).toLowerCase()
          if (!cfg.exts.includes(ext)) {
            res.statusCode = 400; res.end('Invalid file type'); return
          }
          if (filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
            res.statusCode = 400; res.end('Invalid filename'); return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk)
          const body = Buffer.concat(chunks)
          await mkdir(cfg.dir, { recursive: true })
          await writeFile(join(cfg.dir, filename), body)
          res.statusCode = 200; res.end('OK')
          return
        }

        // Delete file: DELETE /__asset_delete/<type>/<filename>
        const delMatch = req.url?.match(/^\/__asset_delete\/(background|music)\/([a-zA-Z0-9_.-]+)$/)
        if (delMatch && req.method === 'DELETE') {
          const cfg = ASSET_TYPES[delMatch[1]]
          const filename = delMatch[2]
          if (filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
            res.statusCode = 400; res.end('Invalid filename'); return
          }
          const resolved = normalize(join(cfg.dir, filename))
          if (!resolved.startsWith(cfg.dir)) {
            res.statusCode = 400; res.end('Invalid path'); return
          }
          try {
            await unlink(resolved)
            res.statusCode = 200; res.end('OK')
          } catch {
            res.statusCode = 404; res.end('Not found')
          }
          return
        }

        return next()
      })
    },
  }
}

export default defineConfig({
  plugins: [saveLevelPlugin(), saveSpritePlugin(), saveAssetPlugin()],
  assetsInclude: ['**/*.vgz'],
  server: {
    allowedHosts: [
      '*'
    ]
  } 
})
