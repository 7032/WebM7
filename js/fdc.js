// =============================================================================
// MB8877 FDC Emulator + D77 Disk Image Parser for FM-7
// =============================================================================

// FDC State Machine
const FDC_STATE = {
    IDLE:               0,
    COMMAND_RECEIVED:    1,
    SEEK_STEPPING:       2,
    SEEK_VERIFY:         3,
    READ_FIND_SECTOR:    4,
    READ_TRANSFER:       5,
    WRITE_FIND_SECTOR:   6,
    WRITE_TRANSFER:      7,
    READ_ADDRESS:        8,
    READ_TRACK:          9,
    WRITE_TRACK:        10,
    COMPLETE:           11,
    RNF_WAIT:           12,  // MB8877 5-index-pulse search before asserting RNF
};

// Command types
const CMD_TYPE = {
    TYPE_I:   1,  // Restore, Seek, Step, Step-In, Step-Out
    TYPE_II:  2,  // Read Sector, Write Sector
    TYPE_III: 3,  // Read Address, Read Track, Write Track
    TYPE_IV:  4,  // Force Interrupt
};

// Status register bits
const STATUS = {
    BUSY:           0x01,
    DRQ:            0x02,   // Type II/III: Data Request
    INDEX:          0x02,   // Type I: Index pulse
    LOST_DATA:      0x04,   // Type II/III: Lost data
    TRACK0:         0x04,   // Type I: Track 0
    CRC_ERROR:      0x08,
    SEEK_ERROR:     0x10,   // Type I: Seek error
    RNF:            0x10,   // Type II/III: Record Not Found
    HEAD_ENGAGED:   0x20,   // Type I: Head engaged
    RECORD_TYPE:    0x20,   // Type II/III: Record type (deleted mark)
    WRITE_PROTECT:  0x40,
    NOT_READY:      0x80,
};

// Step rates in CPU cycles (accelerated).
// Real MB8877 rates are 6/12/20/30 ms, but emulating real-time delays
// causes SEEK to span multiple VBlank periods. Games that call the boot
// ROM with IRQ enabled (timer IRQ vector pointing to game code) will be
// preempted mid-SEEK, never returning to the boot ROM polling loop.
// Accelerated rates keep SEEK fast enough to avoid this class of bugs
// while still producing a visible BUSY period for polling loops.
const STEP_RATES = [200, 400, 600, 1000];

// D77 header size
const D77_HEADER_SIZE = 0x2B0;
const D77_TRACK_TABLE_OFFSET = 0x20;
const D77_MAX_TRACKS = 164;
const D77_SECTOR_HEADER_SIZE = 0x10;

// Sector size lookup by N value
const SECTOR_SIZES = [128, 256, 512, 1024];

// 2D raw image constants
const RAW_2D_SIZE = 327680;   // 40 tracks * 16 sectors * 256 bytes * 2 sides
const RAW_2DD_SIZE = 655360;  // 80 tracks * 16 sectors * 256 bytes * 2 sides
const RAW_1S_SIZE = 163840;   // 40 tracks * 16 sectors * 256 bytes * 1 side


// =============================================================================
// D77 Disk Image Parser
// =============================================================================

class D77Disk {
    constructor() {
        this.name = '';
        this.writeProtect = false;
        this.mediaType = 0;
        this.diskSize = 0;
        this.numTracks = 0;
        this.numSides = 1;
        // sectors[track][side][sectorNum] = { c, h, r, n, data, size, density, deleted, status }
        this.sectors = {};
        this.loaded = false;
    }

    /**
     * Parse a D77 format disk image.
     * @param {ArrayBuffer} buffer - The raw D77 file data
     * @returns {boolean} true if parsing succeeded
     */
    parseD77(buffer) {
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        if (buffer.byteLength < D77_HEADER_SIZE) {
            console.error('FDC: D77 image too small for header');
            return false;
        }

        // Parse disk name (17 bytes, null-terminated Shift-JIS)
        let nameBytes = [];
        for (let i = 0; i < 17; i++) {
            const ch = bytes[i];
            if (ch === 0) break;
            nameBytes.push(ch);
        }
        this.name = String.fromCharCode(...nameBytes);

        // Write protect flag
        this.writeProtect = (bytes[0x1A] !== 0);

        // Media type
        this.mediaType = bytes[0x1B];

        // Disk size (32-bit LE)
        this.diskSize = view.getUint32(0x1C, true);

        // Parse track offset table
        const trackOffsets = [];
        let maxTrackIndex = -1;
        for (let i = 0; i < D77_MAX_TRACKS; i++) {
            const offset = view.getUint32(D77_TRACK_TABLE_OFFSET + i * 4, true);
            trackOffsets.push(offset);
            if (offset !== 0) {
                maxTrackIndex = i;
            }
        }

        if (maxTrackIndex < 0) {
            console.error('FDC: D77 image has no tracks');
            return false;
        }

        // Determine track/side layout
        // D77 track table: index = track * numSides + side
        // Detect number of sides by checking if odd entries are used
        this.numSides = 1;
        for (let i = 0; i <= maxTrackIndex; i++) {
            if (i % 2 === 1 && trackOffsets[i] !== 0) {
                this.numSides = 2;
                break;
            }
        }
        this.numTracks = Math.floor((maxTrackIndex + this.numSides) / this.numSides);

        this.sectors = {};

        // Parse each track
        for (let idx = 0; idx <= maxTrackIndex; idx++) {
            const trackOffset = trackOffsets[idx];
            if (trackOffset === 0) continue;

            const track = Math.floor(idx / this.numSides);
            const side = idx % this.numSides;

            if (!this.sectors[track]) this.sectors[track] = {};
            if (!this.sectors[track][side]) this.sectors[track][side] = {};

            let pos = trackOffset;
            if (pos >= buffer.byteLength) continue;

            // Read the first sector header to get number of sectors in this track
            if (pos + D77_SECTOR_HEADER_SIZE > buffer.byteLength) continue;

            const numSectors = view.getUint16(pos + 0x04, true);

            for (let s = 0; s < numSectors; s++) {
                if (pos + D77_SECTOR_HEADER_SIZE > buffer.byteLength) break;

                const c = bytes[pos + 0x00];       // Cylinder
                const h = bytes[pos + 0x01];       // Head
                const r = bytes[pos + 0x02];       // Sector number (R)
                const n = bytes[pos + 0x03];       // Size code (N)
                // numSectors at pos+0x04 already read
                const density = bytes[pos + 0x06];
                const deleted = bytes[pos + 0x07];
                const status = bytes[pos + 0x08];
                const dataSize = view.getUint16(pos + 0x0E, true);

                pos += D77_SECTOR_HEADER_SIZE;

                if (pos + dataSize > buffer.byteLength) {
                    console.error(`FDC: D77 sector data overflows at track ${track} side ${side} sector ${r}`);
                    break;
                }

                const data = new Uint8Array(buffer, pos, dataSize);
                // Copy the data so it's independent of the original buffer
                const dataCopy = new Uint8Array(dataSize);
                dataCopy.set(data);

                this.sectors[track][side][r] = {
                    c: c,
                    h: h,
                    r: r,
                    n: n,
                    data: dataCopy,
                    size: dataSize,
                    density: density,
                    deleted: (deleted !== 0),
                    status: status,
                };

                pos += dataSize;
            }
        }

        this.loaded = true;

        return true;
    }

    /**
     * Parse a raw 2D/2DD disk image (no header, fixed format).
     * 16 sectors/track, 256 bytes/sector.
     * 327680: 2D double-sided (40 tracks). 655360: 2DD double-sided (80 tracks).
     * 163840: 2D single-sided (40 tracks).
     * @param {ArrayBuffer} buffer - The raw image data
     * @returns {boolean} true if parsing succeeded
     */
    parseRaw2D(buffer) {
        const bytes = new Uint8Array(buffer);
        const size = buffer.byteLength;

        let numSides;
        let numTracks;
        let mediaType;
        let name;
        if (size === RAW_2D_SIZE) {
            numSides = 2; numTracks = 40; mediaType = 0x00; name = 'RAW2D';
        } else if (size === RAW_2DD_SIZE) {
            numSides = 2; numTracks = 80; mediaType = 0x10; name = 'RAW2DD';
        } else if (size === RAW_1S_SIZE) {
            numSides = 1; numTracks = 40; mediaType = 0x00; name = 'RAW2D';
        } else {
            console.error(`FDC: Raw image size ${size} does not match 2D (${RAW_2D_SIZE}), 2DD (${RAW_2DD_SIZE}), or 1S (${RAW_1S_SIZE})`);
            return false;
        }

        this.name = name;
        this.writeProtect = false;
        this.mediaType = mediaType;
        this.diskSize = size;
        this.numTracks = numTracks;
        this.numSides = numSides;
        this.sectors = {};

        const sectorsPerTrack = 16;
        const sectorSize = 256;
        let pos = 0;

        for (let track = 0; track < numTracks; track++) {
            this.sectors[track] = {};
            for (let side = 0; side < numSides; side++) {
                this.sectors[track][side] = {};
                for (let sec = 1; sec <= sectorsPerTrack; sec++) {
                    const dataCopy = new Uint8Array(sectorSize);
                    dataCopy.set(bytes.subarray(pos, pos + sectorSize));

                    this.sectors[track][side][sec] = {
                        c: track,
                        h: side,
                        r: sec,
                        n: 1,       // 256 bytes
                        data: dataCopy,
                        size: sectorSize,
                        density: 0x00, // MFM
                        deleted: false,
                        status: 0x00,
                    };

                    pos += sectorSize;
                }
            }
        }

        this.loaded = true;
        return true;
    }

    /**
     * Get a sector from the disk.
     * @param {number} track - Track number
     * @param {number} side - Side (0 or 1)
     * @param {number} sectorNum - Sector number (usually 1-based)
     * @returns {object|null} Sector object or null if not found
     */
    getSector(track, side, sectorNum) {
        if (!this.sectors[track]) return null;
        if (!this.sectors[track][side]) return null;
        return this.sectors[track][side][sectorNum] || null;
    }

    /**
     * Get list of all sector numbers on a given track/side.
     * @param {number} track
     * @param {number} side
     * @returns {number[]} Array of sector numbers
     */
    getSectorList(track, side) {
        if (!this.sectors[track]) return [];
        if (!this.sectors[track][side]) return [];
        return Object.keys(this.sectors[track][side]).map(Number).sort((a, b) => a - b);
    }
}


// =============================================================================
// MB8877 FDC Emulator
// =============================================================================

export class FDC {
    constructor() {
        // Drives (up to 4): active disk (references entry in diskSlots)
        this.disks = [null, null, null, null];
        // Multi-disk D77 containers: array of D77Disk per drive
        this.diskSlots     = [[], [], [], []];
        this.diskSlotIndex = [0, 0, 0, 0];

        // Currently selected drive and head
        this.currentDrive = 0;
        this.currentSide = 0;
        this.motorOn = false;
        this.densityFlag = false; // bit4 of $FD1C
        this.hdMode = false;     // $FD1E bit6: HD data rate (AV40+)

        // Registers
        this.statusReg = 0;
        this.trackReg = 0;
        this.sectorReg = 0;
        this.dataReg = 0;
        this.commandReg = 0;

        // Physical head position per drive
        this.headPosition = [0, 0, 0, 0];

        // Step direction: +1 = step in (toward center), -1 = step out (toward edge)
        this.stepDirection = 1;

        // State machine
        this.state = FDC_STATE.IDLE;
        this.commandType = 0;

        // Access latch for UI LED (sticky until read and cleared)
        this.accessLatch = false;

        // Command flags parsed from command byte
        this.cmdFlags = {
            h: false,       // Head load (Type I)
            v: false,       // Verify (Type I)
            r: 0,           // Step rate (Type I)
            m: false,       // Multiple sectors (Type II)
            s: false,       // Side compare (Type II)
            e: false,       // Settle delay (Type II/III)
            a0: false,      // Address mark (Type II write)
            u: false,       // Update track (Type I step)
        };

        // Data transfer
        this.dataBuffer = null;     // Uint8Array for current sector
        this.dataIndex = 0;         // Current position in dataBuffer
        this.dataLength = 0;        // Total bytes to transfer

        // Read Address result buffer
        this.idBuffer = null;
        this.idIndex = 0;

        // Timing
        this.delayCycles = 0;       // Remaining delay in CPU cycles (2MHz)
        this.cyclesToDrq = 0;       // Cycles between DRQ assertions

        // Disk rotation phase — tracks the angular position of the spinning
        // disk in CPU cycles.  300 RPM = 200 ms/revolution.  The phase wraps
        // at one full revolution and is advanced by step().  Used to compute
        // realistic rotational latency for sector find operations.
        this._rotationPhase = 0;

        // IRQ / DRQ status
        this.irqFlag = false;
        this.drqFlag = false;

        // Pending DRQ for byte-level transfer timing
        this._pendingDrq = false;
        this._drqTimer = 0;
        this._effectiveBytePeriod = 0;

        // D77 sector status (CRC errors etc.) for READ completion
        this._readStatusExtra = 0;

        // Debug: byte-level capture for data transfer analysis
        this._captureEnabled = false;
        this._captureData = [];  // [{byte, sec, idx}]

        // Callback for IRQ generation
        this.onIRQ = null;

        // Callbacks for FDD sound synthesis (see js/fdd_sound.js).
        // onSeekSound(steps) — Type I command, `steps` = number of physical
        //   track transitions the head will perform (0 if already on target).
        // onHeadLoadSound() — head load click: Type I with h=1, or any Type II/III.
        // Force Interrupt never triggers sound.
        this.onSeekSound     = null;
        this.onHeadLoadSound = null;
        this.onDiskInsert    = null;
        this.onDiskEject     = null;

        // Sector iteration for Read Address
        this.readAddrSectorIndex = 0;

        // ---- Diagnostic logging (OFF by default) ----
        this.logEnabled = false;
        this.log = [];
        this._logCycle = 0;              // Master cycle counter (monotonic)
        this._logDrqPrev = false;
        this._logIrqPrev = false;
        this._logBusyPrev = false;
        this._logBusyStart = 0;
        this._logCmdStart = 0;
        this._logCmdName = '';
        this._logCmdByte = 0;
        this._logByteCount = 0;          // Bytes transferred in current sector op
        this._logTotalBytes = 0;         // Bytes transferred in current multi-op
    }

    // =========================================================================
    // Logging helpers
    // =========================================================================

    _logCmdNameOf(cmd) {
        const h = cmd & 0xF0;
        if (h === 0x00) return 'RESTORE';
        if (h === 0x10) return 'SEEK';
        if (h === 0x20 || h === 0x30) return 'STEP';
        if (h === 0x40 || h === 0x50) return 'STEP_IN';
        if (h === 0x60 || h === 0x70) return 'STEP_OUT';
        if (h === 0x80) return 'READ_SEC';
        if (h === 0x90) return 'READ_MULTI';
        if (h === 0xA0) return 'WRITE_SEC';
        if (h === 0xB0) return 'WRITE_MULTI';
        if (h === 0xC0) return 'READ_ADDR';
        if (h === 0xD0) return 'FORCE_INT';
        if (h === 0xE0) return 'READ_TRACK';
        if (h === 0xF0) return 'WRITE_TRACK';
        return '???';
    }

    _logPush(entry) {
        if (!this.logEnabled) return;
        entry.cyc = this._logCycle;
        this.log.push(entry);
    }

    /** Detect and log DRQ/IRQ/BUSY edges since last call. */
    _logEdges() {
        if (!this.logEnabled) return;
        const drq = this.drqFlag;
        const irq = this.irqFlag;
        const busy = (this.statusReg & STATUS.BUSY) !== 0;
        if (drq !== this._logDrqPrev) {
            this.log.push({ cyc: this._logCycle, t: drq ? 'DRQ+' : 'DRQ-' });
            this._logDrqPrev = drq;
        }
        if (irq !== this._logIrqPrev) {
            this.log.push({ cyc: this._logCycle, t: irq ? 'IRQ+' : 'IRQ-' });
            this._logIrqPrev = irq;
        }
        if (busy !== this._logBusyPrev) {
            if (busy) {
                this._logBusyStart = this._logCycle;
                this.log.push({ cyc: this._logCycle, t: 'BUSY+' });
            } else {
                const dur = this._logCycle - this._logBusyStart;
                this.log.push({
                    cyc: this._logCycle, t: 'BUSY-',
                    durCyc: dur, durUs: +(dur / 2).toFixed(1),
                });
            }
            this._logBusyPrev = busy;
        }
    }

    /** Clear log and reset cycle counter. */
    clearLog() {
        this.log = [];
        this._logCycle = 0;
        this._logDrqPrev = this.drqFlag;
        this._logIrqPrev = this.irqFlag;
        this._logBusyPrev = (this.statusReg & STATUS.BUSY) !== 0;
        this._logBusyStart = 0;
        this._logByteCount = 0;
        this._logTotalBytes = 0;
    }

    /**
     * Format log as plain text, one event per line.
     * @param {Object} [opts]
     * @param {boolean} [opts.compress=true] Collapse consecutive identical
     *   events (same type + same details) into one line with ×N count.
     *   Dramatically shrinks $FD1F polling noise.
     * @param {string[]} [opts.skipTypes] Event type names to exclude
     *   (e.g. ['R','W']). Applied before compression.
     * @param {string[]} [opts.includeTypes] If set, only these event types
     *   are emitted (whitelist, takes precedence over skipTypes).
     * @param {string[]} [opts.skipReg] Register names to exclude from
     *   R/W events (e.g. ['IRQDRQ']). Non-R/W events are untouched.
     * @param {string[]} [opts.includeReg] If set, only R/W events whose
     *   reg matches are emitted (whitelist, takes precedence over skipReg).
     */
    dumpLogText(opts = {}) {
        const compress = opts.compress !== false;
        const skipTypes  = new Set(opts.skipTypes    || []);
        const inclTypes  = opts.includeTypes ? new Set(opts.includeTypes) : null;
        const skipReg    = new Set(opts.skipReg      || []);
        const inclReg    = opts.includeReg    ? new Set(opts.includeReg)    : null;
        const lines = [];
        lines.push('# DevM7 FDC log');
        lines.push('# cyc = cycles @ 2MHz (divide by 2 for µs)');
        lines.push(`# compress=${compress}`);
        if (inclTypes) lines.push(`# includeTypes=${[...inclTypes].join(',')}`);
        else if (skipTypes.size) lines.push(`# skipTypes=${[...skipTypes].join(',')}`);
        if (inclReg) lines.push(`# includeReg=${[...inclReg].join(',')}`);
        else if (skipReg.size) lines.push(`# skipReg=${[...skipReg].join(',')}`);
        lines.push('# columns: cyc\tevent\tdetails');
        const fmtDetails = (e) => {
            const d = [];
            for (const k of Object.keys(e)) {
                if (k === 'cyc' || k === 't') continue;
                d.push(`${k}=${e[k]}`);
            }
            return d.join(' ');
        };
        const keyOf = (e) => `${e.t || ''}|${fmtDetails(e)}`;
        const isRW = (e) => e.t === 'R' || e.t === 'W';
        const keep = (e) => {
            const t = e.t || '';
            if (inclTypes) { if (!inclTypes.has(t)) return false; }
            else if (skipTypes.has(t)) return false;
            if (isRW(e)) {
                const reg = e.reg || '';
                if (inclReg) { if (!inclReg.has(reg)) return false; }
                else if (skipReg.has(reg)) return false;
            }
            return true;
        };
        const filtered = this.log.filter(keep);
        if (!compress) {
            for (const e of filtered) {
                const parts = [e.cyc.toString(), e.t || ''];
                const d = fmtDetails(e);
                if (d) parts.push(d);
                lines.push(parts.join('\t'));
            }
        } else {
            let i = 0;
            const N = filtered.length;
            while (i < N) {
                const e = filtered[i];
                const k = keyOf(e);
                let j = i + 1;
                while (j < N && keyOf(filtered[j]) === k) j++;
                const run = j - i;
                const parts = [e.cyc.toString(), e.t || ''];
                const d = fmtDetails(e);
                if (d) parts.push(d);
                if (run > 1) {
                    parts.push(`×${run}`);
                    parts.push(`lastCyc=${filtered[j - 1].cyc}`);
                }
                lines.push(parts.join('\t'));
                i = j;
            }
        }
        return lines.join('\n') + '\n';
    }

    /** Trigger browser download of the log as a text file. */
    downloadLog(filename = 'devm7_fdc.log') {
        const text = this.dumpLogText();
        if (typeof Blob === 'undefined' || typeof document === 'undefined') {
            console.log(text);
            return;
        }
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`FDC log saved: ${filename} (${this.log.length} events)`);
    }

    // Timing constants in microseconds (converted to CPU cycles dynamically)
    // 300 RPM = 200ms/revolution, 16 sectors/track
    // Average rotational latency: ~6000µs per sector
    static ROTATE_DELAY_US = 6000;
    // MFM byte transfer delay: 32µs per byte (250kbps DD)
    static BYTE_DELAY_US = 32;
    // Inter-sector gap delay for multi-sector reads/writes
    // Real disk: ~12.5ms between adjacent sectors (200ms / 16 sectors)
    static MULTI_SECTOR_GAP_US = 6000;
    // MB8877 RNF search window: 5 index pulses (5 revolutions at 300rpm = 1s)
    // Real hardware keeps BUSY asserted while scanning sector IDs; only after
    // 5 index pulses without a matching R does it set RNF and raise INTRQ.
    // Some software relies on this timing behavior.
    static RNF_TIMEOUT_US = 1000000;

    // CPU-clock-dependent cycle counts (set by setCPUClock)
    // Defaults match FM-7 clock (1.794 MHz = 1.794 cycles/µs)
    static ROTATE_DELAY = Math.round(6000 * 1.794);       // 10764
    static BYTE_DELAY = Math.round(32 * 1.794);           // 57
    static MULTI_SECTOR_GAP = Math.round(6000 * 1.794);   // 10764
    static RNF_TIMEOUT = Math.round(1000000 * 1.794);     // 1794000
    // Full revolution at 300 RPM = 200 ms
    static REVOLUTION_US = 200000;
    static REVOLUTION_CYCLES = Math.round(200000 * 1.794); // 358800
    // Sectors per track (standard FM-7 2D/2DD format)
    static SECTORS_PER_TRACK = 16;

    /** Update timing constants for actual CPU clock frequency */
    static setCPUClock(hz) {
        const cpm = hz / 1000000;  // cycles per microsecond
        FDC.ROTATE_DELAY = Math.round(FDC.ROTATE_DELAY_US * cpm);
        FDC.BYTE_DELAY = Math.round(FDC.BYTE_DELAY_US * cpm);
        FDC.MULTI_SECTOR_GAP = Math.round(FDC.MULTI_SECTOR_GAP_US * cpm);
        FDC.RNF_TIMEOUT = Math.round(FDC.RNF_TIMEOUT_US * cpm);
        FDC.REVOLUTION_CYCLES = Math.round(FDC.REVOLUTION_US * cpm);
    }

    // =========================================================================
    // Disk Management
    // =========================================================================

    /**
     * Load a disk image into a drive.
     * Automatically detects D77 vs raw 2D format.
     * @param {number} driveNum - Drive number (0-3)
     * @param {ArrayBuffer} arrayBuffer - Disk image data
     * @returns {boolean} true if loaded successfully
     */
    loadDisk(driveNum, arrayBuffer) {
        if (driveNum < 0 || driveNum > 3) {
            console.error(`FDC: Invalid drive number ${driveNum}`);
            return false;
        }

        const slots = [];

        // Try D77 container: walk sequential headers using disk_size @ 0x1C.
        // A multi-disk D77 concatenates N disk images, each with its own header.
        if (arrayBuffer.byteLength >= D77_HEADER_SIZE) {
            const fullView = new DataView(arrayBuffer);
            let pos = 0;
            while (pos + D77_HEADER_SIZE <= arrayBuffer.byteLength) {
                const declaredSize = fullView.getUint32(pos + 0x1C, true);
                if (declaredSize < D77_HEADER_SIZE) break;
                if (pos + declaredSize > arrayBuffer.byteLength) break;
                const slice = arrayBuffer.slice(pos, pos + declaredSize);
                const d = new D77Disk();
                if (!d.parseD77(slice)) break;
                slots.push(d);
                pos += declaredSize;
            }
            // Fully consumed → valid D77 (single or multi-disk)
            if (slots.length > 0 && pos !== arrayBuffer.byteLength) {
                // Partial parse: reject so fallback paths can try
                slots.length = 0;
            }
        }

        // Fallback: raw 2D
        if (slots.length === 0) {
            const d = new D77Disk();
            if (d.parseRaw2D(arrayBuffer)) slots.push(d);
        }

        if (slots.length === 0) {
            console.error(`FDC: Failed to load disk in drive ${driveNum}`);
            return false;
        }

        this.diskSlots[driveNum] = slots;
        this.diskSlotIndex[driveNum] = 0;
        this.disks[driveNum] = slots[0];

        if (slots.length > 1) {
            console.log(`FDC: Drive ${driveNum}: Multi-disk D77 container, ${slots.length} disks: [${slots.map(s => `"${s.name}"`).join(', ')}]`);
        } else {
            const d = slots[0];
            console.log(`FDC: Drive ${driveNum}: Disk loaded - "${d.name}", ${d.numTracks} tracks, ${d.numSides} side(s)`);
        }
        if (this.onDiskInsert) this.onDiskInsert(driveNum);
        return true;
    }

    /**
     * Select an alternate disk from a multi-disk D77 container.
     * @param {number} driveNum
     * @param {number} diskIdx - 0-based index into diskSlots
     * @returns {boolean} true if switched
     */
    selectDisk(driveNum, diskIdx) {
        if (driveNum < 0 || driveNum > 3) return false;
        const slots = this.diskSlots[driveNum];
        if (!slots || diskIdx < 0 || diskIdx >= slots.length) return false;
        this.diskSlotIndex[driveNum] = diskIdx;
        this.disks[driveNum] = slots[diskIdx];
        if (this.onDiskInsert) this.onDiskInsert(driveNum);
        return true;
    }

    /**
     * Get disk names in the multi-disk container for a drive.
     * @param {number} driveNum
     * @returns {{names: string[], index: number}}
     */
    getDiskList(driveNum) {
        const slots = this.diskSlots[driveNum] || [];
        return {
            names: slots.map(d => d.name || ''),
            index: this.diskSlotIndex[driveNum] || 0,
        };
    }

    /**
     * Eject disk from a drive.
     * @param {number} driveNum
     */
    ejectDisk(driveNum) {
        if (driveNum >= 0 && driveNum <= 3) {
            const hadDisk = !!this.disks[driveNum];
            this.disks[driveNum] = null;
            this.diskSlots[driveNum] = [];
            this.diskSlotIndex[driveNum] = 0;
            if (hadDisk && this.onDiskEject) this.onDiskEject(driveNum);
        }
    }

    /**
     * Get the currently selected disk object.
     * @returns {D77Disk|null}
     */
    get currentDisk() {
        return this.disks[this.currentDrive];
    }

    // =========================================================================
    // I/O Port Interface
    // =========================================================================

    /**
     * Read from FDC I/O port.
     * @param {number} addr - Address ($FD18-$FD1F)
     * @returns {number} Byte value
     */
    readIO(addr) {
        let value = 0xFF;
        let extra = null;
        switch (addr) {
            case 0xFD18: // Status Register
                // Reading status clears IRQ
                this.irqFlag = false;
                value = this.statusReg;
                break;

            case 0xFD19: // Track Register
                value = this.trackReg & 0xFF;
                break;

            case 0xFD1A: // Sector Register
                value = this.sectorReg & 0xFF;
                break;

            case 0xFD1B: // Data Register
                // If DRQ is set, reading data clears it and advances transfer
                if (this.drqFlag) {
                    value = this.dataReg;
                    const elapsedSinceDrq = this._drqAge || 0;
                    this.drqFlag = false;
                    this.statusReg &= ~STATUS.DRQ;
                    if (this._captureEnabled && this.state === FDC_STATE.READ_TRANSFER) {
                        this._captureData.push(value);
                    }
                    if (this.logEnabled) {
                        this._logByteCount++;
                        this._logTotalBytes++;
                        extra = { idx: this._logByteCount };
                    }
                    this._advanceRead(elapsedSinceDrq);
                } else {
                    value = this.dataReg;
                }
                break;

            case 0xFD1C: // Side register readback (sidereg | 0xFE)
                value = this.currentSide | 0xFE;
                break;

            case 0xFD1D: // Drive select readback
                value = (this.currentDrive & 0x03) | (this.motorOn ? 0x80 : 0x00);
                break;

            case 0xFD1F: // DRQ/IRQ status
                // bit 7: DRQ, bit 6: IRQ
                value = (this.drqFlag ? 0x80 : 0x00) | (this.irqFlag ? 0x40 : 0x00);
                break;

            default:
                value = 0xFF;
                break;
        }

        if (this.logEnabled) {
            const name = { 0xFD18: 'STA', 0xFD19: 'TRK', 0xFD1A: 'SEC',
                           0xFD1B: 'DAT', 0xFD1C: 'SID', 0xFD1D: 'DRV',
                           0xFD1F: 'IRQDRQ' }[addr] || ('$' + addr.toString(16));
            const e = { cyc: this._logCycle, t: 'R', reg: name, val: '$' + (value & 0xFF).toString(16).padStart(2, '0') };
            if (extra) Object.assign(e, extra);
            this.log.push(e);
            this._logEdges();
        }
        return value;
    }

    /**
     * Write to FDC I/O port.
     * @param {number} addr - Address ($FD18-$FD1F)
     * @param {number} value - Byte value
     */
    writeIO(addr, value) {
        value &= 0xFF;

        if (this.logEnabled) {
            const name = { 0xFD18: 'CMD', 0xFD19: 'TRK', 0xFD1A: 'SEC',
                           0xFD1B: 'DAT', 0xFD1C: 'SID', 0xFD1D: 'DRV' }[addr]
                         || ('$' + addr.toString(16));
            const e = { cyc: this._logCycle, t: 'W', reg: name, val: '$' + value.toString(16).padStart(2, '0') };
            if (addr === 0xFD18) e.cmd = this._logCmdNameOf(value);
            this.log.push(e);
        }

        switch (addr) {
            case 0xFD18: // Command Register
                // Only update commandReg if command will actually execute
                // (Force Interrupt always executes; others only when not busy)
                if ((value & 0xF0) === 0xD0 || !(this.statusReg & STATUS.BUSY)) {
                    this.commandReg = value;
                }
                this._executeCommand(value);
                break;

            case 0xFD19: // Track Register
                this.trackReg = value;
                break;

            case 0xFD1A: // Sector Register
                this.sectorReg = value;
                break;

            case 0xFD1B: // Data Register
                this.dataReg = value;
                if (this.drqFlag && (this.state === FDC_STATE.WRITE_TRANSFER)) {
                    this.drqFlag = false;
                    this.statusReg &= ~STATUS.DRQ;
                    if (this.logEnabled) {
                        this._logByteCount++;
                        this._logTotalBytes++;
                    }
                    this._advanceWrite();
                }
                break;

            case 0xFD1C: // Head/Side select + density
                this.currentSide = value & 0x01;
                this.densityFlag = (value & 0x10) !== 0;
                break;

            case 0xFD1D: // Drive select + motor
                this.currentDrive = value & 0x03;
                this.motorOn = (value & 0x80) !== 0;
                break;

            case 0xFD1E: // Mode register (FM77AV40: density/rate control)
                // bit 6: HD data rate select (1=500kbps/2HD, 0=250kbps/2DD)
                this.hdMode = (value & 0x40) !== 0;
                break;

            default:
                break;
        }

        if (this.logEnabled) this._logEdges();
    }

    // =========================================================================
    // State Machine Step
    // =========================================================================

    /**
     * Advance the FDC state machine by the given number of CPU cycles.
     * Call this from the main emulation loop.
     * @param {number} cycles - Number of CPU cycles elapsed (at 2MHz)
     */
    step(cycles) {
        if (this.logEnabled) this._logCycle += cycles;

        // Advance disk rotation phase (continuous, wraps at one revolution)
        this._rotationPhase = (this._rotationPhase + cycles) % FDC.REVOLUTION_CYCLES;

        // Handle pending DRQ (byte transfer timing)
        if (this._pendingDrq) {
            this._drqTimer -= cycles;
            if (this._drqTimer <= 0) {
                this._pendingDrq = false;
                if (this.drqFlag && (this.state === FDC_STATE.READ_TRANSFER)) {
                    // Previous DRQ was not consumed — lost data
                    this.statusReg |= STATUS.LOST_DATA;
                    this._lostDataCount = (this._lostDataCount || 0) + 1;
                    if (this._lostDataCount === 1) {
                        console.warn(`[FDC] LOST_DATA at byte ${this.dataIndex}/${this.dataLength} T${this.headPosition[this.currentDrive]} S${this.currentSide} sec${this.sectorReg}`);
                    }
                }
                this.drqFlag = true;
                this.statusReg |= STATUS.DRQ;
            }
        }

        // DRQ timeout for Type II commands: auto-advance with Lost Data
        if (this.drqFlag && !this._pendingDrq &&
            (this.state === FDC_STATE.READ_TRANSFER || this.state === FDC_STATE.WRITE_TRANSFER)) {
            this._drqAge = (this._drqAge || 0) + cycles;
            if (this._drqAge >= FDC.BYTE_DELAY) {
                this._drqAge = 0;
                this.statusReg |= STATUS.LOST_DATA;
                this._lostDataCount = (this._lostDataCount || 0) + 1;
                if (this._lostDataCount === 1) {
                    console.warn(`[FDC] LOST_DATA timeout at byte ${this.dataIndex}/${this.dataLength} T${this.headPosition[this.currentDrive]} S${this.currentSide} sec${this.sectorReg}`);
                }
                if (this.state === FDC_STATE.READ_TRANSFER) {
                    this._advanceRead();
                } else if (this.state === FDC_STATE.WRITE_TRANSFER) {
                    this.dataReg = 0x00;
                    this.drqFlag = false;
                    this.statusReg &= ~STATUS.DRQ;
                    this._advanceWrite();
                }
            }
        } else {
            this._drqAge = 0;
        }

        if (this.state === FDC_STATE.IDLE || this.state === FDC_STATE.COMPLETE) {
            if (this.logEnabled) this._logEdges();
            return;
        }

        // Count down delay
        if (this.delayCycles > 0) {
            this.delayCycles -= cycles;
            if (this.delayCycles > 0) return;
            // Delay finished, continue with current state
            cycles = -this.delayCycles; // Leftover cycles
            this.delayCycles = 0;
        }

        switch (this.state) {
            case FDC_STATE.COMMAND_RECEIVED:
                // Should not normally stay here; handled in _executeCommand
                break;

            case FDC_STATE.SEEK_STEPPING:
                this._stepSeek();
                break;

            case FDC_STATE.SEEK_VERIFY:
                this._completeTypeI();
                break;

            case FDC_STATE.READ_FIND_SECTOR:
                this._startReadTransfer();
                break;

            case FDC_STATE.READ_TRANSFER:
                // Data transfer is driven by CPU reads from $FD1B
                // If DRQ has been set for too long without read, flag lost data
                // (In practice, step() ensures DRQ timing; the actual data movement
                // happens in readIO for $FD1B.)
                break;

            case FDC_STATE.WRITE_FIND_SECTOR:
                this._startWriteTransfer();
                break;

            case FDC_STATE.WRITE_TRANSFER:
                // Driven by CPU writes to $FD1B
                break;

            case FDC_STATE.READ_ADDRESS:
                this._startReadAddress();
                break;

            case FDC_STATE.READ_TRACK:
                // Not commonly used; stub
                this._completeCommand(0);
                break;

            case FDC_STATE.WRITE_TRACK:
                // Format track; stub
                this._completeCommand(0);
                break;

            case FDC_STATE.RNF_WAIT:
                // 5-index-pulse search window elapsed without matching sector.
                this._completeCommand(STATUS.RNF);
                break;
        }
        if (this.logEnabled) this._logEdges();
    }

    // =========================================================================
    // Command Dispatch
    // =========================================================================

    /**
     * Parse and begin executing an FDC command.
     * @param {number} cmd - Command byte
     * @private
     */
    _executeCommand(cmd) {
        // Clear IRQ on new command
        this.irqFlag = false;

        if (this.logEnabled) {
            this._logCmdByte = cmd;
            this._logCmdName = this._logCmdNameOf(cmd);
            this._logCmdStart = this._logCycle;
            this._logByteCount = 0;
            this._logTotalBytes = 0;
            this.log.push({
                cyc: this._logCycle, t: 'CMD',
                cmd: this._logCmdName,
                byte: '$' + cmd.toString(16).padStart(2, '0'),
                trk: this.trackReg, sec: this.sectorReg,
                drv: this.currentDrive, side: this.currentSide,
                pos: this.headPosition[this.currentDrive],
            });
        }

        const cmdHigh = cmd & 0xF0;

        // --- Type IV: Force Interrupt ---
        if ((cmd & 0xF0) === 0xD0) {
            this._forceInterrupt(cmd);
            return;
        }

        // If busy, ignore new commands (except Force Interrupt above)
        if (this.statusReg & STATUS.BUSY) {
            console.warn(`[FDC] CMD $${cmd.toString(16)} IGNORED (busy)`);
            return;
        }

        // Set access latch for UI LED
        this.accessLatch = true;

        // Set BUSY
        this.statusReg = STATUS.BUSY;
        this.drqFlag = false;

        // --- Type I commands ---
        if (cmd < 0x80) {
            this.commandType = CMD_TYPE.TYPE_I;
            this.cmdFlags.h = (cmd & 0x08) !== 0;
            this.cmdFlags.v = (cmd & 0x04) !== 0;
            this.cmdFlags.r = cmd & 0x03;
            this.cmdFlags.u = (cmd & 0x10) !== 0; // Update flag for Step variants

            // FDD sound: compute how many physical steps this command will make,
            // then fire the seek-sound callback BEFORE Restore overwrites trackReg.
            if (this.onSeekSound) {
                let steps = 0;
                if (cmdHigh === 0x00) {
                    // Restore: step out until track 0. The physical drive stops
                    // at TR00, but the FDC has no a-priori knowledge of head
                    // position — the boot ROM uses Restore as "find home", so
                    // assume a worst-case pass from the current head position.
                    steps = this.headPosition[this.currentDrive] & 0xFF;
                    if (steps === 0) steps = 1; // always audible
                } else if (cmdHigh === 0x10) {
                    // Seek: |dataReg - trackReg|
                    steps = Math.abs((this.dataReg & 0xFF) - (this.trackReg & 0xFF));
                } else {
                    // Step / Step-In / Step-Out: exactly 1 track
                    steps = 1;
                }
                this.onSeekSound(steps);
            }
            // Head load click if h=1 (force head load on Type I).
            if (this.cmdFlags.h && this.onHeadLoadSound) {
                this.onHeadLoadSound();
            }

            if (cmdHigh === 0x00) {
                // Restore: seek to track 0
                this.dataReg = 0; // Target track = 0
                this.trackReg = 0xFF; // Start from "unknown"
                this.state = FDC_STATE.SEEK_STEPPING;
                this._beginSeekRestore();
            } else if (cmdHigh === 0x10) {
                // Seek: seek to track in data register
                this.state = FDC_STATE.SEEK_STEPPING;
                this._beginSeek();
            } else if (cmdHigh <= 0x30) {
                // Step (no direction change)
                this._beginStep(false);
            } else if (cmdHigh <= 0x50) {
                // Step In
                this.stepDirection = 1;
                this._beginStep(true);
            } else if (cmdHigh <= 0x70) {
                // Step Out
                this.stepDirection = -1;
                this._beginStep(true);
            }
            return;
        }

        // --- Type II commands ---
        if (cmd < 0xC0) {
            this.commandType = CMD_TYPE.TYPE_II;
            this.cmdFlags.m = (cmd & 0x10) !== 0;
            this.cmdFlags.s = (cmd & 0x08) !== 0;
            this.cmdFlags.e = (cmd & 0x04) !== 0;
            this.cmdFlags.a0 = (cmd & 0x01) !== 0; // DAM flag for write

            // FDD sound: head-load click for any Type II command.
            if (this.onHeadLoadSound) this.onHeadLoadSound();

            // No disk inserted: return NOT_READY.
            // MB8877 reports NOT_READY when drive has no media.
            // Boot ROMs check for NOT_READY to skip disk boot immediately.
            if (!this.currentDisk || !this.currentDisk.loaded) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }

            // Apply settle delay if E flag set
            const settleCycles = this.cmdFlags.e ? 30000 : 0; // 15ms at 2MHz

            if (cmdHigh === 0x80 || cmdHigh === 0x90) {
                // Read Sector - add rotational latency
                this.state = FDC_STATE.READ_FIND_SECTOR;
                this.delayCycles = settleCycles + this._rotationalLatency();
            } else {
                // Write Sector ($A0-$BF)
                if (this.currentDisk.writeProtect) {
                    this._completeCommand(STATUS.WRITE_PROTECT);
                    return;
                }
                this.state = FDC_STATE.WRITE_FIND_SECTOR;
                this.delayCycles = settleCycles + this._rotationalLatency();
            }
            return;
        }

        // --- Type III commands ---
        if (cmd < 0xE0) {
            // $C0-$DF: Read Address (but $D0-$DF is Force Interrupt, handled above)
            this.commandType = CMD_TYPE.TYPE_III;
            this.cmdFlags.e = (cmd & 0x04) !== 0;

            // FDD sound: head-load click for Type III.
            if (this.onHeadLoadSound) this.onHeadLoadSound();

            if (!this.currentDisk || !this.currentDisk.loaded) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }

            this.state = FDC_STATE.READ_ADDRESS;
            this.delayCycles = this.cmdFlags.e ? 30000 : 0;
            return;
        }

        if (cmdHigh === 0xE0) {
            // Read Track
            this.commandType = CMD_TYPE.TYPE_III;
            if (this.onHeadLoadSound) this.onHeadLoadSound();
            if (!this.currentDisk || !this.currentDisk.loaded) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }
            this.state = FDC_STATE.READ_TRACK;
            this.delayCycles = 0;
            return;
        }

        if (cmdHigh === 0xF0) {
            // Write Track (Format)
            this.commandType = CMD_TYPE.TYPE_III;
            if (this.onHeadLoadSound) this.onHeadLoadSound();
            if (!this.currentDisk || !this.currentDisk.loaded) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }
            if (this.currentDisk.writeProtect) {
                this._completeCommand(STATUS.WRITE_PROTECT);
                return;
            }
            this.state = FDC_STATE.WRITE_TRACK;
            this.delayCycles = 0;
            return;
        }
    }

    /**
     * Compute rotational latency to reach the target sector from the
     * current disk rotation phase.  On real hardware the disk spins
     * continuously at 300 RPM; the time to reach a given sector depends
     * on where the head is in the rotation when the command is issued.
     *
     * 300 RPM = 200 ms / revolution, 16 sectors / track.
     * Sector N occupies a fixed arc: offset = N * (revolution / 16).
     * Latency = (sector_offset - current_phase) mod revolution.
     *
     * Returns a latency in CPU cycles that naturally varies between
     * successive reads, matching real-hardware behaviour that some
     * games rely on for timing-based checks.
     */
    _rotationalLatency() {
        const rev = FDC.REVOLUTION_CYCLES;
        const spt = FDC.SECTORS_PER_TRACK;
        const sectorSlot = rev / spt;   // cycles per sector slot
        // Target sector's angular position on the track
        const sectorOffset = ((this.sectorReg - 1) & 0x0F) * sectorSlot;
        // Time from current phase until the sector header passes under head
        let latency = Math.round(sectorOffset - this._rotationPhase);
        if (latency < 0) latency += rev;
        // Minimum latency: at least ~1 ms for controller overhead
        const minCycles = Math.round(rev / (spt * 4));  // ~3125 @ 2MHz
        if (latency < minCycles) latency += rev;
        return latency;
    }

    // =========================================================================
    // Type I: Seek / Step
    // =========================================================================

    /** Restore: step out until track 0 */
    _beginSeekRestore() {
        this.stepDirection = -1;
        const pos = this.headPosition[this.currentDrive];
        if (pos === 0) {
            // Already at track 0. Real WD279x still asserts BUSY briefly
            // before completing; some games poll the status register
            // waiting to observe BUSY=1 first (e.g. `LDA $FD18; ASRA;
            // BCC loop`) and would deadlock on instant completion. Defer
            // the completion via SEEK_VERIFY (a "delay then complete"
            // state). Use a minimal delay (200 cycles ≈ 100µs) — enough
            // for the polling loop to see one BUSY=1 sample, but not
            // enough to perturb the loader timing of other games.
            this.trackReg = 0;
            this.headPosition[this.currentDrive] = 0;
            this.delayCycles = this.cmdFlags.v ? 2000 : 200;
            this.state = FDC_STATE.SEEK_VERIFY;
        } else {
            // Step toward track 0
            this.delayCycles = STEP_RATES[this.cmdFlags.r];
            this.state = FDC_STATE.SEEK_STEPPING;
        }
    }

    /** Seek: move head to target track (in data register) */
    _beginSeek() {
        const target = this.dataReg;
        const headPos = this.headPosition[this.currentDrive];
        // Use physical head position for comparison, not trackReg.
        // The BIOS may write 0 to trackReg before Seek (absolute positioning),
        // but the physical head is already at the correct track.
        if (target === headPos) {
            // Already at target. Defer completion so polling loops that
            // wait for BUSY=1 can observe the transient (see comment in
            // _beginSeekRestore). Use a minimal 200-cycle delay.
            this.trackReg = target;
            this.delayCycles = this.cmdFlags.v ? 2000 : 200;
            this.state = FDC_STATE.SEEK_VERIFY;
            return;
        }

        this.stepDirection = (target > headPos) ? 1 : -1;
        this.trackReg = headPos; // Sync trackReg with actual head position
        this.delayCycles = STEP_RATES[this.cmdFlags.r];
        this.state = FDC_STATE.SEEK_STEPPING;
    }

    /** Step command (with or without direction update) */
    _beginStep(directionSet) {
        // directionSet: whether to change stepDirection (Step In/Out set it, plain Step doesn't)
        // stepDirection already set by caller for Step In/Out
        this.delayCycles = STEP_RATES[this.cmdFlags.r];
        this.state = FDC_STATE.SEEK_STEPPING;
    }

    /** Process one step pulse during seek */
    _stepSeek() {
        const cmd = this.commandReg & 0xF0;
        if (cmd === 0x00) {
            // Restore
            let pos = this.headPosition[this.currentDrive];
            pos += this.stepDirection; // -1 toward track 0
            if (pos <= 0) {
                pos = 0;
                this.trackReg = 0;
                this.headPosition[this.currentDrive] = 0;
                if (this.cmdFlags.v) {
                    this.state = FDC_STATE.SEEK_VERIFY;
                    this.delayCycles = 2000;
                } else {
                    this._completeTypeI();
                }
                return;
            }
            this.headPosition[this.currentDrive] = pos;
            this.delayCycles = STEP_RATES[this.cmdFlags.r];
        } else if (cmd === 0x10) {
            // Seek
            const target = this.dataReg;
            this.trackReg += this.stepDirection;
            this.headPosition[this.currentDrive] += this.stepDirection;
            if (this.headPosition[this.currentDrive] < 0) {
                this.headPosition[this.currentDrive] = 0;
            }
            if (this.trackReg === target || this.trackReg < 0 || this.trackReg > 255) {
                this.trackReg = target & 0xFF;
                this.headPosition[this.currentDrive] = target;
                if (this.cmdFlags.v) {
                    this.state = FDC_STATE.SEEK_VERIFY;
                    this.delayCycles = 2000;
                } else {
                    this._completeTypeI();
                }
                return;
            }
            this.delayCycles = STEP_RATES[this.cmdFlags.r];
        } else {
            // Step / Step In / Step Out
            this.headPosition[this.currentDrive] += this.stepDirection;
            if (this.headPosition[this.currentDrive] < 0) {
                this.headPosition[this.currentDrive] = 0;
            }
            if (this.cmdFlags.u) {
                this.trackReg += this.stepDirection;
                if (this.trackReg < 0) this.trackReg = 0;
                if (this.trackReg > 255) this.trackReg = 255;
            }
            if (this.cmdFlags.v) {
                this.state = FDC_STATE.SEEK_VERIFY;
                this.delayCycles = 2000;
            } else {
                this._completeTypeI();
            }
        }
    }

    /** Complete a Type I command and set final status */
    _completeTypeI() {
        // Reset PLL drift counter — Type I commands (RESTORE/SEEK) establish
        // a new head position; the PLL re-locks from scratch on the next read.
        this._pllDrift = 0;
        let status = 0;

        // Track 0 bit
        if (this.headPosition[this.currentDrive] === 0) {
            status |= STATUS.TRACK0;
        }

        // Head engaged
        if (this.cmdFlags.h) {
            status |= STATUS.HEAD_ENGAGED;
        }

        // Drive is always READY for Type I commands — drives are physically
        // present.  "No disk" is detected by RNF on Type II/III, not NOT_READY.

        this._completeCommand(status);
    }

    // =========================================================================
    // Type II: Read Sector
    // =========================================================================

    /** Begin reading sector data after finding sector */
    _startReadTransfer() {
        const disk = this.currentDisk;
        if (!disk) {
            this._completeCommand(STATUS.RNF);
            return;
        }

        // Look up the sector on the CURRENT physical track by sector number.
        // MB8877/WD1793 READ SECTOR scans address fields on the physical track.
        // The FDC compares each sector ID's C field against the Track Register
        // and R field against the Sector Register.  Only when both match does
        // the data transfer begin.  If no matching ID is found within 5 index
        // pulses, RNF is asserted.
        const physTrack = this.headPosition[this.currentDrive];
        const side = this.currentSide;
        const sectorNum = this.sectorReg;

        const sector = disk.getSector(physTrack, side, sectorNum);
        if (!sector || sector.c !== this.trackReg) {
            if (this.logEnabled) {
                this.log.push({
                    cyc: this._logCycle, t: 'FIND_RNF',
                    physTrk: physTrack, tr: this.trackReg,
                    side, sec: sectorNum,
                    has: !sector ? 'none' : `C${sector.c}`,
                });
            }
            // MB8877: on missing sector, keep BUSY asserted while searching
            // for 5 index pulses (5 revolutions ≈ 1 s at 300rpm), then assert
            // RNF + INTRQ. Some software depends on this delay.
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }
        if (this.logEnabled) {
            this.log.push({
                cyc: this._logCycle, t: 'FIND_OK',
                physTrk: physTrack, side, sec: sectorNum,
                size: sector.size,
                d77status: '$' + (sector.status || 0).toString(16).padStart(2, '0'),
                deleted: sector.deleted ? 1 : 0,
            });
            this._logByteCount = 0;
        }
        // Set up data transfer
        this.dataBuffer = sector.data;
        this.dataIndex = 0;
        this.dataLength = sector.size;
        this._lostDataCount = 0;

        // Check deleted data mark and D77 sector status
        let statusExtra = 0;
        if (sector.deleted) {
            statusExtra |= STATUS.RECORD_TYPE;
        }
        // D77 status field: reflect errors to FDC status.
        // D77 dumps record abnormal sectors as various non-zero status
        // values ($B0, $E0, $10, etc.). Any non-zero value sets CRC_ERROR.
        if (sector.status !== 0) {
            statusExtra |= STATUS.CRC_ERROR;
        }
        // Save completion status for when transfer finishes
        this._readStatusExtra = statusExtra;

        // Present first byte via pending DRQ (byte transfer timing).
        //
        // On real hardware the disk's MFM bit clock (PLL-locked to disk
        // rotation) is asynchronous to the CPU crystal.  The PLL re-acquires
        // lock on each sector's sync field; the lock phase drifts slightly
        // with each successive sector read.  Software that compares poll-loop
        // counts across two sector reads expects the second read to produce
        // 32-255 more polling iterations than the first.
        //
        // We model this with a monotonically increasing drift counter that
        // resets on Type I commands (RESTORE/SEEK).  Each READ adds a small
        // increment to the effective byte period.  Over 256 bytes a 3-cycle
        // per-byte increase produces ~60 extra poll iterations in a typical
        // 17-cycle inner loop — well within the expected $20-$FF range.
        this.dataReg = this.dataBuffer[0];
        this.dataIndex = 1;
        this._pendingDrq = true;
        const drift = Math.min(this._pllDrift || 0, 4);
        this._pllDrift = (this._pllDrift || 0) + 3;
        this._effectiveBytePeriod = FDC.BYTE_DELAY + drift;
        this._drqTimer = this._effectiveBytePeriod;
        this.statusReg = STATUS.BUSY | statusExtra;
        this.state = FDC_STATE.READ_TRANSFER;
    }

    /**
     * Advance read transfer after CPU reads data register.
     * @param {number} [elapsedSinceDrq=0] - Cycles elapsed since the DRQ
     *   that the CPU just consumed.  On real hardware, bytes arrive from the
     *   spinning disk at fixed intervals (BYTE_DELAY).  If the CPU reads the
     *   data register quickly, the remaining time until the *next* byte is
     *   shorter than a full BYTE_DELAY.  Accounting for this prevents
     *   artificially inflating the DRQ-to-DRQ gap and keeps software timing
     *   loops (which poll $FD1F between bytes) in spec.
     */
    _advanceRead(elapsedSinceDrq = 0) {
        if (this.state !== FDC_STATE.READ_TRANSFER) return;

        if (this.dataIndex < this.dataLength) {
            // More bytes to transfer.
            // Use the per-transfer effective byte period (which includes
            // clock-drift simulation) minus the time already elapsed since
            // the DRQ that the CPU just consumed.
            this.dataReg = this.dataBuffer[this.dataIndex];
            this.dataIndex++;
            this._pendingDrq = true;
            const period = this._effectiveBytePeriod || FDC.BYTE_DELAY;
            const remaining = period - elapsedSinceDrq;
            this._drqTimer = remaining > 0 ? remaining : 1;
        } else {
            // Transfer complete
            if (this.cmdFlags.m) {
                // Multi-sector: advance to next sector with rotational delay
                if (this.logEnabled) {
                    const secEnd = {
                        cyc: this._logCycle, t: 'SEC_END',
                        readBytes: this._logByteCount,
                        nextSec: (this.sectorReg + 1) & 0xFF,
                    };
                    if (this._lostDataCount > 0) secEnd.lostBytes = this._lostDataCount;
                    this.log.push(secEnd);
                }
                this._lostDataCount = 0;
                this.sectorReg++;
                this.drqFlag = false;
                this.statusReg = STATUS.BUSY;  // BUSY but no DRQ during gap
                this.state = FDC_STATE.READ_FIND_SECTOR;
                this.delayCycles = FDC.MULTI_SECTOR_GAP;
            } else {
                // Single sector: done (include D77 sector status like CRC errors)
                // Also report LOST_DATA in final status (real WD279x does this)
                let finalStatus = this._readStatusExtra || 0;
                if (this._lostDataCount > 0) finalStatus |= STATUS.LOST_DATA;
                this._completeCommand(finalStatus);
            }
        }
    }

    // =========================================================================
    // Type II: Write Sector
    // =========================================================================

    /** Begin write transfer */
    _startWriteTransfer() {
        const disk = this.currentDisk;
        if (!disk) {
            this._completeCommand(STATUS.RNF);
            return;
        }

        const track = this.headPosition[this.currentDrive];
        const side = this.currentSide;
        const sectorNum = this.sectorReg;

        const sector = disk.getSector(track, side, sectorNum);
        if (!sector || sector.c !== this.trackReg) {
            // MB8877: C field must match track register (same as read path).
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }

        // Set up write buffer
        this.dataBuffer = sector.data;
        this.dataIndex = 0;
        this.dataLength = sector.size;

        // Request first byte from CPU
        this.drqFlag = true;
        this.statusReg = STATUS.BUSY | STATUS.DRQ;
        this.state = FDC_STATE.WRITE_TRANSFER;
    }

    /** Advance write transfer after CPU writes data register */
    _advanceWrite() {
        if (this.state !== FDC_STATE.WRITE_TRANSFER) return;

        if (this.dataIndex < this.dataLength) {
            this.dataBuffer[this.dataIndex] = this.dataReg;
            this.dataIndex++;
        }

        if (this.dataIndex < this.dataLength) {
            // More bytes needed
            this.drqFlag = true;
            this.statusReg |= STATUS.DRQ;
        } else {
            // Sector write complete
            if (this.cmdFlags.m) {
                // Multi-sector: advance to next sector with rotational delay
                this.sectorReg++;
                this.drqFlag = false;
                this.statusReg = STATUS.BUSY;  // BUSY but no DRQ during gap
                this.state = FDC_STATE.WRITE_FIND_SECTOR;
                this.delayCycles = FDC.MULTI_SECTOR_GAP;
            } else {
                this._completeCommand(0);
            }
        }
    }

    // =========================================================================
    // Type III: Read Address
    // =========================================================================

    /** Start Read Address command - returns sector ID from current track */
    _startReadAddress() {
        const disk = this.currentDisk;
        if (!disk) {
            this._completeCommand(STATUS.RNF);
            return;
        }

        const track = this.headPosition[this.currentDrive];
        const side = this.currentSide;
        const sectorList = disk.getSectorList(track, side);

        if (sectorList.length === 0) {
            if (this.logEnabled) {
                this.log.push({ cyc: this._logCycle, t: 'RADDR_RNF', physTrk: track, side });
            }
            // MB8877: unformatted track — search 5 index pulses before RNF.
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }
        if (this.logEnabled) {
            const idx = this.readAddrSectorIndex % sectorList.length;
            this.log.push({
                cyc: this._logCycle, t: 'READ_ADDR',
                physTrk: track, side, retSec: sectorList[idx],
                listLen: sectorList.length,
            });
        }

        // Rotate through sectors on each Read Address call
        const sectorIdx = this.readAddrSectorIndex % sectorList.length;
        this.readAddrSectorIndex++;
        const sectorNum = sectorList[sectorIdx];
        const sector = disk.getSector(track, side, sectorNum);

        // Build 6-byte ID field: C, H, R, N, CRC1, CRC2
        this.idBuffer = new Uint8Array(6);
        this.idBuffer[0] = sector.c;
        this.idBuffer[1] = sector.h;
        this.idBuffer[2] = sector.r;
        this.idBuffer[3] = sector.n;
        this.idBuffer[4] = 0x00; // CRC (dummy)
        this.idBuffer[5] = 0x00;

        // Transfer via data register + DRQ, same as Read Sector
        this.dataBuffer = this.idBuffer;
        this.dataIndex = 0;
        this.dataLength = 6;

        // Set track register to the cylinder from the ID field
        this.trackReg = sector.c;

        // Present first byte
        this.dataReg = this.dataBuffer[0];
        this.dataIndex = 1;
        this.drqFlag = true;
        this.statusReg = STATUS.BUSY | STATUS.DRQ;
        this.state = FDC_STATE.READ_TRANSFER;
    }

    // =========================================================================
    // Type IV: Force Interrupt
    // =========================================================================

    /**
     * Force Interrupt command - aborts current operation.
     * @param {number} cmd - Command byte ($D0-$DF)
     * @private
     */
    _forceInterrupt(cmd) {
        const conditions = cmd & 0x0F;

        if (this.logEnabled) {
            this.log.push({
                cyc: this._logCycle, t: 'FORCE_INT',
                byte: '$' + cmd.toString(16).padStart(2, '0'),
                cond: '$' + conditions.toString(16),
                wasBusy: (this._logBusyPrev ? 1 : 0),
                bytesSoFar: this._logTotalBytes,
            });
        }

        // Abort current command
        this.state = FDC_STATE.IDLE;
        this.drqFlag = false;

        // Build status as if Type I (track 0, etc.)
        // Drive is always READY (physically present)
        this.statusReg = 0;
        if (this.headPosition[this.currentDrive] === 0) {
            this.statusReg |= STATUS.TRACK0;
        }

        if (conditions !== 0) {
            // Generate interrupt immediately for $D8 (immediate interrupt)
            this.irqFlag = true;
            if (this.onIRQ) {
                this.onIRQ();
            }
        }

        if (this.logEnabled) this._logEdges();
    }

    // =========================================================================
    // Command Completion
    // =========================================================================

    /**
     * Complete current command, set final status, raise IRQ.
     * @param {number} errorBits - Additional status bits to set
     * @private
     */
    _completeCommand(errorBits) {
        this.statusReg = errorBits & ~STATUS.BUSY; // Clear BUSY, set error bits
        this.drqFlag = false;
        this.state = FDC_STATE.IDLE;

        if (this.logEnabled) {
            const dur = this._logCycle - this._logCmdStart;
            const flags = [];
            if (errorBits & STATUS.RNF) flags.push('RNF');
            if (errorBits & STATUS.CRC_ERROR) flags.push('CRC');
            if (errorBits & STATUS.LOST_DATA) flags.push('LOST');
            if (errorBits & STATUS.WRITE_PROTECT) flags.push('WP');
            if (errorBits & STATUS.NOT_READY) flags.push('NRDY');
            if (errorBits & STATUS.RECORD_TYPE) flags.push('DDM');
            const entry = {
                cyc: this._logCycle, t: 'DONE',
                cmd: this._logCmdName,
                status: '$' + (errorBits & 0xFF).toString(16).padStart(2, '0'),
                flags: flags.length ? flags.join('|') : 'OK',
                durCyc: dur, durUs: +(dur / 2).toFixed(1),
                bytes: this._logTotalBytes,
            };
            if (this._lostDataCount > 0) entry.lostBytes = this._lostDataCount;
            this.log.push(entry);
            this._logEdges();
        }

        // Assert IRQ
        this.irqFlag = true;
        if (this.onIRQ) {
            this.onIRQ();
        }
        if (this.logEnabled) this._logEdges();
    }

    // =========================================================================
    // Drive Status ($FD1C read)
    // =========================================================================

    /**
     * Read drive status register.
     * @returns {number} Status byte
     * @private
     */
    _readDriveStatus() {
        let status = 0;

        // Bit 7: 1 = drive not ready / motor off
        // Drive is always physically present; only motor-off means not ready
        if (!this.motorOn) {
            status |= 0x80;
        }

        // Bit 6: write protect
        if (this.currentDisk && this.currentDisk.writeProtect) {
            status |= 0x40;
        }

        // Bit 2: track 0
        if (this.headPosition[this.currentDrive] === 0) {
            status |= 0x04;
        }

        // Bit 1: index pulse (simulate: toggle based on timing, always return 0 for simplicity)
        // Bit 0: side selected
        status |= (this.currentSide & 0x01);

        return status;
    }

    // =========================================================================
    // Reset
    // =========================================================================

    /** Reset the FDC to initial state */
    reset() {
        this.statusReg = 0;
        this.trackReg = 0;
        this.sectorReg = 0;
        this.dataReg = 0;
        this.commandReg = 0;
        this.state = FDC_STATE.IDLE;
        this.commandType = 0;
        this.irqFlag = false;
        this.drqFlag = false;
        this._pendingDrq = false;
        this._drqTimer = 0;
        this.motorOn = false;
        this.hdMode = false;
        this.currentDrive = 0;
        this.currentSide = 0;
        this.stepDirection = 1;
        this.delayCycles = 0;
        this.dataBuffer = null;
        this.dataIndex = 0;
        this.dataLength = 0;
        this.headPosition = [0, 0, 0, 0];
        this.readAddrSectorIndex = 0;
        this.accessLatch = false;
    }
}
