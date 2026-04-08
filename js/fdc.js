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

// Step rates in microseconds (for 1MHz clock reference)
const STEP_RATES = [6000, 12000, 20000, 30000]; // 6ms, 12ms, 20ms, 30ms

// D77 header size
const D77_HEADER_SIZE = 0x2B0;
const D77_TRACK_TABLE_OFFSET = 0x20;
const D77_MAX_TRACKS = 164;
const D77_SECTOR_HEADER_SIZE = 0x10;

// Sector size lookup by N value
const SECTOR_SIZES = [128, 256, 512, 1024];

// 2D raw image constants
const RAW_2D_SIZE = 327680;  // 40 tracks * 16 sectors * 256 bytes * 2 sides
const RAW_1S_SIZE = 163840;  // 40 tracks * 16 sectors * 256 bytes * 1 side


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
     * Parse a raw 2D disk image (no header, fixed format).
     * 40 tracks, 16 sectors/track, 256 bytes/sector.
     * If 327680 bytes: double-sided; if 163840 bytes: single-sided.
     * @param {ArrayBuffer} buffer - The raw image data
     * @returns {boolean} true if parsing succeeded
     */
    parseRaw2D(buffer) {
        const bytes = new Uint8Array(buffer);
        const size = buffer.byteLength;

        let numSides;
        if (size === RAW_2D_SIZE) {
            numSides = 2;
        } else if (size === RAW_1S_SIZE) {
            numSides = 1;
        } else {
            console.error(`FDC: Raw image size ${size} does not match 2D (${RAW_2D_SIZE}) or 1S (${RAW_1S_SIZE})`);
            return false;
        }

        this.name = 'RAW2D';
        this.writeProtect = false;
        this.mediaType = 0x00; // 2D
        this.diskSize = size;
        this.numTracks = 40;
        this.numSides = numSides;
        this.sectors = {};

        const sectorsPerTrack = 16;
        const sectorSize = 256;
        let pos = 0;

        for (let track = 0; track < 40; track++) {
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
        // Drives (up to 4)
        this.disks = [null, null, null, null];

        // Currently selected drive and head
        this.currentDrive = 0;
        this.currentSide = 0;
        this.motorOn = false;
        this.densityFlag = false; // bit4 of $FD1C

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

        // IRQ / DRQ status
        this.irqFlag = false;
        this.drqFlag = false;

        // Pending DRQ for byte-level transfer timing
        this._pendingDrq = false;
        this._drqTimer = 0;

        // D77 sector status (CRC errors etc.) for READ completion
        this._readStatusExtra = 0;

        // Callback for IRQ generation
        this.onIRQ = null;

        // Sector iteration for Read Address
        this.readAddrSectorIndex = 0;
    }

    // Timing constants (in CPU cycles at 1.2288 MHz)
    // 300 RPM = 200ms/revolution, 16 sectors/track
    // Average rotational latency per sector: ~6ms = 7373 cycles
    static ROTATE_DELAY = 7373;
    // MFM byte transfer delay: 32µs per byte = ~39 cycles
    static BYTE_DELAY = 39;

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

        const disk = new D77Disk();
        let success = false;

        // Try D77 format first: check if the size field at 0x1C matches the actual size
        if (arrayBuffer.byteLength >= D77_HEADER_SIZE) {
            const view = new DataView(arrayBuffer);
            const declaredSize = view.getUint32(0x1C, true);
            if (declaredSize === arrayBuffer.byteLength) {
                success = disk.parseD77(arrayBuffer);
                if (success) {
                    console.log(`FDC: Drive ${driveNum}: D77 image loaded - "${disk.name}", ${disk.numTracks} tracks, ${disk.numSides} side(s)`);
                }
            }
        }

        // If D77 parsing failed or wasn't attempted, try raw 2D
        if (!success) {
            success = disk.parseRaw2D(arrayBuffer);
            if (success) {
                console.log(`FDC: Drive ${driveNum}: Raw 2D image loaded, ${disk.numTracks} tracks, ${disk.numSides} side(s)`);
            }
        }

        if (success) {
            this.disks[driveNum] = disk;
        } else {
            console.error(`FDC: Failed to load disk in drive ${driveNum}`);
        }

        return success;
    }

    /**
     * Eject disk from a drive.
     * @param {number} driveNum
     */
    ejectDisk(driveNum) {
        if (driveNum >= 0 && driveNum <= 3) {
            this.disks[driveNum] = null;
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
        switch (addr) {
            case 0xFD18: // Status Register
                // Reading status clears IRQ
                this.irqFlag = false;
                return this.statusReg;

            case 0xFD19: // Track Register
                return this.trackReg & 0xFF;

            case 0xFD1A: // Sector Register
                return this.sectorReg & 0xFF;

            case 0xFD1B: // Data Register
                // If DRQ is set, reading data clears it and advances transfer
                if (this.drqFlag) {
                    const val = this.dataReg;
                    this.drqFlag = false;
                    this.statusReg &= ~STATUS.DRQ;
                    this._advanceRead();
                    return val;
                }
                return this.dataReg;

            case 0xFD1C: // Side register readback (sidereg | 0xFE)
                return this.currentSide | 0xFE;

            case 0xFD1D: // Drive select readback
                return (this.currentDrive & 0x03) | (this.motorOn ? 0x80 : 0x00);

            case 0xFD1F: // DRQ/IRQ status
                // bit 7: DRQ (data request)
                // bit 6: IRQ (command complete)
                // bits 0-5: unused (read as 0)
                return (this.drqFlag ? 0x80 : 0x00) | (this.irqFlag ? 0x40 : 0x00);

            default:
                return 0xFF;
        }
    }

    /**
     * Write to FDC I/O port.
     * @param {number} addr - Address ($FD18-$FD1F)
     * @param {number} value - Byte value
     */
    writeIO(addr, value) {
        value &= 0xFF;

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

            default:
                break;
        }
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
        // Handle pending DRQ (byte transfer timing)
        if (this._pendingDrq) {
            this._drqTimer -= cycles;
            if (this._drqTimer <= 0) {
                this._pendingDrq = false;
                this.drqFlag = true;
                this.statusReg |= STATUS.DRQ;
            }
        }

        if (this.state === FDC_STATE.IDLE || this.state === FDC_STATE.COMPLETE) {
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
        }
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

        const cmdHigh = cmd & 0xF0;

        // --- Type IV: Force Interrupt ---
        if ((cmd & 0xF0) === 0xD0) {
            this._forceInterrupt(cmd);
            return;
        }

        // If busy, ignore new commands (except Force Interrupt above)
        if (this.statusReg & STATUS.BUSY) {
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
                this.delayCycles = settleCycles + FDC.ROTATE_DELAY;
            } else {
                // Write Sector ($A0-$BF)
                if (this.currentDisk.writeProtect) {
                    this._completeCommand(STATUS.WRITE_PROTECT);
                    return;
                }
                this.state = FDC_STATE.WRITE_FIND_SECTOR;
                this.delayCycles = settleCycles + FDC.ROTATE_DELAY;
            }
            return;
        }

        // --- Type III commands ---
        if (cmd < 0xE0) {
            // $C0-$DF: Read Address (but $D0-$DF is Force Interrupt, handled above)
            this.commandType = CMD_TYPE.TYPE_III;
            this.cmdFlags.e = (cmd & 0x04) !== 0;

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
            this.delayCycles = this.cmdFlags.v ? 30000 : 200;
            this.state = FDC_STATE.SEEK_VERIFY;
        } else {
            // Step toward track 0
            this.delayCycles = STEP_RATES[this.cmdFlags.r] * 2;
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
            this.delayCycles = this.cmdFlags.v ? 30000 : 200;
            this.state = FDC_STATE.SEEK_VERIFY;
            return;
        }

        this.stepDirection = (target > headPos) ? 1 : -1;
        this.trackReg = headPos; // Sync trackReg with actual head position
        this.delayCycles = STEP_RATES[this.cmdFlags.r] * 2;
        this.state = FDC_STATE.SEEK_STEPPING;
    }

    /** Step command (with or without direction update) */
    _beginStep(directionSet) {
        // directionSet: whether to change stepDirection (Step In/Out set it, plain Step doesn't)
        // stepDirection already set by caller for Step In/Out
        this.delayCycles = STEP_RATES[this.cmdFlags.r] * 2;
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
                    this.delayCycles = 30000;
                } else {
                    this._completeTypeI();
                }
                return;
            }
            this.headPosition[this.currentDrive] = pos;
            this.delayCycles = STEP_RATES[this.cmdFlags.r] * 2;
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
                    this.delayCycles = 30000;
                } else {
                    this._completeTypeI();
                }
                return;
            }
            this.delayCycles = STEP_RATES[this.cmdFlags.r] * 2;
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
                this.delayCycles = 30000;
            } else {
                this._completeTypeI();
            }
        }
    }

    /** Complete a Type I command and set final status */
    _completeTypeI() {
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

        // Real WD279x scans address fields on the CURRENT physical track for
        // a sector header whose track-ID matches the track register. If the
        // game forgot to seek (or seeks elsewhere) the read returns RNF on
        // real hardware. Looking up by `headPosition` only would silently
        // return data from the wrong physical track and corrupt the load.
        const physTrack = this.headPosition[this.currentDrive];
        const side = this.currentSide;
        const sectorNum = this.sectorReg;

        const sector = disk.getSector(physTrack, side, sectorNum);
        if (!sector || sector.c !== this.trackReg) {
            // Record Not Found (no sector ID matches trackReg on physical track)
            this._completeCommand(STATUS.RNF);
            return;
        }
        // Set up data transfer
        this.dataBuffer = sector.data;
        this.dataIndex = 0;
        this.dataLength = sector.size;

        // Check deleted data mark and D77 sector status
        let statusExtra = 0;
        if (sector.deleted) {
            statusExtra |= STATUS.RECORD_TYPE;
        }
        // D77 status field: reflect CRC errors to FDC status
        // (e.g., copy-protected sectors with intentional CRC errors)
        if (sector.status & 0x08) {
            statusExtra |= STATUS.CRC_ERROR;
        }
        // Save completion status for when transfer finishes
        this._readStatusExtra = statusExtra;

        // Present first byte via pending DRQ (byte transfer timing)
        this.dataReg = this.dataBuffer[0];
        this.dataIndex = 1;
        this._pendingDrq = true;
        this._drqTimer = FDC.BYTE_DELAY;
        this.statusReg = STATUS.BUSY | statusExtra;
        this.state = FDC_STATE.READ_TRANSFER;
    }

    /** Advance read transfer after CPU reads data register */
    _advanceRead() {
        if (this.state !== FDC_STATE.READ_TRANSFER) return;

        if (this.dataIndex < this.dataLength) {
            // More bytes to transfer - use pending DRQ for realistic timing
            this.dataReg = this.dataBuffer[this.dataIndex];
            this.dataIndex++;
            this._pendingDrq = true;
            this._drqTimer = FDC.BYTE_DELAY;
        } else {
            // Transfer complete
            if (this.cmdFlags.m) {
                // Multi-sector: advance to next sector
                this.sectorReg++;
                const disk = this.currentDisk;
                const track = this.headPosition[this.currentDrive];
                const side = this.currentSide;
                const nextSector = disk ? disk.getSector(track, side, this.sectorReg) : null;

                if (nextSector) {
                    this.dataBuffer = nextSector.data;
                    this.dataIndex = 0;
                    this.dataLength = nextSector.size;

                    // Present first byte of next sector with byte delay
                    this.dataReg = this.dataBuffer[0];
                    this.dataIndex = 1;
                    this._pendingDrq = true;
                    this._drqTimer = FDC.BYTE_DELAY;
                    this.statusReg = STATUS.BUSY;
                    if (nextSector.deleted) {
                        this.statusReg |= STATUS.RECORD_TYPE;
                    }
                    return;
                }
                // No more sectors: Record Not Found ends multi-sector
                this._completeCommand(STATUS.RNF);
            } else {
                // Single sector: done (include D77 sector status like CRC errors)
                this._completeCommand(this._readStatusExtra || 0);
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
        if (!sector) {
            this._completeCommand(STATUS.RNF);
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
                // Multi-sector
                this.sectorReg++;
                const disk = this.currentDisk;
                const track = this.headPosition[this.currentDrive];
                const side = this.currentSide;
                const nextSector = disk ? disk.getSector(track, side, this.sectorReg) : null;

                if (nextSector) {
                    this.dataBuffer = nextSector.data;
                    this.dataIndex = 0;
                    this.dataLength = nextSector.size;
                    this.drqFlag = true;
                    this.statusReg = STATUS.BUSY | STATUS.DRQ;
                    return;
                }
                this._completeCommand(STATUS.RNF);
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
            this._completeCommand(STATUS.RNF);
            return;
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
        // errorBits logged only in debug mode (removed for performance)

        // Assert IRQ
        this.irqFlag = true;
        if (this.onIRQ) {
            this.onIRQ();
        }
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
