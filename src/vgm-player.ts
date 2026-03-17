// VGZ (gzip-compressed VGM) player for the Web Audio API.
// Supports the SN76489 PSG chip used in Frak! (BBC Micro).

const VGM_SAMPLE_RATE = 44100

async function decompressVgz(url: string): Promise<Uint8Array> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`VgmPlayer: HTTP ${resp.status} for ${url}`)
  if (!resp.body) throw new Error(`VgmPlayer: empty body for ${url}`)
  const reader = resp.body.pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as Uint8Array)
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}

function renderVgm(vgm: Uint8Array): { samples: Float32Array; loopStartSample: number } {
  const dv = new DataView(vgm.buffer, vgm.byteOffset, vgm.byteLength)

  const magic = String.fromCharCode(vgm[0], vgm[1], vgm[2], vgm[3])
  if (magic !== 'Vgm ') throw new Error('VgmPlayer: not a VGM file')

  const version = dv.getUint32(0x08, true)
  const clock = dv.getUint32(0x0c, true) || 3579545
  const totalSamples = dv.getUint32(0x18, true) || (VGM_SAMPLE_RATE * 60)
  const loopOffset = dv.getUint32(0x1c, true)
  const feedback = dv.getUint16(0x28, true) || 0x0009
  const srWidth = vgm[0x2a] || 16
  const srMask = (1 << srWidth) - 1
  const srTopBit = 1 << (srWidth - 1)

  let dataStart = 0x40
  if (version >= 0x150) {
    const rel = dv.getUint32(0x34, true)
    if (rel > 0) dataStart = 0x34 + rel
  }

  const loopBytePos = loopOffset > 0 ? 0x1c + loopOffset : -1
  let loopStartSample = 0
  let loopMarked = false

  // --- SN76489 state ---
  const toneN = [1, 1, 1]      // 10-bit period (0 treated as 1024)
  const vol = [15, 15, 15, 15] // 4-bit attenuation; 15 = silence
  let noiseCtrl = 0
  let latchReg = 0

  const phase = [0.0, 0.0, 0.0]
  const pol = [1, 1, 1]        // square-wave polarity per tone channel
  let nPhase = 0.0
  let nPol = 1
  let lfsr = srTopBit

  const tpk = clock / 16 / VGM_SAMPLE_RATE  // chip ticks per audio sample

  // Attenuation table: 0 = full, 15 = silent, -2 dB per step
  const attn = new Float32Array(16)
  for (let i = 0; i < 15; i++) attn[i] = Math.pow(10, -i * 2 / 20)
  attn[15] = 0

  const noiseRateLUT = [16, 32, 64, 0] as const  // 0 → use toneN[2]

  const write = (b: number) => {
    if (b & 0x80) {
      latchReg = (b >> 4) & 7
      const ch = latchReg >> 1
      const isV = latchReg & 1
      const d = b & 0xf
      if (isV) {
        vol[ch] = d
      } else if (ch === 3) {
        noiseCtrl = d & 7
        lfsr = srTopBit   // reset LFSR on noise register write
      } else {
        toneN[ch] = ((toneN[ch] & 0x3f0) | d) || 0x400
      }
    } else {
      const ch = latchReg >> 1
      if (!(latchReg & 1) && ch < 3) {
        toneN[ch] = ((toneN[ch] & 0xf) | ((b & 0x3f) << 4)) || 0x400
      }
    }
  }

  const output = new Float32Array(totalSamples)
  let outIdx = 0
  let pending = 0

  const flush = () => {
    while (pending > 0 && outIdx < output.length) {
      pending -= 1

      // Advance tone channels
      for (let c = 0; c < 3; c++) {
        phase[c] += tpk
        const N = toneN[c]
        if (N > 1) {
          while (phase[c] >= N) { phase[c] -= N; pol[c] = -pol[c] }
        }
      }

      // Advance noise channel
      nPhase += tpk
      const nr = noiseRateLUT[noiseCtrl & 3] || toneN[2]
      while (nPhase >= nr) {
        nPhase -= nr
        const isWhite = (noiseCtrl >> 2) & 1
        let bit: number
        if (isWhite) {
          // XOR parity of bits selected by feedback mask
          let tmp = lfsr & feedback
          tmp ^= tmp >> 8; tmp ^= tmp >> 4; tmp ^= tmp >> 2; tmp ^= tmp >> 1
          bit = tmp & 1
        } else {
          bit = lfsr & 1  // periodic: rotate bit 0
        }
        lfsr = ((lfsr >> 1) | (bit ? srTopBit : 0)) & srMask
        nPol = (lfsr & 1) ? 1 : -1
      }

      // Sum 4 channels, normalise to ±1
      output[outIdx++] = (
        pol[0] * attn[vol[0]] +
        pol[1] * attn[vol[1]] +
        pol[2] * attn[vol[2]] +
        nPol  * attn[vol[3]]
      ) * 0.25
    }
  }

  let pos = dataStart
  while (pos < vgm.length && outIdx < output.length) {
    // Record loop point when we reach that byte offset
    if (!loopMarked && loopBytePos >= 0 && pos >= loopBytePos) {
      loopStartSample = outIdx
      loopMarked = true
    }

    const cmd = vgm[pos]
    if (cmd === 0x66) break   // end of data

    if (cmd === 0x50) {                         // SN76489 write
      write(vgm[pos + 1]); pos += 2
    } else if (cmd === 0x4f) {                  // Game Gear stereo (ignore)
      pos += 2
    } else if (cmd === 0x61) {                  // wait N samples
      pending += dv.getUint16(pos + 1, true); flush(); pos += 3
    } else if (cmd === 0x62) {                  // wait 735 samples (60 Hz)
      pending += 735; flush(); pos += 1
    } else if (cmd === 0x63) {                  // wait 882 samples (50 Hz)
      pending += 882; flush(); pos += 1
    } else if ((cmd & 0xf0) === 0x70) {         // wait n+1 samples
      pending += (cmd & 0xf) + 1; flush(); pos += 1
    } else {
      pos += 1  // skip unknown command
    }
  }
  if (pending > 0) flush()

  const samples = outIdx < output.length ? output.slice(0, outIdx) : output
  return { samples, loopStartSample }
}

// ---------------------------------------------------------------------------

type BufEntry = { buf: AudioBuffer; loopStart: number; loopEnd: number }

export class VgmPlayer {
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private source: AudioBufferSourceNode | null = null
  private rendered = new Map<string, { samples: Float32Array; loopStartSample: number }>()
  private audioBuffers = new Map<string, BufEntry>()
  private enabled = true
  private currentUrl: string | null = null

  /** Fetch and pre-render tracks (call early, no user gesture required). */
  async preload(urls: string[]): Promise<void> {
    await Promise.all(
      urls.map(async (url) => {
        if (this.rendered.has(url)) return
        try {
          const bytes = await decompressVgz(url)
          this.rendered.set(url, renderVgm(bytes))
        } catch (e) {
          console.warn('[VgmPlayer] Failed to preload', url, e)
        }
      }),
    )
  }

  /** Start playing a track (loops). Safe to call before user gesture. */
  play(url: string, gain = 0.4): void {
    this.currentUrl = url
    this._ensureContext()
    this.stop()
    if (!this.enabled) return

    const bufEntry = this.audioBuffers.get(url) ?? this._buildAudioBuffer(url)
    if (!bufEntry) return

    this.gainNode!.gain.value = gain
    this.source = this.ctx!.createBufferSource()
    this.source.buffer = bufEntry.buf
    this.source.loop = true
    this.source.loopStart = bufEntry.loopStart
    this.source.loopEnd = bufEntry.loopEnd
    this.source.connect(this.gainNode!)
    this.source.start()
  }

  stop(): void {
    try { this.source?.stop(0) } catch { /* already stopped */ }
    this.source?.disconnect()
    this.source = null
  }

  /** Enable or disable music. Stopping and resuming preserves the current track.
   *  Pass autoResume=false to enable without immediately replaying (caller will
   *  start the correct track itself). */
  setEnabled(on: boolean, autoResume = true): void {
    this.enabled = on
    if (!on) {
      this.stop()
    } else if (autoResume && this.currentUrl) {
      this.play(this.currentUrl)
    }
  }

  private _ensureContext(): void {
    if (this.ctx) return
    this.ctx = new AudioContext()
    this.gainNode = this.ctx.createGain()
    this.gainNode.connect(this.ctx.destination)
    // Resume on any user gesture (required by browser autoplay policy)
    const resume = () => { if (this.ctx?.state !== 'running') this.ctx?.resume() }
    ;['keydown', 'mousedown', 'pointerdown', 'touchstart'].forEach((e) =>
      document.addEventListener(e, resume, { capture: true, passive: true }),
    )
  }

  private _buildAudioBuffer(url: string): BufEntry | null {
    const r = this.rendered.get(url)
    if (!r || !this.ctx) return null
    const { samples, loopStartSample } = r
    const buf = this.ctx.createBuffer(1, samples.length, VGM_SAMPLE_RATE)
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const loopEnd = samples.length / VGM_SAMPLE_RATE
    const loopStart = loopStartSample / VGM_SAMPLE_RATE
    const entry = { buf, loopStart, loopEnd }
    this.audioBuffers.set(url, entry)
    return entry
  }
}
