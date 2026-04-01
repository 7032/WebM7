// =============================================================================
// AY-3-8910 PSG Emulator for FM-7 Web Emulator
//
// FM-7 built-in PSG mapped at $FD0D (command) / $FD0E (data).
// BDIR/BC1 protocol:
//   $03 → Address latch (data bus = register number)
//   $02 → Data write   (data bus → latched register)
//   $01 → Data read    (latched register → data bus)
//   $00 → Inactive
//
// PSG master clock = 1.2288 MHz (same as CPU clock).
// Tone frequency  = clock / (16 × TP)    where TP = 12-bit period
// Noise frequency = clock / (16 × NP)    where NP = 5-bit period
// Envelope step   = clock / (256 × EP)   where EP = 16-bit period
// =============================================================================

const PSG_CLOCK     = 1228800;       // 1.2288 MHz
const CLOCK_DIV     = 8;             // Internal divider for tone/noise
const ENV_DIV       = CLOCK_DIV * 2; // Envelope runs at half the tone rate
const SAMPLE_RATE   = 48000;
const BUF_SIZE      = 16384;         // Ring buffer (must be power of 2)
const BUF_MASK      = BUF_SIZE - 1;

// AY-3-8910 logarithmic volume table (measured from real chip)
const VOL = new Float32Array([
    0.0000, 0.0099, 0.0144, 0.0203,
    0.0287, 0.0405, 0.0573, 0.0809,
    0.1143, 0.1614, 0.2281, 0.3224,
    0.4556, 0.6438, 0.9098, 1.0000,
]);

export class PSG {
    constructor() {
        // --- Registers (R0-R15) ---
        this.regs = new Uint8Array(16);

        // --- BDIR/BC1 interface ---
        this._latchedReg = 0;
        this._dataBus = 0;

        // --- Tone generators (channels A, B, C) ---
        this._tonePeriod  = new Float64Array(3);
        this._toneCount   = new Float64Array(3);
        this._toneOut     = new Uint8Array(3);

        // --- Noise generator ---
        this._noisePeriod = 0;
        this._noiseCount  = 0;
        this._noiseOut    = 0;
        this._lfsr        = 1;           // 17-bit LFSR, must never be 0

        // --- Envelope generator ---
        this._envPeriod   = 0;
        this._envCount    = 0;
        this._envStep     = 0;           // Current level 0-15
        this._envDir      = -1;          // +1 = attack, -1 = decay
        this._envHolding  = false;

        // --- Audio output ---
        this._audioCtx    = null;
        this._scriptNode  = null;
        this._gainNode    = null;
        this._volume      = 0.5;          // Default 50%
        this._ringBuf     = new Float32Array(BUF_SIZE);
        this._wPos        = 0;
        this._rPos        = 0;

        // --- Clock accumulator ---
        this._accum             = 0;
        this._ticksPerSample    = (PSG_CLOCK / CLOCK_DIV) / SAMPLE_RATE;
        this._envTicksPerSample = (PSG_CLOCK / ENV_DIV)   / SAMPLE_RATE;
        this._cpuToPsgRatio     = PSG_CLOCK / 1794000;  // default FM-7
    }

    // =====================================================================
    // Reset
    // =====================================================================

    setCPUClock(hz) {
        this._cpuToPsgRatio = PSG_CLOCK / hz;
    }

    reset() {
        this.regs.fill(0);
        this.regs[7] = 0xFF;           // Mixer: all disabled
        this._latchedReg = 0;
        this._dataBus = 0;

        this._tonePeriod.fill(0);
        this._toneCount.fill(0);
        this._toneOut.fill(0);

        this._noisePeriod = 0;
        this._noiseCount  = 0;
        this._noiseOut    = 0;
        this._lfsr        = 1;

        this._envPeriod  = 0;
        this._envCount   = 0;
        this._envStep    = 0;
        this._envDir     = -1;
        this._envHolding = false;

        this._accum = 0;
        this._wPos  = 0;
        this._rPos  = 0;
        this._ringBuf.fill(0);
    }

    // =====================================================================
    // I/O interface  ($FD0D = command,  $FD0E = data)
    // =====================================================================

    /** Write to command port ($FD0D). */
    writeCmd(val) {
        switch (val & 0x03) {
            case 0x03:                          // Latch address
                this._latchedReg = this._dataBus & 0x0F;
                break;
            case 0x02:                          // Write data
                this._writeReg(this._latchedReg, this._dataBus);
                break;
            case 0x01:                          // Read data
                if (this._latchedReg <= 0x0F) {
                    this._dataBus = this.regs[this._latchedReg];
                }
                break;
            // 0x00 = inactive — do nothing
        }
    }

    /** Write to data port ($FD0E). */
    writeData(val) { this._dataBus = val & 0xFF; }

    /** Read from data port ($FD0E). */
    readData()     { return this._dataBus; }

    /** Read from command port ($FD0D) — returns open-bus 0xFF. */
    readCmd()      { return 0xFF; }

    // =====================================================================
    // Register write
    // =====================================================================

    _writeReg(reg, val) {
        reg &= 0x0F;
        this.regs[reg] = val;

        switch (reg) {
            case 0: case 1:
                this._tonePeriod[0] = ((this.regs[1] & 0x0F) << 8) | this.regs[0];
                break;
            case 2: case 3:
                this._tonePeriod[1] = ((this.regs[3] & 0x0F) << 8) | this.regs[2];
                break;
            case 4: case 5:
                this._tonePeriod[2] = ((this.regs[5] & 0x0F) << 8) | this.regs[4];
                break;
            case 6:
                this._noisePeriod = val & 0x1F;
                break;
            case 11: case 12:
                this._envPeriod = this.regs[11] | (this.regs[12] << 8);
                break;
            case 13:
                // Writing R13 restarts the envelope
                this._envCount = 0;
                this._envHolding = false;
                if (val & 0x04) {
                    this._envStep = 0;   // Attack: start low, go up
                    this._envDir  = 1;
                } else {
                    this._envStep = 15;  // Decay: start high, go down
                    this._envDir  = -1;
                }
                break;
        }
    }

    // =====================================================================
    // Synthesis — called from emulation loop
    // =====================================================================

    /**
     * Advance the PSG by `cpuCycles` worth of audio and fill the ring buffer.
     * Must be called regularly from the frame loop.
     */
    step(cpuCycles) {
        if (!this._audioCtx) return;

        // Convert CPU cycles to PSG internal ticks (1.2288 MHz / 8)
        this._accum += cpuCycles * this._cpuToPsgRatio / CLOCK_DIV;
        const tps = this._ticksPerSample;

        while (this._accum >= tps) {
            this._accum -= tps;
            this._advance(tps);
            this._ringBuf[this._wPos] = this._mix();
            this._wPos = (this._wPos + 1) & BUF_MASK;
        }
    }

    // ---- Internal tick advance ----

    _advance(ticks) {
        // --- Tone counters ---
        for (let ch = 0; ch < 3; ch++) {
            const p = this._tonePeriod[ch];
            if (p < 1) { this._toneOut[ch] = 1; continue; }
            this._toneCount[ch] += ticks;
            while (this._toneCount[ch] >= p) {
                this._toneCount[ch] -= p;
                this._toneOut[ch] ^= 1;
            }
        }

        // --- Noise counter (runs at half the tone rate) ---
        const np = (this._noisePeriod || 1) * 2;
        this._noiseCount += ticks;
        while (this._noiseCount >= np) {
            this._noiseCount -= np;
            // 17-bit LFSR: XOR bits 0 and 3
            const bit = ((this._lfsr ^ (this._lfsr >> 3)) & 1);
            this._lfsr = ((this._lfsr >> 1) | (bit << 16)) & 0x1FFFF;
            if (this._lfsr === 0) this._lfsr = 1;   // Safety
            this._noiseOut = this._lfsr & 1;
        }

        // --- Envelope counter ---
        if (!this._envHolding && this._envPeriod > 0) {
            // Envelope ticks at half the tone counter rate
            const envTicks = ticks * 0.5;
            const ep = this._envPeriod;
            this._envCount += envTicks;
            while (this._envCount >= ep && !this._envHolding) {
                this._envCount -= ep;
                this._envStep += this._envDir;
                if (this._envStep < 0 || this._envStep > 15) {
                    this._envCycle();
                }
            }
        }
    }

    // Handle envelope cycle boundary
    _envCycle() {
        const shape = this.regs[13] & 0x0F;
        const cont  = shape & 0x08;
        const att   = shape & 0x04;
        const alt   = shape & 0x02;
        const hold  = shape & 0x01;

        if (!cont) {
            // Shapes 0-7: one-shot, hold at 0
            this._envStep    = 0;
            this._envHolding = true;
        } else if (hold) {
            // Determine hold level
            if (alt) {
                // 0xB → decay then hold 15;  0xF → attack then hold 0
                this._envStep = att ? 0 : 15;
            } else {
                // 0x9 → decay then hold 0;   0xD → attack then hold 15
                this._envStep = att ? 15 : 0;
            }
            this._envHolding = true;
        } else if (alt) {
            // Triangle (0xA, 0xE): reverse direction
            this._envDir = -this._envDir;
            // Clamp to valid range
            this._envStep = (this._envDir > 0) ? 0 : 15;
        } else {
            // Sawtooth repeat (0x8, 0xC): restart
            this._envStep = att ? 0 : 15;
        }
    }

    // ---- Mix output ----

    _mix() {
        const mixer = this.regs[7];
        let out = 0;

        for (let ch = 0; ch < 3; ch++) {
            // Mixer bits: 0-2 = tone enable (active low), 3-5 = noise enable (active low)
            const toneGate  = ((mixer >> ch)       & 1) ? 1 : this._toneOut[ch];
            const noiseGate = ((mixer >> (ch + 3))  & 1) ? 1 : this._noiseOut;

            if (toneGate & noiseGate) {
                const vr = this.regs[8 + ch];
                const level = (vr & 0x10)
                    ? Math.abs(this._envStep)           // Envelope mode
                    : (vr & 0x0F);                      // Fixed volume
                out += VOL[level];
            }
        }

        // 3 channels max → scale to ≈ ±0.5
        return out * 0.25;
    }

    // =====================================================================
    // Web Audio output
    // =====================================================================

    /**
     * Initialise the AudioContext.  Must be called from a user-gesture
     * handler (click / keydown) to satisfy browser autoplay policy.
     */
    startAudio() {
        if (this._audioCtx) return;

        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            this._audioCtx = new AC({ sampleRate: SAMPLE_RATE });

            // GainNode for volume control
            this._gainNode = this._audioCtx.createGain();
            this._gainNode.gain.value = this._volume;
            this._gainNode.connect(this._audioCtx.destination);

            // ScriptProcessorNode pulls from the ring buffer
            // Use 1024 samples (~21ms) for lower latency at game start
            this._scriptNode = this._audioCtx.createScriptProcessor(1024, 0, 1);
            this._scriptNode.onaudioprocess = (ev) => {
                const buf = ev.outputBuffer.getChannelData(0);
                let rp = this._rPos;
                const wp = this._wPos;
                for (let i = 0; i < buf.length; i++) {
                    if (rp !== wp) {
                        buf[i] = this._ringBuf[rp];
                        rp = (rp + 1) & BUF_MASK;
                    } else {
                        // Underrun: hold last known sample to avoid clicks
                        buf[i] = (i > 0) ? buf[i - 1] : 0;
                    }
                }
                this._rPos = rp;
            };
            this._scriptNode.connect(this._gainNode);

            console.log('PSG: audio started (' + this._audioCtx.sampleRate + ' Hz)');
        } catch (e) {
            console.warn('PSG: audio init failed:', e);
        }
    }

    /** Resume a suspended AudioContext (call from user gesture). */
    resumeAudio() {
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            this._audioCtx.resume();
        }
    }

    /**
     * Set output volume.
     * @param {number} v - 0.0 (silent) to 1.0 (full)
     */
    setVolume(v) {
        this._volume = Math.max(0, Math.min(1, v));
        if (this._gainNode) {
            this._gainNode.gain.value = this._volume;
        }
    }

    /** Get current volume (0.0-1.0). */
    getVolume() { return this._volume; }

    stopAudio() {
        if (this._scriptNode) {
            this._scriptNode.disconnect();
            this._scriptNode = null;
        }
        if (this._gainNode) {
            this._gainNode.disconnect();
            this._gainNode = null;
        }
        if (this._audioCtx) {
            this._audioCtx.close().catch(() => {});
            this._audioCtx = null;
        }
    }
}
