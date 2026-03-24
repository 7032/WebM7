/**
 * FM-7 CMT (Cassette Magnetic Tape) Controller
 *
 * T77 tape image format:
 *   Header: 17 bytes (magic + null terminator)
 *   Data:   2-byte pulse widths (bit15=polarity, bit14-0=width)
 *           Byte order auto-detected (BE or LE)
 *   Gap:    0x0000 = silence/gap marker (not end-of-tape)
 *
 * FM-7 cassette I/O (main CPU):
 *   $FD00 write bit 1: motor control (1=ON, 0=OFF)
 *   $FD02 read  bit 7: read data (current signal level from tape)
 */

const T77_HEADER = "XM7 TAPE IMAGE 0";
const T77_HEADER_SIZE = 17;

export class CMT {
    constructor() {
        /** @type {Uint16Array|null} */
        this._pulses = null;
        this._pos = 0;
        this._cycleCount = 0;
        this._level = 0;
        this._motor = false;
        this._loaded = false;
        this._eot = false;
        this._scale = 10;

        // Statistics
        this._pulsesConsumed = 0;
        this._transitions = 0;
        this._readBitCalls = 0;
        this._validPulseCount = 0;
        this._lastDiagPulse = 0;
    }

    /**
     * Load a T77 tape image with auto byte-order detection.
     */
    loadT77(buffer) {
        this._pulses = null;
        this._loaded = false;
        this._eot = false;
        this._pos = 0;
        this._cycleCount = 0;
        this._level = 0;

        if (buffer.byteLength < T77_HEADER_SIZE + 2) {
            console.error('[CMT] T77 file too small');
            return false;
        }

        const headerBytes = new Uint8Array(buffer, 0, T77_HEADER_SIZE);
        let header = '';
        for (let i = 0; i < T77_HEADER.length; i++) {
            header += String.fromCharCode(headerBytes[i]);
        }
        if (header !== T77_HEADER) {
            console.error('[CMT] Invalid T77 header:', header);
            return false;
        }

        const dataSize = buffer.byteLength - T77_HEADER_SIZE;
        const numPulses = (dataSize / 2) | 0;
        const view = new DataView(buffer, T77_HEADER_SIZE);

        // Auto-detect byte order: try both BE and LE, pick the one
        // that gives more values in the expected range (20-100)
        const littleEndian = this._detectByteOrder(view, numPulses);

        // Read ALL pulses — 0x0000 is a gap marker, NOT end-of-tape.
        // End of tape is the end of the file.
        this._pulses = new Uint16Array(numPulses);
        let validCount = numPulses;
        for (let i = 0; i < numPulses; i++) {
            this._pulses[i] = view.getUint16(i * 2, littleEndian);
        }

        this._loaded = true;
        this._validPulseCount = validCount;

        // Auto-detect scale from the data
        this._scale = this._detectScale(validCount);

        if (validCount > 0) {
            this._level = (this._pulses[0] & 0x8000) ? 1 : 0;
        }

        this._logPulseDump(validCount, littleEndian);
        return true;
    }

    /**
     * Detect byte order by checking which gives values in expected range.
     * T77 data pulses should have widths around 20-60 (for 1200/2400Hz).
     */
    _detectByteOrder(view, numPulses) {
        let beInRange = 0, leInRange = 0;
        const sampleCount = Math.min(numPulses, 10000);
        // Sample from middle of file (skip potential silence/gaps at start)
        const start = Math.min(Math.floor(numPulses * 0.3), Math.max(0, numPulses - sampleCount));
        for (let i = start; i < start + sampleCount && i < numPulses; i++) {
            const be = view.getUint16(i * 2, false) & 0x7FFF;
            const le = view.getUint16(i * 2, true) & 0x7FFF;
            if (be >= 5 && be <= 200) beInRange++;
            if (le >= 5 && le <= 200) leInRange++;
        }
        const isLE = leInRange > beInRange;
        console.log(`[CMT] Byte order: BE=${beInRange}/${sampleCount} LE=${leInRange}/${sampleCount} → ${isLE ? 'LE' : 'BE'}`);
        return isLE;
    }

    /**
     * Detect scale factor from the two dominant pulse width clusters.
     * Target: 2400Hz half-period ≈ 256 CPU cycles (at 1.2288MHz).
     */
    _detectScale(validCount) {
        if (validCount < 100) return 10;

        // Collect widths, skip zeros (gaps), very large (silence) and very small (noise)
        const widths = [];
        for (let i = 0; i < validCount; i++) {
            const w = this._pulses[i] & 0x7FFF;
            if (w >= 5 && w < 5000) widths.push(w);
        }
        if (widths.length < 100) return 10;

        widths.sort((a, b) => a - b);
        // Short cluster (2400Hz): 10th-30th percentile
        const shortCluster = (widths[Math.floor(widths.length * 0.10)] +
                              widths[Math.floor(widths.length * 0.30)]) / 2;
        const scale = 256 / shortCluster;
        const longCluster = (widths[Math.floor(widths.length * 0.60)] +
                             widths[Math.floor(widths.length * 0.80)]) / 2;

        console.log(`[CMT] Scale: ${scale.toFixed(4)} (short=${shortCluster.toFixed(0)}→${(shortCluster*scale).toFixed(0)}cy, ` +
            `long=${longCluster.toFixed(0)}→${(longCluster*scale).toFixed(0)}cy, ratio=${(longCluster/shortCluster).toFixed(2)})`);
        return scale;
    }

    _logPulseDump(validCount, isLE) {
        const lines = [];
        const dumpCount = Math.min(20, validCount);
        for (let i = 0; i < dumpCount; i++) {
            const raw = this._pulses[i];
            const pol = (raw & 0x8000) ? 'H' : 'L';
            const w = raw & 0x7FFF;
            lines.push(`  [${i}] ${pol} w=${w} (${(w * this._scale)|0}cy)`);
        }
        // Sample from data section
        const mid = Math.min(validCount - 1, Math.floor(validCount * 0.3));
        if (mid > 100) {
            lines.push(`  --- sample at pos ${mid}: ---`);
            for (let i = mid; i < Math.min(mid + 10, validCount); i++) {
                const raw = this._pulses[i];
                const pol = (raw & 0x8000) ? 'H' : 'L';
                const w = raw & 0x7FFF;
                lines.push(`  [${i}] ${pol} w=${w} (${(w * this._scale)|0}cy)`);
            }
        }
        console.log(`[CMT] T77: ${validCount} pulses, ${isLE ? 'LE' : 'BE'}, scale=${this._scale.toFixed(4)}\n${lines.join('\n')}`);
    }

    /**
     * Advance tape by CPU cycles with proper timing.
     * The scale factor converts T77 pulse widths to CPU cycles.
     * Speed is controlled by the emulator running more cycles per frame.
     */
    step(cycles) {
        if (!this._motor || !this._loaded || this._eot) return;

        this._cycleCount += cycles;

        while (this._pulses && this._pos < this._pulses.length) {
            const raw = this._pulses[this._pos];
            const width = (raw & 0x7FFF) * this._scale;

            // Width 0 = gap/silence marker in T77, skip instantly
            if (width < 1) {
                this._pulsesConsumed++;
                this._pos++;
                continue;
            }

            if (this._cycleCount >= width) {
                this._cycleCount -= width;
                this._pulsesConsumed++;
                this._pos++;
                if (this._pos < this._pulses.length) {
                    const newLevel = (this._pulses[this._pos] & 0x8000) ? 1 : 0;
                    if (newLevel !== this._level) this._transitions++;
                    this._level = newLevel;
                }
            } else {
                break;
            }
        }

        if (this._pulses && this._pos >= this._pulses.length) {
            this._eot = true;
            console.log(`[CMT] End of tape (consumed=${this._pulsesConsumed}, trans=${this._transitions})`);
        }

        if (this._pulsesConsumed % 100000 === 0 && this._pulsesConsumed > 0 &&
            this._pulsesConsumed !== this._lastDiagPulse) {
            this._lastDiagPulse = this._pulsesConsumed;
            console.log(`[CMT] progress: pos=${this._pos}/${this._validPulseCount} trans=${this._transitions} level=${this._level}`);
        }
    }

    readDataBit() {
        if (!this._loaded || !this._motor) return 0x80;
        this._readBitCalls++;
        return this._level ? 0x80 : 0x00;
    }

    writeControl(value) {
        const newMotor = (value & 0x02) !== 0;
        if (newMotor && !this._motor) {
            console.log(`[CMT] Motor ON (pos=${this._pos}/${this._validPulseCount}, scale=${this._scale.toFixed(4)})`);
            if (this._loaded && this._pulses && this._pos < this._pulses.length) {
                this._level = (this._pulses[this._pos] & 0x8000) ? 1 : 0;
            }
        } else if (!newMotor && this._motor) {
            console.log(`[CMT] Motor OFF (pos=${this._pos}, consumed=${this._pulsesConsumed}, trans=${this._transitions}, reads=${this._readBitCalls})`);
        }
        this._motor = newMotor;
    }

    get loaded() { return this._loaded; }
    get motor() { return this._motor; }
    get eot() { return this._eot; }
    get position() { return this._pos; }
    get totalPulses() { return this._pulses ? this._pulses.length : 0; }

    get stats() {
        return {
            consumed: this._pulsesConsumed,
            transitions: this._transitions,
            reads: this._readBitCalls,
            pos: this._pos,
            total: this._validPulseCount
        };
    }

    rewind() {
        let stats = '';
        if (this._loaded) {
            stats = `consumed=${this._pulsesConsumed} transitions=${this._transitions} reads=${this._readBitCalls}`;
            console.log(`[CMT] Tape rewound (${stats})`);
        }
        this._pos = 0;
        this._cycleCount = 0;
        this._eot = false;
        this._pulsesConsumed = 0;
        this._transitions = 0;
        this._readBitCalls = 0;
        this._lastDiagPulse = 0;
        if (this._loaded && this._pulses && this._pulses.length > 0) {
            this._level = (this._pulses[0] & 0x8000) ? 1 : 0;
        } else {
            this._level = 0;
        }
        return stats;
    }

    reset() {
        this._motor = false;
        this.rewind();
    }
}
