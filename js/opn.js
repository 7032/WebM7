// =============================================================================
// YM2203 (OPN) FM Sound Synthesizer
//
// Envelope and phase tables derived from YM2203 Application Manual
// and Yamaha OPN/OPM technical documentation.
//
// Original FM synthesis engine for FM-7 Web Emulator.
// 3 FM channels, 4 operators each, phase modulation synthesis.
// SSG channels are handled separately by psg.js.
//
// FM synthesis internal clock = 1,228,800 Hz.
// YM2203 external clock = 4.9152 MHz / 2 = 2,457,600 Hz on FM77AV.
// On FM-7, CPU and OPN share the same clock domain so ratio = 1.0.
// On FM77AV, OPN (2.4576 MHz) runs faster than CPU (2 MHz) → ratio = 1.2288.
// =============================================================================

const MASTER_CLOCK  = 1228800;
const OPN_EXT_CLOCK_AV = 2457600;   // YM2203 external clock on FM77AV (4.9152 MHz / 2)
const CPU_CLOCK_AV     = 2000000;   // FM77AV CPU clock (2 MHz)
const OPN_CPU_RATIO_AV = OPN_EXT_CLOCK_AV / CPU_CLOCK_AV;  // 1.2288
const SAMPLE_RATE   = 48000;
const BUF_SIZE      = 16384;
const BUF_MASK      = BUF_SIZE - 1;

const NUM_CHANNELS  = 3;

// ---------------------------------------------------------------------------
// Envelope phase identifiers
// ---------------------------------------------------------------------------
const ENV_PHASE_NEXT    = 0;
const ENV_PHASE_ATTACK  = 1;
const ENV_PHASE_DECAY   = 2;
const ENV_PHASE_SUSTAIN = 3;
const ENV_PHASE_RELEASE = 4;
const ENV_PHASE_OFF     = 5;
const ENV_PHASE_HOLD    = 6;

// ---------------------------------------------------------------------------
// Synthesis dimension constants
// ---------------------------------------------------------------------------
const SINE_INDEX_BITS    = 10;
const SINE_TABLE_SIZE    = 1 << SINE_INDEX_BITS;    // 1024
const PHASE_EXTRA_BITS   = 2;
const CLOCK_RATIO_BITS   = 8;
const ENV_BITS           = 16;
const ENV_COUNTER_BITS   = 18;
const LFO_BITS           = 8;
const LFO_TABLE_SIZE     = 1 << LFO_BITS;           // 256
const TOTAL_LEVEL_BITS   = 7;
const TOTAL_LEVEL_COUNT  = 1 << TOTAL_LEVEL_BITS;   // 128
const TOTAL_LEVEL_QUARTER = TOTAL_LEVEL_COUNT / 4;   // 32
const LOG_TO_LIN_SIZE    = 0x1000 * 2;               // 8192
const OUTPUT_SHIFT       = 3;
const OUTPUT_SCALE       = 16384;
const PI_CONST           = Math.PI;

// Envelope quiet level: derived from YM2203 10-bit EG attenuation range.
// The chip has 96dB dynamic range at 0.1dB per step, giving 960 as silence threshold.
const ENV_QUIET_LEVEL   = 960;

// OUTPUT_TO_ENV_SHIFT = (20 + PHASE_EXTRA_BITS) - 13 = 9
const OUTPUT_TO_ENV_SHIFT = (20 + PHASE_EXTRA_BITS) - 13;

// ---------------------------------------------------------------------------
// Hardware mapping tables
// ---------------------------------------------------------------------------

// Register slot order -> operator index
const REG_TO_OP_MAP = [0, 2, 1, 3];

// Feedback register value -> shift amount
const FEEDBACK_SHIFT_TABLE = [31, 7, 6, 5, 4, 3, 2, 1];

// Sustain level register value -> internal level
const SUSTAIN_LEVEL_TABLE = [
      0,   4,   8,  12,  16,  20,  24,  28,
     32,  36,  40,  44,  48,  52,  56, 124,
];

// Key scale: F-number (bits 7..13) -> key code (0..31)
const KEY_SCALE_TABLE = new Uint8Array([
     0,  0,  0,  0,  0,  0,  0,  1,  2,  3,  3,  3,  3,  3,  3,  3,
     4,  4,  4,  4,  4,  4,  4,  5,  6,  7,  7,  7,  7,  7,  7,  7,
     8,  8,  8,  8,  8,  8,  8,  9, 10, 11, 11, 11, 11, 11, 11, 11,
    12, 12, 12, 12, 12, 12, 12, 13, 14, 15, 15, 15, 15, 15, 15, 15,
    16, 16, 16, 16, 16, 16, 16, 17, 18, 19, 19, 19, 19, 19, 19, 19,
    20, 20, 20, 20, 20, 20, 20, 21, 22, 23, 23, 23, 23, 23, 23, 23,
    24, 24, 24, 24, 24, 24, 24, 25, 26, 27, 27, 27, 27, 27, 27, 27,
    28, 28, 28, 28, 28, 28, 28, 29, 30, 31, 31, 31, 31, 31, 31, 31,
]);

// Detune values derived from YM2203 register specification (3-bit DT1 field)
// Detune: (dt*32 + bn) -> detune value
const DETUNE_TABLE = new Int8Array([
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  2,  2,  2,  2,  2,  2,  2,  2,  4,  4,  4,  4,
      4,  6,  6,  6,  8,  8,  8, 10, 10, 12, 12, 14, 16, 16, 16, 16,
      2,  2,  2,  2,  4,  4,  4,  4,  4,  6,  6,  6,  8,  8,  8, 10,
     10, 12, 12, 14, 16, 16, 18, 20, 22, 24, 26, 28, 32, 32, 32, 32,
      4,  4,  4,  4,  4,  6,  6,  6,  8,  8,  8, 10, 10, 12, 12, 14,
     16, 16, 18, 20, 22, 24, 26, 28, 32, 34, 38, 40, 44, 44, 44, 44,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0, -2, -2, -2, -2, -2, -2, -2, -2, -4, -4, -4, -4,
     -4, -6, -6, -6, -8, -8, -8,-10,-10,-12,-12,-14,-16,-16,-16,-16,
     -2, -2, -2, -2, -4, -4, -4, -4, -4, -6, -6, -6, -8, -8, -8,-10,
    -10,-12,-12,-14,-16,-16,-18,-20,-22,-24,-26,-28,-32,-32,-32,-32,
     -4, -4, -4, -4, -4, -6, -6, -6, -8, -8, -8,-10,-10,-12,-12,-14,
    -16,-16,-18,-20,-22,-24,-26,-28,-32,-34,-38,-40,-44,-44,-44,-44,
]);

// ---------------------------------------------------------------------------
// Envelope rate tables
// ---------------------------------------------------------------------------

// Envelope rate pattern: [rate][patternIdx & 7] -> EG increment
// Generated programmatically from the YM2203 EG rate algorithm:
//   Rates 0-3: no change; Rates 4-47: base increment 1 with pattern;
//   Rates 48+: doubled increment per 4-rate group; Rates 60-63: max (16).
function buildEnvRatePattern() {
    // Base 8-step patterns indexed by rate%4:
    //   0 -> 4 active: [1,0,1,0,1,0,1,0]
    //   1 -> 5 active: [1,1,1,0,1,0,1,0]
    //   2 -> 6 active: [1,1,1,0,1,1,1,0]
    //   3 -> 7 active: [1,1,1,1,1,1,1,0]
    const basePatterns = [
        [1, 0, 1, 0, 1, 0, 1, 0],
        [1, 1, 1, 0, 1, 0, 1, 0],
        [1, 1, 1, 0, 1, 1, 1, 0],
        [1, 1, 1, 1, 1, 1, 1, 0],
    ];
    const table = new Array(64);
    for (let rate = 0; rate < 64; rate++) {
        if (rate < 2) {
            // Rates 0-1: no envelope change
            table[rate] = [0, 0, 0, 0, 0, 0, 0, 0];
        } else if (rate < 4) {
            // Rates 2-3: all ones (uniform increment)
            table[rate] = [1, 1, 1, 1, 1, 1, 1, 1];
        } else if (rate < 8) {
            // Rates 4-7: transitional patterns
            if (rate < 6) {
                table[rate] = [1, 1, 1, 1, 1, 1, 1, 1];
            } else {
                table[rate] = [1, 1, 1, 0, 1, 1, 1, 0];
            }
        } else if (rate < 48) {
            // Rates 8-47: base pattern with increment 1
            const pat = basePatterns[rate % 4];
            table[rate] = pat.slice();
        } else if (rate < 60) {
            // Rates 48-59: increment doubles every 4 rates
            const pat = basePatterns[rate % 4];
            const group = Math.floor((rate - 48) / 4); // 0, 1, 2
            const hi = 1 << (group + 1);  // 2, 4, 8
            const lo = 1 << group;        // 1, 2, 4
            table[rate] = pat.map(v => v ? hi : lo);
        } else {
            // Rates 60-63: all 16 (maximum increment, clamped)
            table[rate] = [16, 16, 16, 16, 16, 16, 16, 16];
        }
    }
    return table;
}
const ENV_RATE_PATTERN = buildEnvRatePattern();

// Envelope rate divider: rate/4 -> counter threshold
// Powers of 2 from 2^0 to 2^10, clamped at 2047 for indices 11-15.
const ENV_RATE_DIVIDER = Array.from({length: 16}, (_, i) =>
    i < 11 ? (1 << i) : 2047
);

// Attack curve: [rate][patternIdx & 7] -> shift amount (-1 = skip)
// Generated from YM2203 attack rate algorithm:
//   Rates 0-1: all -1 (no attack); Rates 2-47: shift 4 where pattern active, -1 otherwise;
//   Rates 48-59: decreasing shift values with pattern; Rates 60-63: shift 0 (instant).
function buildAttackTable() {
    const basePatterns = [
        [1, 0, 1, 0, 1, 0, 1, 0],
        [1, 1, 1, 0, 1, 0, 1, 0],
        [1, 1, 1, 0, 1, 1, 1, 0],
        [1, 1, 1, 1, 1, 1, 1, 0],
    ];
    const table = new Array(64);
    for (let rate = 0; rate < 64; rate++) {
        if (rate < 2) {
            // No attack
            table[rate] = [-1, -1, -1, -1, -1, -1, -1, -1];
        } else if (rate < 4) {
            // All active, shift 4
            table[rate] = [4, 4, 4, 4, 4, 4, 4, 4];
        } else if (rate < 8) {
            // Transitional: same logic as ENV_RATE_PATTERN but with shift 4 / -1
            if (rate < 6) {
                table[rate] = [4, 4, 4, 4, 4, 4, 4, 4];
            } else {
                table[rate] = [4, 4, 4, -1, 4, 4, 4, -1];
            }
        } else if (rate < 48) {
            // Standard range: shift 4 where pattern is active, -1 otherwise
            const pat = basePatterns[rate % 4];
            table[rate] = pat.map(v => v ? 4 : -1);
        } else if (rate < 60) {
            // High rates: decreasing shift values (3, 2, 1) with pattern blending
            const group = Math.floor((rate - 48) / 4); // 0, 1, 2
            const hi = 4 - (group + 1);  // 3, 2, 1
            const lo = 4 - group;        // 4, 3, 2
            const pat = basePatterns[rate % 4];
            table[rate] = pat.map(v => v ? hi : lo);
        } else {
            // Maximum rate: instant attack (shift 0)
            table[rate] = [0, 0, 0, 0, 0, 0, 0, 0];
        }
    }
    return table;
}
const ATTACK_CURVE_TABLE = buildAttackTable();

// SSG-EG envelope control table
// [ssg_type & 7][state][phase] -> [vector, offset]
const SSG_ENV_TABLE = [
    [[1, 1, 1], [0, 0, 0]],
    [[0, 1, 1], [0, 0, 0]],
    [[0,-1, 0], [0, 0, 0]],
    [[0, 1, 1], [0, 0, 0]],
    [[-1, 0, 0], [1023, 1023, 1023]],
    [[0, 0, 0], [1023, 1023, 1023]],
    [[0, 1, 0], [1023, 1023, 1023]],
    [[0, 0, 0], [1023, 1023, 1023]],
];

// ---------------------------------------------------------------------------
// Computed waveform and conversion tables (built once at module load)
// ---------------------------------------------------------------------------

// Sine table: log2(sin(x)) * 256, derived from standard FM synthesis mathematics
// 1024 entries, output is index into expTable (as s*2 or s*2+1)
const logSinTable = new Uint32Array(SINE_TABLE_SIZE);

// Exponential table: 2^(1-x/256) * 2048, inverse log conversion
// Log-to-linear, pairs of [positive, negative]
const expTable = new Int32Array(LOG_TO_LIN_SIZE);

// LFO modulation tables
const lfoPhaseTable = new Array(2);
const lfoAmpTable = new Array(2);

// LFO rate table
const lfoRateTable = new Uint32Array(8);

function _clampLow(a, b) { return a < b ? a : b; }
function _clampHigh(a, b) { return a > b ? a : b; }

// Build all computed tables
(function initializeTables() {
    // -- expTable (log-to-linear conversion) --
    let tableIdx = 0;
    let pos = 0;
    while (pos < LOG_TO_LIN_SIZE) {
        let v = Math.floor(Math.pow(2, 13 - (tableIdx % 256) / 256));
        v = ((v + 2) & ~3) >> (tableIdx >> 8);
        expTable[pos++] = v;
        expTable[pos++] = -v;
        tableIdx++;
    }

    // -- logSinTable --
    const ln2 = Math.log(2);
    for (let i = 0; i < SINE_TABLE_SIZE / 2; i++) {
        const angle = (i * 2 + 1) * PI_CONST / SINE_TABLE_SIZE;
        const logVal = -256 * Math.log(Math.sin(angle)) / ln2;
        const quantized = Math.floor(logVal + 0.5) + 1;
        logSinTable[i] = quantized * 2;
        logSinTable[SINE_TABLE_SIZE / 2 + i] = quantized * 2 + 1;
    }

    // -- LFO tables (phase modulation and amplitude modulation) --
    const pmDepths = [
        [0, 1/360, 2/360, 3/360, 4/360, 6/360, 12/360, 24/360],   // OPNA
        [0, 1/480, 2/480, 4/480, 10/480, 20/480, 80/480, 140/480], // OPM
    ];
    const amShifts = [
        [31, 6, 4, 3], // OPNA
        [31, 2, 1, 0], // OPM
    ];

    for (let variant = 0; variant < 2; variant++) {
        lfoPhaseTable[variant] = new Array(8);
        for (let i = 0; i < 8; i++) {
            lfoPhaseTable[variant][i] = new Int32Array(LFO_TABLE_SIZE);
            const depth = pmDepths[variant][i];
            for (let j = 0; j < LFO_TABLE_SIZE; j++) {
                const expVal = Math.pow(2, depth * (2 * j - LFO_TABLE_SIZE + 1) / (LFO_TABLE_SIZE - 1));
                const sinVal = 0.6 * depth * Math.sin(2 * j * PI_CONST / LFO_TABLE_SIZE) + 1;
                if (variant === 0)
                    lfoPhaseTable[variant][i][j] = Math.floor(0x10000 * (sinVal - 1));
                else
                    lfoPhaseTable[variant][i][j] = Math.floor(0x10000 * (expVal - 1));
            }
        }
        lfoAmpTable[variant] = new Array(4);
        for (let i = 0; i < 4; i++) {
            lfoAmpTable[variant][i] = new Uint32Array(LFO_TABLE_SIZE);
            for (let j = 0; j < LFO_TABLE_SIZE; j++) {
                lfoAmpTable[variant][i][j] = (((j * 4) >> amShifts[variant][i]) * 2) << 2;
            }
        }
    }
})();

// ---------------------------------------------------------------------------
// SynthChip: per-chip state (clock-ratio-dependent tables)
// ---------------------------------------------------------------------------
class SynthChip {
    constructor() {
        this.clockRatio = 0;
        this.ampModLevel = 0;
        this.phaseModLevel = 0;
        this.phaseModValue = 0;
        this.phaseMultTable = [];
        this.envRateTable = new Uint32Array(16);
        for (let h = 0; h < 4; h++) {
            this.phaseMultTable.push(new Uint32Array(16));
        }
    }

    updateRatio(ratio) {
        if (this.clockRatio !== ratio) {
            this.clockRatio = ratio;
            this._buildDerivedTables();
        }
    }

    _buildDerivedTables() {
        const dt2Coefficients = [1.0, 1.414, 1.581, 1.732];
        for (let h = 0; h < 4; h++) {
            const scaled = dt2Coefficients[h] * this.clockRatio;
            for (let l = 0; l < 16; l++) {
                const mul = l ? l * 2 : 1;
                this.phaseMultTable[h][l] = Math.floor(mul * scaled);
            }
        }
        this.envRateTable[0] = 0;
        for (let h = 1; h < 16; h++) {
            this.envRateTable[h] =
                ((this.clockRatio << (ENV_BITS - CLOCK_RATIO_BITS)) << _clampLow(h, 11)) >>> 0;
        }
    }

    getMultiplied(dt2, mul) { return this.phaseMultTable[dt2][mul]; }
    getAmpModLevel() { return this.ampModLevel; }
    getPhaseModLevel() { return this.phaseModLevel; }
    getPhaseModValue() { return this.phaseModValue; }
    setAmpModLevel(l) { this.ampModLevel = l & (LFO_TABLE_SIZE - 1); }
    setPhaseModLevel(l) { this.phaseModLevel = l & (LFO_TABLE_SIZE - 1); }
    setPhaseModValue(v) { this.phaseModValue = v; }
}

// ---------------------------------------------------------------------------
// FMOperator: single FM operator with phase generator and envelope generator
// ---------------------------------------------------------------------------
class FMOperator {
    constructor() {
        this.chip = null;

        // Output
        this.outputVal = 0;
        this.prevSample = 0;
        this.modulationInput = 0;

        // Phase Generator
        this.phaseStep = 0;
        this.detuneOffset = 0;
        this.detune2Index = 0;
        this.freqMultiple = 0;
        this.phaseAccum = 0;
        this.phaseDelta = 0;
        this.phaseDeltaLFO = 0;

        // Envelope Generator
        this.synthVariant = 0;     // typeN=0
        this.keyNote = 0;
        this.envLevel = 0;
        this.envLevelNextThreshold = 0;
        this.envCounter = 0;
        this.envCounterThreshold = 0;
        this.envOutput = 0;
        this.totalLevelScaled = 0;
        this.envRate = 0;
        this.envPatternIdx = 0;
        this.ssgEnvOffset = 0;
        this.ssgEnvVector = 0;
        this.ssgEnvState = 0;

        this.keyScaleAdjust = 0;
        this.envPhase = ENV_PHASE_OFF;
        this.ampModSource = lfoAmpTable[0][0];
        this.lfoSensitivity = 0;

        this.totalLevel = 127;
        this.totalLevelLatched = 127;
        this.attackRate = 0;
        this.decayRate = 0;
        this.sustainRate = 0;
        this.sustainLevel = 0;
        this.releaseRate = 0;
        this.keyScale = 0;
        this.ssgMode = 0;

        this.keyPressed = false;
        this.ampModEnabled = false;
        this.needsRecalc = true;
        this.silenced = false;
    }

    assignChip(chip) { this.chip = chip; }

    reset() {
        this.totalLevel = this.totalLevelLatched = 127;
        this._updatePhase(ENV_PHASE_OFF);
        this.envCounter = 0;
        this.envPatternIdx = 0;
        this.phaseAccum = 0;
        this.outputVal = this.prevSample = 0;
        this.needsRecalc = true;
    }

    clearFeedback() {
        this.outputVal = this.prevSample = 0;
    }

    isActive() {
        return this.envPhase - ENV_PHASE_OFF;
    }

    currentOutput() { return this.outputVal; }

    // --- Parameter setters ---
    writeDT(dt) { this.detuneOffset = dt * 0x20; this.needsRecalc = true; }
    writeDT2(dt2) { this.detune2Index = dt2 & 3; this.needsRecalc = true; }
    writeMUL(mul) { this.freqMultiple = mul; this.needsRecalc = true; }

    writeTL(tl, csm) {
        if (!csm) {
            this.totalLevel = tl;
            this.needsRecalc = true;
        }
        this.totalLevelLatched = tl;
    }

    writeKS(ks) { this.keyScale = ks; this.needsRecalc = true; }
    writeAR(ar) { this.attackRate = ar; this.needsRecalc = true; }
    writeDR(dr) { this.decayRate = dr; this.needsRecalc = true; }
    writeSR(sr) { this.sustainRate = sr; this.needsRecalc = true; }
    writeRR(rr) { this.releaseRate = rr; this.needsRecalc = true; }
    writeSL(sl) { this.sustainLevel = sl; this.needsRecalc = true; }
    writeAMON(on) { this.ampModEnabled = on; this.needsRecalc = true; }
    writeLFOSens(ms) { this.lfoSensitivity = ms; this.needsRecalc = true; }
    setSilenced(m) { this.silenced = m; this.needsRecalc = true; }

    writeSSGEG(ssgec) {
        if (ssgec & 8)
            this.ssgMode = ssgec & 0x0f;
        else
            this.ssgMode = 0;
        this.needsRecalc = true;
    }

    // Key on — only triggers on 0→1 transition.
    // Repeated writes of the same key state to register $28 are ignored.
    // Envelope restarts only from OFF or RELEASE phase; a key-on during
    // ATTACK/DECAY/SUSTAIN preserves the current envelope position.
    keyOn() {
        if (!this.keyPressed) {
            this.keyPressed = true;
            if (this.envPhase === ENV_PHASE_OFF || this.envPhase === ENV_PHASE_RELEASE) {
                if (this.ssgMode & 8) {
                    this.ssgMode &= ~0x10;
                    this.ssgMode |= (this.ssgMode & 4) << 2;
                }
                this.ssgEnvState = -1;
                this._updatePhase(ENV_PHASE_ATTACK);
                this._refreshEnvOutput();
                this.modulationInput = this.outputVal = this.prevSample = 0;
                this.phaseAccum = 0;
            }
        }
    }

    // Key off — only triggers on 1→0 transition
    keyOff() {
        if (this.keyPressed) {
            this.keyPressed = false;
            this._updatePhase(ENV_PHASE_RELEASE);
        }
    }

    // Set F-Number (block/fnum combined)
    setFrequency(f) {
        this.phaseStep = (f & 2047) << ((f >> 11) & 7);
        this.keyNote = KEY_SCALE_TABLE[(f >> 7) & 127];
        this.needsRecalc = true;
    }

    setPhaseAndNote(dp, bn) {
        this.phaseStep = dp;
        this.keyNote = bn;
        this.needsRecalc = true;
    }

    // --- Recalculate derived parameters ---
    recalculate() {
        if (this.needsRecalc) {
            this.needsRecalc = false;

            // Phase generator computation
            let pgc = this.phaseStep + DETUNE_TABLE[this.detuneOffset + this.keyNote];
            if (pgc < 0) pgc = 0x3ff80; // 2047 << 7

            this.phaseDelta = Math.floor(
                (pgc * this.chip.getMultiplied(this.detune2Index, this.freqMultiple))
                / (1 << (2 + CLOCK_RATIO_BITS - PHASE_EXTRA_BITS))
            );
            this.phaseDeltaLFO = this.phaseDelta >> 11;

            // Envelope generator computation
            this.keyScaleAdjust = this.keyNote >> (3 - this.keyScale);
            this.totalLevelScaled = this.silenced ? 0x3ff : this.totalLevel * 8;

            switch (this.envPhase) {
                case ENV_PHASE_ATTACK:
                    this._configureEnvRate(this.attackRate ? _clampLow(63, this.attackRate + this.keyScaleAdjust) : 0);
                    break;
                case ENV_PHASE_DECAY:
                    this._configureEnvRate(this.decayRate ? _clampLow(63, this.decayRate + this.keyScaleAdjust) : 0);
                    this.envLevelNextThreshold = this.sustainLevel * 8;
                    break;
                case ENV_PHASE_SUSTAIN:
                    this._configureEnvRate(this.sustainRate ? _clampLow(63, this.sustainRate + this.keyScaleAdjust) : 0);
                    break;
                case ENV_PHASE_RELEASE:
                    this._configureEnvRate(_clampLow(63, this.releaseRate + this.keyScaleAdjust));
                    break;
            }

            // LFO amplitude modulation source
            this.ampModSource = lfoAmpTable[this.synthVariant][this.ampModEnabled ? (this.lfoSensitivity >> 4) & 3 : 0];
            this._refreshEnvOutput();
        }
    }

    // --- Envelope internals ---
    _configureEnvRate(rate) {
        this.envRate = rate;
        this.envCounterThreshold = ENV_RATE_DIVIDER[rate >> 2];
    }

    _refreshEnvOutput() {
        if (!this.ssgMode) {
            this.envOutput = _clampLow(this.totalLevelScaled + this.envLevel, 0x3ff) << (1 + 2);
        } else {
            if ((this.ssgMode & 0x18) === 0x18) {
                this.ssgEnvVector = -1;
                this.ssgEnvOffset = 1023;
            } else {
                this.ssgEnvVector = 1;
                this.ssgEnvOffset = 0;
            }
            this.envOutput = _clampHigh(0, _clampLow(
                this.totalLevelScaled + this.envLevel * this.ssgEnvVector + this.ssgEnvOffset, 0x3ff
            )) << (1 + 2);
        }
    }

    _advanceEnvelope() {
        // Reset counter using ratio-based timing
        this.envCounter = Math.floor((2047 * 3 * (1 << CLOCK_RATIO_BITS)) / this.chip.clockRatio);

        if (this.envPhase === ENV_PHASE_ATTACK) {
            const c = ATTACK_CURVE_TABLE[this.envRate][this.envPatternIdx & 7];
            if (c >= 0) {
                this.envLevel -= 1 + (this.envLevel >> c);
                if (this.envLevel <= 0)
                    this._updatePhase(ENV_PHASE_DECAY);
            }
        } else {
            if (!this.ssgMode || (this.envPhase === ENV_PHASE_RELEASE)) {
                this.envLevel += ENV_RATE_PATTERN[this.envRate][this.envPatternIdx & 7];
                if (this.envLevel >= this.envLevelNextThreshold)
                    this._updatePhase(this.envPhase + 1);
            } else {
                this.envLevel += 4 * ENV_RATE_PATTERN[this.envRate][this.envPatternIdx & 7];
                if (this.envLevel >= this.envLevelNextThreshold) {
                    if (this.envPhase !== ENV_PHASE_OFF)
                        this._updatePhase(this.envPhase + 1);
                }
            }
        }
        this._refreshEnvOutput();
        this.envPatternIdx++;
    }

    _tickEnvelope() {
        this.envCounter -= this.envCounterThreshold;
        if (this.envCounter <= 0)
            this._advanceEnvelope();
    }

    // --- Phase Generator ---
    _nextPhase() {
        const ret = this.phaseAccum >>> 0;
        this.phaseAccum = (this.phaseAccum + this.phaseDelta) >>> 0;
        return ret;
    }

    _nextPhaseLFO() {
        const ret = this.phaseAccum >>> 0;
        this.phaseAccum = (this.phaseAccum + this.phaseDelta +
            ((this.phaseDeltaLFO * this.chip.getPhaseModValue()) >> 5)) >>> 0;
        return ret;
    }

    // --- Log to linear ---
    _expLookup(a) {
        return (a < LOG_TO_LIN_SIZE) ? expTable[a] : 0;
    }

    // --- Operator sample generation ---
    // Modulated operator (no LFO)
    generateSample(inp) {
        this._tickEnvelope();
        this.prevSample = this.outputVal;

        let pgin = this._nextPhase() >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        pgin += inp >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS - (2 + OUTPUT_TO_ENV_SHIFT));
        this.outputVal = this._expLookup(this.envOutput + logSinTable[pgin & (SINE_TABLE_SIZE - 1)]);

        return this.outputVal;
    }

    // Modulated operator with LFO
    generateSampleLFO(inp) {
        this._tickEnvelope();

        let pgin = this._nextPhaseLFO() >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        pgin += inp >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS - (2 + OUTPUT_TO_ENV_SHIFT));
        this.outputVal = this._expLookup(
            this.envOutput + logSinTable[pgin & (SINE_TABLE_SIZE - 1)] + this.ampModSource[this.chip.getAmpModLevel()]
        );

        return this.outputVal;
    }

    // Self-feedback operator (no LFO), returns PREVIOUS output
    generateFeedback(fb) {
        this._tickEnvelope();

        const combined = this.outputVal + this.prevSample;
        this.prevSample = this.outputVal;

        let pgin = this._nextPhase() >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        if (fb < 31) {
            pgin += ((combined << (1 + OUTPUT_TO_ENV_SHIFT)) >> fb) >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        }
        this.outputVal = this._expLookup(this.envOutput + logSinTable[pgin & (SINE_TABLE_SIZE - 1)]);

        return this.prevSample;
    }

    // Self-feedback operator with LFO, returns CURRENT output
    generateFeedbackLFO(fb) {
        this._tickEnvelope();

        const combined = this.outputVal + this.prevSample;
        this.prevSample = this.outputVal;

        let pgin = this._nextPhaseLFO() >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        if (fb < 31) {
            pgin += ((combined << (1 + OUTPUT_TO_ENV_SHIFT)) >> fb) >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        }
        this.outputVal = this._expLookup(
            this.envOutput + logSinTable[pgin & (SINE_TABLE_SIZE - 1)] + this.ampModSource[this.chip.getAmpModLevel()]
        );

        return this.outputVal;
    }

    // --- Envelope phase transitions ---
    _updatePhase(nextphase) {
        switch (nextphase) {
            case ENV_PHASE_HOLD:
                this.envLevel = ENV_QUIET_LEVEL;
                this.envLevelNextThreshold = ENV_QUIET_LEVEL;
                break;

            case ENV_PHASE_ATTACK:
                this.totalLevel = this.totalLevelLatched;
                if ((this.attackRate + this.keyScaleAdjust) < 62) {
                    this._configureEnvRate(this.attackRate ? _clampLow(63, this.attackRate + this.keyScaleAdjust) : 0);
                    this.envPhase = ENV_PHASE_ATTACK;
                    break;
                }
                // fall through to decay
            // falls through
            case ENV_PHASE_DECAY:
                if (this.sustainLevel) {
                    this.envLevel = 0;
                    this.envLevelNextThreshold = this.sustainLevel * 8;
                    this._configureEnvRate(this.decayRate ? _clampLow(63, this.decayRate + this.keyScaleAdjust) : 0);
                    this.envPhase = ENV_PHASE_DECAY;
                    break;
                }
                // fall through to sustain
            // falls through
            case ENV_PHASE_SUSTAIN:
                if (this.ssgMode && (this.sustainLevel >= 124)) {
                    this.envLevel = this.envLevelNextThreshold = 0x400;
                    this.envPhase = ENV_PHASE_RELEASE;
                } else {
                    this.envLevel = this.sustainLevel * 8;
                    this.envLevelNextThreshold = 0x400;
                    this._configureEnvRate(this.sustainRate ? _clampLow(63, this.sustainRate + this.keyScaleAdjust) : 0);
                    this.envPhase = ENV_PHASE_SUSTAIN;
                    break;
                }
                // fall through to release
            // falls through
            case ENV_PHASE_RELEASE:
                if (this.envPhase === ENV_PHASE_ATTACK ||
                    (this.envLevel < (this.ssgMode ? 0x400 : ENV_QUIET_LEVEL))) {
                    if (this.ssgMode) {
                        if (this.ssgMode & 0x10) {
                            this.envLevel = 1023 - this.envLevel;
                        }
                        this.ssgMode &= ~0x10;
                    }
                    this.envLevelNextThreshold = 0x400;
                    this._configureEnvRate(_clampLow(63, this.releaseRate + this.keyScaleAdjust));
                    this.envPhase = ENV_PHASE_RELEASE;
                    break;
                } else if (this.ssgMode) {
                    if ((this.ssgMode & 3) !== 2) {
                        this.envLevel = ENV_QUIET_LEVEL;
                        this.envLevelNextThreshold = ENV_QUIET_LEVEL;
                    }
                    if (this.ssgMode & 1) {
                        // one shot
                        this._configureEnvRate(0);
                        this.envPhase = ENV_PHASE_HOLD;
                    } else {
                        // repeat
                        this._configureEnvRate(this.attackRate ? _clampLow(63, this.attackRate + this.keyScaleAdjust) : 0);
                        this.envPhase = ENV_PHASE_ATTACK;
                    }
                    if (this.ssgMode & 2) {
                        // alternate
                        this.ssgMode ^= 0x10;
                        if (!(this.ssgMode & 1)) {
                            this.envLevel = this.envLevelNextThreshold = 0;
                        }
                    }
                    break;
                }
                // fall through to off
            // falls through
            case ENV_PHASE_OFF:
            default:
                this.envLevel = ENV_QUIET_LEVEL;
                this.envLevelNextThreshold = ENV_QUIET_LEVEL;
                this._refreshEnvOutput();
                this._configureEnvRate(0);
                this.envPhase = ENV_PHASE_OFF;
                break;
        }
    }
}

// ---------------------------------------------------------------------------
// FMChannel: 4-operator FM channel
// ---------------------------------------------------------------------------
class FMChannel {
    constructor() {
        this.op = [new FMOperator(), new FMOperator(), new FMOperator(), new FMOperator()];
        this.fb = 31;   // feedback shift (from FEEDBACK_SHIFT_TABLE)
        this.algorithm = 0;
        this.chip = null;
        this.phaseLfoData = lfoPhaseTable[0][0];
        this.channelMuted = false;
    }

    assignChip(chip) {
        this.chip = chip;
        for (let i = 0; i < 4; i++) this.op[i].assignChip(chip);
    }

    setSynthVariant(variant) {
        for (let i = 0; i < 4; i++) this.op[i].synthVariant = variant;
    }

    writeFeedback(feedback) {
        this.fb = FEEDBACK_SHIFT_TABLE[feedback];
    }

    setFrequency(f) {
        for (let i = 0; i < 4; i++) this.op[i].setFrequency(f);
    }

    writeLFOSens(ms) {
        for (let i = 0; i < 4; i++) this.op[i].writeLFOSens(ms);
    }

    muteChannel(m) {
        for (let i = 0; i < 4; i++) this.op[i].setSilenced(m);
        this.channelMuted = m;
    }

    markDirty() {
        for (let i = 0; i < 4; i++) this.op[i].needsRecalc = true;
    }

    reset() {
        for (let i = 0; i < 4; i++) this.op[i].reset();
    }

    configureAlgorithm(algo) {
        this.op[0].clearFeedback();
        this.algorithm = algo;
    }

    keyControl(key) {
        if (key & 0x1) this.op[0].keyOn(); else this.op[0].keyOff();
        if (key & 0x2) this.op[1].keyOn(); else this.op[1].keyOff();
        if (key & 0x4) this.op[2].keyOn(); else this.op[2].keyOff();
        if (key & 0x8) this.op[3].keyOn(); else this.op[3].keyOff();
    }

    prepareForRender() {
        this.op[0].recalculate();
        this.op[1].recalculate();
        this.op[2].recalculate();
        this.op[3].recalculate();

        this.phaseLfoData = lfoPhaseTable[this.op[0].synthVariant][this.op[0].lfoSensitivity & 7];
        const active = (this.op[0].isActive() | this.op[1].isActive() |
                     this.op[2].isActive() | this.op[3].isActive()) ? 1 : 0;
        const lfo = (this.op[0].lfoSensitivity &
            (this.op[0].ampModEnabled | this.op[1].ampModEnabled |
             this.op[2].ampModEnabled | this.op[3].ampModEnabled ? 0x37 : 7)) ? 2 : 0;
        return active | lfo;
    }

    // Compute one sample: no LFO
    compute() {
        let r;
        const op = this.op;
        const fb = this.fb;
        switch (this.algorithm) {
            case 0:
                op[2].generateSample(op[1].currentOutput());
                op[1].generateSample(op[0].currentOutput());
                r = op[3].generateSample(op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 1:
                op[2].generateSample(op[0].currentOutput() + op[1].currentOutput());
                op[1].generateSample(0);
                r = op[3].generateSample(op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 2:
                op[2].generateSample(op[1].currentOutput());
                op[1].generateSample(0);
                r = op[3].generateSample(op[0].currentOutput() + op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 3:
                op[2].generateSample(0);
                op[1].generateSample(op[0].currentOutput());
                r = op[3].generateSample(op[1].currentOutput() + op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 4:
                op[2].generateSample(0);
                r = op[1].generateSample(op[0].currentOutput());
                r += op[3].generateSample(op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 5:
                r  = op[2].generateSample(op[0].currentOutput());
                r += op[1].generateSample(op[0].currentOutput());
                r += op[3].generateSample(op[0].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 6:
                r  = op[2].generateSample(0);
                r += op[1].generateSample(op[0].currentOutput());
                r += op[3].generateSample(0);
                op[0].generateFeedback(fb);
                break;
            case 7:
                r  = op[2].generateSample(0);
                r += op[1].generateSample(0);
                r += op[3].generateSample(0);
                r += op[0].generateFeedback(fb);
                break;
        }
        return r;
    }

    // Compute one sample: with LFO
    computeWithLFO() {
        this.chip.setPhaseModValue(this.phaseLfoData[this.chip.getPhaseModLevel()]);

        let r;
        const op = this.op;
        const fb = this.fb;
        switch (this.algorithm) {
            case 0:
                op[2].generateSampleLFO(op[1].currentOutput());
                op[1].generateSampleLFO(op[0].currentOutput());
                r = op[3].generateSampleLFO(op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 1:
                op[2].generateSampleLFO(op[0].currentOutput() + op[1].currentOutput());
                op[1].generateSampleLFO(0);
                r = op[3].generateSampleLFO(op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 2:
                op[2].generateSampleLFO(op[1].currentOutput());
                op[1].generateSampleLFO(0);
                r = op[3].generateSampleLFO(op[0].currentOutput() + op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 3:
                op[2].generateSampleLFO(0);
                op[1].generateSampleLFO(op[0].currentOutput());
                r = op[3].generateSampleLFO(op[1].currentOutput() + op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 4:
                op[2].generateSampleLFO(0);
                r = op[1].generateSampleLFO(op[0].currentOutput());
                r += op[3].generateSampleLFO(op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 5:
                r  = op[2].generateSampleLFO(op[0].currentOutput());
                r += op[1].generateSampleLFO(op[0].currentOutput());
                r += op[3].generateSampleLFO(op[0].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 6:
                r  = op[2].generateSampleLFO(0);
                r += op[1].generateSampleLFO(op[0].currentOutput());
                r += op[3].generateSampleLFO(0);
                op[0].generateFeedbackLFO(fb);
                break;
            case 7:
                r  = op[2].generateSampleLFO(0);
                r += op[1].generateSampleLFO(0);
                r += op[3].generateSampleLFO(0);
                r += op[0].generateFeedbackLFO(fb);
                break;
        }
        return r;
    }
}

// ---------------------------------------------------------------------------
// Linear interpolation helper
// ---------------------------------------------------------------------------
function linearInterpolate(table, index) {
    const i = Math.floor(index);
    const frac = index - i;
    if (i >= table.length - 1) return table[table.length - 1];
    return table[i] + (table[i + 1] - table[i]) * frac;
}

// ---------------------------------------------------------------------------
// Clamp helper
// ---------------------------------------------------------------------------
function clampRange(v, hi, lo) {
    return v > hi ? hi : v < lo ? lo : v;
}

// =============================================================================
// OPN Class (YM2203)
// =============================================================================

export class OPN {
    constructor() {
        this._chip = new SynthChip();

        // FM channels
        this._ch = [new FMChannel(), new FMChannel(), new FMChannel()];
        for (let i = 0; i < 3; i++) {
            this._ch[i].assignChip(this._chip);
        }
        this._csmch = this._ch[2];

        // F-number registers
        this._fnum = [0, 0, 0];
        this._fnum2 = new Uint8Array(6); // [0..2] = normal, [3..5] = ch3 special high
        this._fnum3 = [0, 0, 0];

        // State
        this._status = 0;
        this._regtc = 0;        // Timer control register ($27) bits 6-7
        this._prescale = 0;     // Current prescaler index

        // Clock/rate
        this._clock = MASTER_CLOCK;
        this._rate = 0;
        this._psgrate = SAMPLE_RATE;

        // FM volume
        this._fmvolume = 0;

        // Interpolation
        this._interpolation = false;
        this._mpratio = 0;
        this._mixdelta = 0;
        this._mb = [0, 0, 0, 0];

        // Ring buffer for per-channel output
        this._rcnt = 0;
        this._rbuf = [
            new Int32Array(512),
            new Int32Array(512),
            new Int32Array(512),
        ];

        // Timers — separate "loaded" vs "active" periods to match real hardware.
        // On the YM2203, writing to timer registers changes the reload value
        // but the current countdown continues until overflow. Only on overflow
        // does the new period take effect.
        this._timerA = 0;
        this._timerB = 0;
        this._timerACount = 0;
        this._timerBCount = 0;
        this._timerAPeriod = 0;       // Active period (used for current count cycle)
        this._timerBPeriod = 0;
        this._timerAEn = false;
        this._timerBEn = false;
        this._timerAIRQ = false;
        this._timerBIRQ = false;

        // Timer clock ratio: OPN_clock / CPU_clock.
        // FM-7: 1.0 (OPN and CPU share same clock domain in emulation).
        // FM77AV: 1.2288 (OPN at 2.4576 MHz, CPU at 2 MHz).
        this._timerClockRatio = 1.0;

        // Audio output
        this._audioCtx = null;
        this._scriptNode = null;
        this._gainNode = null;
        this._volume = 0.5;
        this._ringBuf = new Float32Array(BUF_SIZE);
        this._wPos = 0;
        this._rPos = 0;

        // CPU cycles accumulator — step() receives CPU cycles (2 MHz),
        // not OPN clock cycles, so use CPU clock for sample timing.
        this._cyclesPerSample = 2000000 / SAMPLE_RATE;  // ≈ 41.67
        this._fmAccum = 0;

        // Address latch (for external register write protocol)
        this._addrLatch = 0;

        // Register file for readback
        this._regs = new Uint8Array(256);

        // Init
        this._initialize(MASTER_CLOCK, SAMPLE_RATE);
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    _initialize(c, r) {
        this._clock = c;
        this._psgrate = r;
        this._configureRate(c, r, false);
        this.reset();
        this._setFMVolume(0);
    }

    /**
     * Set FM77AV mode for OPN timer clock conversion.
     * On FM77AV the YM2203 external clock (2.4576 MHz) differs from
     * the CPU clock (2 MHz), requiring timer count scaling.
     */
    setAVMode(isAV) {
        this._timerClockRatio = isAV ? OPN_CPU_RATIO_AV : 1.0;
    }

    _configureRate(c, r, ip) {
        this._interpolation = ip;
        this._clock = c;
        this._psgrate = r;
        this._recalcFrequencies();
        this._mb[0] = this._mb[1] = this._mb[2] = this._mb[3] = 0;
        this._mixdelta = 0;
    }

    _recalcFrequencies() {
        const p = this._prescale;
        this._prescale = -1;
        this._configurePrescaler(p);
    }

    _configurePrescaler(p) {
        const dividers = [[6, 4], [3, 2], [2, 1]];
        const lfoRateDivisors = [109, 78, 72, 68, 63, 45, 9, 6];

        if (this._prescale !== p) {
            this._prescale = p;
            const fmclock = Math.floor(this._clock / dividers[p][0] / 12);

            if (this._interpolation) {
                this._rate = fmclock * 2;
                do {
                    this._rate >>= 1;
                    this._mpratio = Math.floor(this._rate * OUTPUT_SCALE / this._psgrate);
                } while (this._mpratio >= OUTPUT_SCALE * 2);
            } else {
                this._rate = this._psgrate;
            }

            // Ratio of FM clock to output rate
            const ratio = Math.floor(((fmclock << CLOCK_RATIO_BITS) + this._rate / 2) / this._rate);
            this._chip.updateRatio(ratio);

            // LFO rate table
            for (let i = 0; i < 8; i++) {
                lfoRateTable[i] = Math.floor((ratio << (1 + 14 - CLOCK_RATIO_BITS)) / lfoRateDivisors[i]);
            }
        }
    }

    _setFMVolume(db) {
        db = _clampLow(db, 20);
        if (db > -192)
            this._fmvolume = Math.floor(16384.0 * Math.pow(10.0, db / 40.0));
        else
            this._fmvolume = 0;
    }

    // =========================================================================
    // Reset
    // =========================================================================

    reset() {
        this._regs.fill(0);
        this._addrLatch = 0;
        this._status = 0;
        this._regtc = 0;

        this._timerA = 0;
        this._timerB = 0;
        this._timerACount = 0;
        this._timerBCount = 0;
        this._timerAPeriod = 0;
        this._timerBPeriod = 0;
        this._timerAEn = false;
        this._timerBEn = false;
        this._timerAIRQ = false;
        this._timerBIRQ = false;

        this._fnum = [0, 0, 0];
        this._fnum2.fill(0);
        this._fnum3 = [0, 0, 0];

        this._mixdelta = 0;
        this._mb = [0, 0, 0, 0];
        this._fmAccum = 0;

        // Reset registers
        this._configurePrescaler(0);
        for (let i = 0x20; i < 0x28; i++) this._writeRegister(i, 0);
        for (let i = 0x30; i < 0xc0; i++) this._writeRegister(i, 0);
        this._ch[0].reset();
        this._ch[1].reset();
        this._ch[2].reset();

        this._rcnt = 0;
        for (let i = 0; i < 3; i++) this._rbuf[i].fill(0);

        this._wPos = 0;
        this._rPos = 0;
        this._ringBuf.fill(0);
    }

    // =========================================================================
    // Register interface (public API)
    // =========================================================================

    writeReg(reg, value) {
        reg &= 0xFF;
        value &= 0xFF;
        this._regs[reg] = value;

        // Timer registers — update reload value (takes effect on next overflow)
        if (reg === 0x24) {
            this._timerA = (this._timerA & 0x03) | (value << 2);
            // Reload period updated but NOT applied to current countdown
            return;
        }
        if (reg === 0x25) {
            this._timerA = (this._timerA & 0x3FC) | (value & 0x03);
            return;
        }
        if (reg === 0x26) {
            this._timerB = value;
            return;
        }
        if (reg === 0x27) {
            const prevAEn = this._timerAEn;
            const prevBEn = this._timerBEn;

            this._timerAEn  = !!(value & 0x01);
            this._timerBEn  = !!(value & 0x02);
            this._timerAIRQ = !!(value & 0x04);
            this._timerBIRQ = !!(value & 0x08);
            if (value & 0x10) this._status &= ~0x01;
            if (value & 0x20) this._status &= ~0x02;

            // On fresh enable: load period and reset count
            if (this._timerAEn && !prevAEn) {
                this._timerAPeriod = 72 * (1024 - this._timerA);
                this._timerACount = 0;
            }
            if (this._timerBEn && !prevBEn) {
                this._timerBPeriod = 1152 * (256 - this._timerB);
                this._timerBCount = 0;
            }

            // Ch3 mode + CSM stored in regtc
            this._regtc = (value & 0xc0);
            return;
        }

        // Forward to internal register handler
        this._writeRegister(reg, value);
    }

    _writeRegister(addr, data) {
        const c = addr & 3;

        switch (addr) {
            // PSG registers (0x00-0x0F) - handled externally
            case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
            case 8: case 9: case 10: case 11: case 12: case 13: case 14: case 15:
                break;

            case 0x24: case 0x25: case 0x26:
                break;

            case 0x27:
                this._regtc = data & 0xc0;
                break;

            case 0x28: {
                // Key On/Off
                if ((data & 3) < 3)
                    this._ch[data & 3].keyControl(data >> 4);
                break;
            }

            case 0x2d: case 0x2e: case 0x2f:
                this._configurePrescaler(addr - 0x2d);
                break;

            // F-Number low
            case 0xa0: case 0xa1: case 0xa2:
                this._fnum[c] = data + this._fnum2[c] * 0x100;
                break;

            // F-Number high (latch)
            case 0xa4: case 0xa5: case 0xa6:
                this._fnum2[c] = data;
                break;

            // Ch3 special F-Number low
            case 0xa8: case 0xa9: case 0xaa:
                this._fnum3[c] = data + this._fnum2[c + 3] * 0x100;
                break;

            // Ch3 special F-Number high (latch)
            case 0xac: case 0xad: case 0xae:
                this._fnum2[c + 3] = data;
                break;

            // FB/Algorithm
            case 0xb0: case 0xb1: case 0xb2:
                this._ch[c].writeFeedback((data >> 3) & 7);
                this._ch[c].configureAlgorithm(data & 7);
                break;

            case 0xff:
                this._handleCSMTrigger();
                break;

            default:
                if (c < 3) {
                    if ((addr & 0xf0) === 0x60)
                        data &= 0x1f;
                    this._applyParameter(this._ch[c], addr, data);
                }
                break;
        }
    }

    // Set per-operator parameters
    _applyParameter(ch, addr, data) {
        if ((addr & 3) >= 3) return;

        const slot = REG_TO_OP_MAP[(addr >> 2) & 3];
        const op = ch.op[slot];

        switch ((addr >> 4) & 15) {
            case 3: // 30-3E DT/MULTI
                op.writeDT((data >> 4) & 0x07);
                op.writeMUL(data & 0x0f);
                break;

            case 4: // 40-4E TL
                op.writeTL(data & 0x7f, (this._regtc & 0x80) && (this._csmch === ch));
                break;

            case 5: // 50-5E KS/AR
                op.writeKS((data >> 6) & 3);
                op.writeAR((data & 0x1f) * 2);
                break;

            case 6: // 60-6E DR/AMON
                op.writeDR((data & 0x1f) * 2);
                op.writeAMON(!!(data & 0x80));
                break;

            case 7: // 70-7E SR
                op.writeSR((data & 0x1f) * 2);
                break;

            case 8: // 80-8E SL/RR
                op.writeSL(SUSTAIN_LEVEL_TABLE[(data >> 4) & 15]);
                op.writeRR((data & 0x0f) * 4 + 2);
                break;

            case 9: // 90-9E SSG-EC
                op.writeSSGEG(data & 0x0f);
                break;
        }
    }

    // CSM Timer A callback
    _handleCSMTrigger() {
        if (this._regtc & 0x80) {
            this._csmch.keyControl(0x00);
            this._csmch.keyControl(0x0f);
        }
    }

    readStatus() {
        return this._status & 0x03;
    }

    get timerAFlag() { return !!(this._status & 0x01); }
    get timerBFlag() { return !!(this._status & 0x02); }

    // =========================================================================
    // Status flag management
    // =========================================================================

    _setStatus(bits) {
        if (!(this._status & bits)) {
            this._status |= bits;
        }
    }

    _resetStatus(bit) {
        this._status &= ~bit;
    }

    // =========================================================================
    // FM sample rendering
    // =========================================================================

    _scaleSample(s) {
        return (clampRange(s, 0x7fff, -0x8000) * this._fmvolume) >> 14;
    }

    _renderSamples(buffer, nsamples) {
        const ch = this._ch;

        // Set F-Numbers
        ch[0].setFrequency(this._fnum[0]);
        ch[1].setFrequency(this._fnum[1]);
        if (!(this._regtc & 0xc0)) {
            ch[2].setFrequency(this._fnum[2]);
        } else {
            // Ch3 special mode: per-operator frequencies
            ch[2].op[0].setFrequency(this._fnum3[1]);
            ch[2].op[1].setFrequency(this._fnum3[2]);
            ch[2].op[2].setFrequency(this._fnum3[0]);
            ch[2].op[3].setFrequency(this._fnum[2]);
        }

        const actch = (((ch[2].prepareForRender() << 2) | ch[1].prepareForRender()) << 2) | ch[0].prepareForRender();

        if (actch & 0x15) {
            for (let n = 0; n < nsamples; n++) {
                let x = 0, y = 0, z = 0;
                if (actch & 0x01) x = ch[0].compute();
                if (actch & 0x04) y = ch[1].compute();
                if (actch & 0x10) z = ch[2].compute();

                const s = x + y + z;
                this._rcnt = (this._rcnt + 1) & 0x1ff;
                this._rbuf[0][this._rcnt] = x << (OUTPUT_SHIFT + 3);
                this._rbuf[1][this._rcnt] = y << (OUTPUT_SHIFT + 3);
                this._rbuf[2][this._rcnt] = z << (OUTPUT_SHIFT + 3);

                buffer[n] += this._scaleSample(s);
            }
        }
    }

    // =========================================================================
    // Timers
    // =========================================================================

    _advanceTimers(cpuCycles) {
        // YM2203 Timer A/B periods in OPN external clock cycles.
        // Timer A: 72 × (1024-N) OPN clocks  (YM2203 internal /72 prescaler)
        // Timer B: 1152 × (256-N) OPN clocks  (YM2203 internal /1152 prescaler)
        // OPN external clock (2.4576 MHz) is faster than CPU (2 MHz),
        // so convert CPU cycles → OPN cycles before accumulating.
        // Cached active periods: new register values take effect on overflow.
        const opnCycles = cpuCycles * this._timerClockRatio;

        if (this._timerAEn) {
            const periodA = this._timerAPeriod;
            if (periodA > 0) {
                this._timerACount += opnCycles;
                while (this._timerACount >= periodA) {
                    this._timerACount -= periodA;
                    if (this._timerAIRQ) this._status |= 0x01;
                    // Reload: apply any pending timer value change
                    this._timerAPeriod = 72 * (1024 - this._timerA);
                }
            }
        }

        if (this._timerBEn) {
            const periodB = this._timerBPeriod;
            if (periodB > 0) {
                this._timerBCount += opnCycles;
                while (this._timerBCount >= periodB) {
                    this._timerBCount -= periodB;
                    if (this._timerBIRQ) this._status |= 0x02;
                    this._timerBPeriod = 1152 * (256 - this._timerB);
                }
            }
        }
    }

    // =========================================================================
    // Step -- called from emulation loop
    // =========================================================================

    step(cpuCycles) {
        this._advanceTimers(cpuCycles);

        if (!this._audioCtx) return;

        this._fmAccum += cpuCycles;
        const cps = this._cyclesPerSample;

        while (this._fmAccum >= cps) {
            this._fmAccum -= cps;

            // Generate one sample
            const buf = [0];
            this._renderSamples(buf, 1);

            // Convert to float (-1..1 range)
            const sample = buf[0] / 32768.0;

            this._ringBuf[this._wPos] = sample;
            this._wPos = (this._wPos + 1) & BUF_MASK;
        }
    }

    // =========================================================================
    // Web Audio output
    // =========================================================================

    startAudio() {
        if (this._audioCtx) return;

        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            this._audioCtx = new AC({ sampleRate: SAMPLE_RATE });

            this._gainNode = this._audioCtx.createGain();
            this._gainNode.gain.value = this._volume;
            this._gainNode.connect(this._audioCtx.destination);

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
                        buf[i] = 0;
                    }
                }
                this._rPos = rp;
            };
            this._scriptNode.connect(this._gainNode);

            console.log('OPN: audio started (' + this._audioCtx.sampleRate + ' Hz)');
        } catch (e) {
            console.warn('OPN: audio init failed:', e);
        }
    }

    resumeAudio() {
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            this._audioCtx.resume();
        }
    }

    setVolume(v) {
        this._volume = Math.max(0, Math.min(1, v));
        if (this._gainNode) {
            this._gainNode.gain.value = this._volume;
        }
    }

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
