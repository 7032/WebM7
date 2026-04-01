// FM-7 / FM77AV Display System for Web Emulator
// Handles VRAM (3 bitplanes), TTL/analog palette, sub CPU memory, and canvas rendering.
// Includes full FM77AV ALU (MB61VH010/011) and hardware line drawing engine,

//
// Sub CPU memory map:
//   $0000-$3FFF  VRAM Blue plane   (16KB)
//   $4000-$7FFF  VRAM Red plane    (16KB)
//   $8000-$BFFF  VRAM Green plane  (16KB)
//   $C000-$D37F  Sub CPU work RAM  (0x1380 bytes)
//   $D380-$D3FF  Shared RAM (handled externally in fm7.js)
//   $D400-$D40F  I/O registers (FM-7)
//   $D410-$D42F  I/O registers (FM77AV extended: ALU + line drawer)

const VRAM_SIZE       = 0xC000;  // 48KB per page, 3 planes
const PLANE_SIZE      = 0x4000;  // 16KB per plane
const BLUE_BASE       = 0x0000;
const RED_BASE        = 0x4000;
const GREEN_BASE      = 0x8000;
const WORK_RAM_BASE   = 0xC000;
const WORK_RAM_END    = 0xD37F;
const WORK_RAM_SIZE   = WORK_RAM_END - WORK_RAM_BASE + 1;  // 0x1380
const IO_BASE         = 0xD400;
const IO_END_FM7      = 0xD40F;
const IO_END_AV       = 0xD42B;  // FM77AV extended I/O (ALU registers)

const SCREEN_WIDTH    = 640;
const SCREEN_HEIGHT   = 200;
const BYTES_PER_LINE  = 80;  // 640 / 8
const BYTES_PER_LINE_320 = 40;  // 320 / 8 (analog 320x200 mode)

// FM77AV display modes
const DISPLAY_MODE_640  = 0;  // 640x200, 8 colors (FM-7 compatible)
const DISPLAY_MODE_320  = 1;  // 320x200, 4096 colors (FM77AV)

// Physical RGB colors for TTL 8-color mode (GRB bit order)
// Index = (G << 2) | (R << 1) | B
const PHYSICAL_COLORS = [
    0xFF000000, // 0: Black    (ABGR for little-endian Uint32Array)
    0xFFFF0000, // 1: Blue
    0xFF0000FF, // 2: Red
    0xFFFF00FF, // 3: Magenta
    0xFF00FF00, // 4: Green
    0xFFFFFF00, // 5: Cyan
    0xFF00FFFF, // 6: Yellow
    0xFFFFFFFF, // 7: White
];

// ALU command modes (bits 2-0 of alu_command register $D410)
const ALU_PSET     = 0;
const ALU_PROHIBIT = 1;  // Reserved/disabled - preserves masked bits only
const ALU_OR       = 2;
const ALU_AND      = 3;
const ALU_XOR      = 4;
const ALU_NOT      = 5;
const ALU_TILE     = 6;
const ALU_COMPARE  = 7;

export class Display {
    constructor() {
        // VRAM page 0: 3 bitplanes, 48KB total (FM-7 + FM77AV)
        this._vramBuf = new ArrayBuffer(VRAM_SIZE);
        this.vram = new Uint8Array(this._vramBuf);

        // VRAM page 1: 3 bitplanes, 48KB total (FM77AV only)
        this._vramBuf1 = new ArrayBuffer(VRAM_SIZE);
        this.vramPage1 = new Uint8Array(this._vramBuf1);

        // Sub CPU work RAM: $C000-$D37F (5KB) + $D500-$D7FF (768 bytes, FM77AV only)
        this._workBuf = new ArrayBuffer(0x1680);  // 0x1380 + 0x0300
        this.workRam = new Uint8Array(this._workBuf);

        // TTL Palette: 8 entries, each maps logical color -> physical color
        this.palette = new Uint8Array(8);
        for (let i = 0; i < 8; i++) {
            this.palette[i] = i;
        }

        // Resolved palette: logical index -> ABGR uint32
        this._resolvedPalette = new Uint32Array(8);
        this._rebuildResolvedPalette();

        // FM77AV analog palette: 4096 entries, stored externally in fm7.js
        this.analogPalette = null;       // Uint16Array(4096), set by fm7.js
        this._resolvedAnalogPalette = new Uint32Array(4096);

        // VRAM offset register (scroll offset within each plane)
        // FM77AV: separate offset per page
        this.vramOffset = [0, 0];       // [page0, page1]
        this.vramOffsetFlag = false;    // Extended VRAM offset (bit 2 of $D430)

        // FM77AV VRAM page control
        this.activeVramPage = 0;    // Sub CPU writes to this page (0 or 1)
        this.displayVramPage = 0;   // Renderer reads from this page (0 or 1)
        this.displayMode = DISPLAY_MODE_640;  // 640x200 or 320x200

        // FM77AV mode flag - set by fm7.js when machine type is FM77AV
        this.isAV = false;

        // Multi-page register: bit mask controlling which planes are active
        // bit 0 = blue (plane 0), bit 1 = red (plane 1), bit 2 = green (plane 2)
        // 1 = plane DISABLED (masked), 0 = plane ENABLED
        this.multiPage = 0;

        // ---------------------------------------------------------------
        //  ALU registers ($D410-$D42B) - FM77AV hardware ALU (MB61VH010)
        // ---------------------------------------------------------------
        this.aluCommand   = 0;       // $D410: ALU command register
                                      //   bit 7: ALU enable (1=active)
                                      //   bit 6: compare-write mode
                                      //   bit 5: NOT-equal write (with bit 6)
                                      //   bits 2-0: operation mode
        this.aluColor     = 0;       // $D411: ALU color (bits 2-0 = BGR)
        this.aluMask      = 0;       // $D412: ALU mask (1=preserve original bit)
        this.aluCmpStat   = 0;       // $D413: compare result status (read)
        this.aluCmpDat    = new Uint8Array(8);  // $D413-$D41A: compare data (write)
        this.aluDisable   = 0x00;    // $D41B: plane disable (bit=1 disables ALU on that plane)
        this.aluTileDat   = new Uint8Array(3);  // $D41C-$D41E: tile patterns per plane

        // ---------------------------------------------------------------
        //  Line drawing engine registers ($D420-$D42B)
        // ---------------------------------------------------------------
        this.lineBusy     = false;   // Line drawing busy flag
        this.lineOffset   = 0;       // $D420-$D421: VRAM address offset
        this.lineStyle    = 0;       // $D422-$D423: line style pattern (16-bit)
        this.lineX0       = 0;       // $D424-$D425: X0 coordinate (10-bit)
        this.lineY0       = 0;       // $D426-$D427: Y0 coordinate (9-bit)
        this.lineX1       = 0;       // $D428-$D429: X1 coordinate (10-bit)
        this.lineY1       = 0;       // $D42A-$D42B: Y1 coordinate (9-bit)

        // Internal line drawing state
        this._lineAddrOld = 0xFFFF;  // Previous VRAM address during line draw
        this._lineMask    = 0xFF;    // Current line drawing mask byte
        this._lineCount   = 0;       // Bytes processed during line draw
        this._lineCountSub = 0;      // Sub-byte counter for busy time

        // MISC register ($D430) readback value (maintained by fm7.js)
        this.miscReg = 0;

        // CRT and VRAM access flags (sub CPU I/O side effects)
        this.crtOn = false;
        this.vramaFlag = false;

        // Dirty tracking
        this._dirtyBands = new Uint8Array(25);
        this._fullDirty = true;

        // VSync frame counter
        this.frameCount = 0;

        // Cached ImageData
        this._imageData = null;
        this._pixelBuf = null;
        this._canvas = null;
        this._ctx = null;
    }

    // ---------------------------------------------------------------
    //  Resolved palette cache
    // ---------------------------------------------------------------

    _rebuildResolvedPalette() {
        for (let i = 0; i < 8; i++) {
            this._resolvedPalette[i] = PHYSICAL_COLORS[this.palette[i] & 7];
        }
        this._fullDirty = true;
    }

    // ---------------------------------------------------------------
    //  VRAM array accessors
    // ---------------------------------------------------------------

    /** Get the VRAM array for the active (write) page */
    _getActiveVram() {
        return this.activeVramPage === 0 ? this.vram : this.vramPage1;
    }

    /** Get the VRAM array for the display (read) page */
    _getDisplayVram() {
        return this.displayVramPage === 0 ? this.vram : this.vramPage1;
    }

    // ---------------------------------------------------------------
    //  ALU internal VRAM access helpers
    //  These correspond to alu_read, alu_read_plane, alu_write,
    //  Internal VRAM access helpers for ALU operations
    // ---------------------------------------------------------------

    /**
     * Read a byte from VRAM for ALU operations on a specific plane (bank).
     * Respects the multi_page mask. Returns 0xFF if the plane is masked.
     * @param {number} offset - byte offset within a plane (0..0x3FFF)
     * @param {number} plane - plane number (0=blue, 1=red, 2=green)
     * @returns {number} byte value
     */
    _aluReadPlane(offset, plane) {
        if (this.multiPage & (1 << plane)) {
            return 0xFF;
        }
        const vram = this._getActiveVram();
        // ALU accesses use raw offset (no scroll offset applied)
        return vram[plane * PLANE_SIZE + (offset & (PLANE_SIZE - 1))];
    }

    /**
     * Write a byte to VRAM for ALU operations on a specific plane (bank).
     * Respects the multi_page mask. Skips write if plane is masked.
     * @param {number} offset - byte offset within a plane (0..0x3FFF)
     * @param {number} plane - plane number (0=blue, 1=red, 2=green)
     * @param {number} dat - byte value to write
     */
    _aluWritePlane(offset, plane, dat) {
        if (this.multiPage & (1 << plane)) {
            return;
        }
        const vram = this._getActiveVram();
        // ALU accesses use raw offset (no scroll offset applied)
        const rawOffset = offset & (PLANE_SIZE - 1);
        const addr = plane * PLANE_SIZE + rawOffset;
        if (vram[addr] !== dat) {
            vram[addr] = dat;
            const lineInPlane = (rawOffset / BYTES_PER_LINE) | 0;
            if (lineInPlane < SCREEN_HEIGHT) {
                this._dirtyBands[(lineInPlane >> 3)] = 1;
            }
        }
    }

    /**
     * ALU write sub-routine with compare-write support.
     * ALU write with compare-write mode support.
     * If compare-write mode (bit 6 of aluCommand) is active, the write
     * is masked by the compare status register (aluCmpStat).
     * @param {number} offset - byte offset within a plane
     * @param {number} plane - plane number
     * @param {number} dat - data to write
     */
    _aluWriteSub(offset, plane, dat) {
        // Check if compare-write mode is active
        if ((this.aluCommand & 0x40) === 0) {
            // Normal write
            this._aluWritePlane(offset, plane, dat);
            return;
        }

        // Compare-write mode
        const existing = this._aluReadPlane(offset, plane);
        let temp, result;

        if (this.aluCommand & 0x20) {
            // NOT-equal write: write where compare did NOT match
            temp = existing & this.aluCmpStat;
            dat = dat & (~this.aluCmpStat & 0xFF);
        } else {
            // Equal write: write where compare DID match
            temp = existing & (~this.aluCmpStat & 0xFF);
            dat = dat & this.aluCmpStat;
        }

        this._aluWritePlane(offset, plane, (temp | dat) & 0xFF);
    }

    // ---------------------------------------------------------------
    //  ALU operation implementations
    //  ALU operation implementations
    // ---------------------------------------------------------------

    /**
     * ALU PSET operation: write color to all enabled planes.
     * For each plane: if color bit set, write 0xFF; else write 0x00.
     * Masked bits are preserved from original VRAM data.
     */
    _aluPset(addr) {
        addr &= (PLANE_SIZE - 1);

        // If compare-write mode, run compare first
        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                // Color data: all 1s or all 0s based on color bit
                let dat = (this.aluColor & bit) ? 0xFF : 0x00;

                // Read existing for mask
                const mask = this._aluReadPlane(addr, plane);

                // Apply mask: preserve bits where aluMask=1
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);

                // Write with compare-write support
                this._aluWriteSub(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU PROHIBIT operation (command 1): preserves masked bits only.
     * Effectively clears unmasked bits while keeping masked bits.
     */
    _aluProhibit(addr) {
        addr &= (PLANE_SIZE - 1);

        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                const mask = this._aluReadPlane(addr, plane);
                const dat = mask & this.aluMask;
                this._aluWriteSub(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU OR operation: OR color with existing VRAM data.
     */
    _aluOr(addr) {
        addr &= (PLANE_SIZE - 1);

        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                let dat = (this.aluColor & bit) ? 0xFF : 0x00;
                const mask = this._aluReadPlane(addr, plane);
                dat |= mask;
                // Apply mask bits
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteSub(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU AND operation: AND color with existing VRAM data.
     */
    _aluAnd(addr) {
        addr &= (PLANE_SIZE - 1);

        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                let dat = (this.aluColor & bit) ? 0xFF : 0x00;
                const mask = this._aluReadPlane(addr, plane);
                dat &= mask;
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteSub(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU XOR operation: XOR color with existing VRAM data.
     */
    _aluXor(addr) {
        addr &= (PLANE_SIZE - 1);

        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                let dat = (this.aluColor & bit) ? 0xFF : 0x00;
                const mask = this._aluReadPlane(addr, plane);
                dat ^= mask;
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteSub(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU NOT operation: invert existing VRAM data.
     */
    _aluNot(addr) {
        addr &= (PLANE_SIZE - 1);

        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                const mask = this._aluReadPlane(addr, plane);
                let dat = (~mask) & 0xFF;
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteSub(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU TILE operation: write tile pattern data to planes.
     * Each plane gets its own tile byte from aluTileDat[plane].
     */
    _aluTile(addr) {
        addr &= (PLANE_SIZE - 1);

        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                let dat = this.aluTileDat[plane];
                // Apply mask
                const mask = this._aluReadPlane(addr, plane);
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteSub(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU COMPARE operation: compare VRAM colors against compare registers.
     * For each of the 8 pixel positions in the byte, extract the 3-bit color
     * from the 3 planes, then check if that color matches any of the 8
     * compare data registers (that are enabled with bit 7 = 0).
     * Result bits are set in aluCmpStat.
     */
    _aluCompare(addr) {
        addr &= (PLANE_SIZE - 1);

        // Read all three planes
        const b = this._aluReadPlane(addr, 0);
        const r = this._aluReadPlane(addr, 1);
        const g = this._aluReadPlane(addr, 2);

        // Bank disable mask (inverted: bits that are NOT disabled)
        const disMask = (~this.aluDisable) & 0x07;

        let result = 0;
        let bitPos = 0x80;

        for (let i = 0; i < 8; i++) {
            // Extract color at this bit position
            let color = 0;
            if (b & bitPos) color |= 0x01;
            if (r & bitPos) color |= 0x02;
            if (g & bitPos) color |= 0x04;

            // Check against all 8 compare slots
            let matched = false;
            for (let j = 0; j < 8; j++) {
                // bit 7 = 0 means this slot is active
                if ((this.aluCmpDat[j] & 0x80) === 0) {
                    if ((this.aluCmpDat[j] & disMask) === (color & disMask)) {
                        matched = true;
                        break;
                    }
                }
            }

            if (matched) {
                result |= bitPos;
            }

            bitPos >>= 1;
        }

        this.aluCmpStat = result;
    }

    /**
     * Execute ALU operation on the given VRAM address.
     * Called from the line drawing engine.
     * Uses the line drawing mask (_lineMask) instead of aluMask.
     */
    _aluLineExec(addr) {
        if (addr >= 0x8000) {
            this._lineMask = 0xFF;
            return;
        }

        // Save and set mask from line engine
        const savedMask = this.aluMask;
        this.aluMask = this._lineMask;
        this._lineMask = 0xFF;

        // Dispatch ALU operation
        this._dispatchAluOp(addr);

        // Restore mask
        this.aluMask = savedMask;

        // Count bytes processed
        this._lineCount++;
    }

    /**
     * Execute ALU operation triggered by VRAM read/write.
     * Called when ALU is enabled (bit 7 of aluCommand) and sub CPU
     * reads or writes VRAM.
     */
    _aluExtrb(addr) {
        if (!(this.aluCommand & 0x80)) {
            return;
        }
        this._dispatchAluOp(addr);
    }

    /**
     * Dispatch to the correct ALU operation based on command bits 2-0.
     */
    _dispatchAluOp(addr) {
        switch (this.aluCommand & 0x07) {
            case ALU_PSET:     this._aluPset(addr);     break;
            case ALU_PROHIBIT: this._aluProhibit(addr); break;
            case ALU_OR:       this._aluOr(addr);       break;
            case ALU_AND:      this._aluAnd(addr);      break;
            case ALU_XOR:      this._aluXor(addr);      break;
            case ALU_NOT:      this._aluNot(addr);      break;
            case ALU_TILE:     this._aluTile(addr);     break;
            case ALU_COMPARE:  this._aluCompare(addr);  break;
        }
    }

    // ---------------------------------------------------------------
    //  Hardware Line Drawing Engine
    //  Hardware line drawing engine using Bresenham's algorithm
    // ---------------------------------------------------------------

    /**
     * Plot a single pixel during line drawing.
     * Accumulates a mask byte and triggers ALU execution when
     * the address changes to the next byte.
     * Plot a pixel during line drawing, accumulating mask bytes.
     */
    _linePset(x, y) {
        // ALU must be enabled for line drawing
        if (!(this.aluCommand & 0x80)) {
            return;
        }

        // Calculate VRAM byte address from (x, y) coordinates
        let addr;
        if (this.displayMode === DISPLAY_MODE_320) {
            // 320x200 analog mode: 40 bytes per line
            addr = (y * BYTES_PER_LINE_320 + (x >> 3)) & 0xFFFF;
        } else {
            // 640x200 digital mode: 80 bytes per line
            addr = (y * BYTES_PER_LINE + (x >> 3)) & 0xFFFF;
        }

        // Add line offset
        addr = (addr + this.lineOffset) & (PLANE_SIZE - 1);

        // If address changed from previous pixel, flush the ALU for the old address
        if (this._lineAddrOld !== addr) {
            this._aluLineExec(this._lineAddrOld);
            this._lineAddrOld = addr;
        }

        // Apply line style: only set pixel if current style bit is 1
        if (this.lineStyle & 0x8000) {
            // Pixel mask table: clears the bit for this pixel's position
            const pixMask = [0x7F, 0xBF, 0xDF, 0xEF, 0xF7, 0xFB, 0xFD, 0xFE];
            this._lineMask &= pixMask[x & 0x07];
        }

        // Rotate line style pattern (16-bit left rotate)
        this.lineStyle = ((this.lineStyle << 1) | (this.lineStyle >>> 15)) & 0xFFFF;
    }

    /**
     * Execute hardware line drawing using Bresenham's algorithm.
     * Triggered by writing to $D42B (Y1 low byte).
     * Execute hardware line drawing using Bresenham's algorithm.
     */
    _lineDrawExec() {
        let x1 = this.lineX0;
        let x2 = this.lineX1;
        let y1 = this.lineY0;
        let y2 = this.lineY1;

        // Initialize line drawing state
        this._lineCount = 0;
        this._lineAddrOld = 0xFFFF;
        this._lineMask = 0xFF;

        // Calculate deltas and step directions
        let dx = x2 - x1;
        let dy = y2 - y1;
        let ux, uy;

        if (dx < 0) {
            ux = -1;
            dx = -dx;
        } else {
            ux = 1;
        }

        if (dy < 0) {
            uy = -1;
            dy = -dy;
        } else {
            uy = 1;
        }

        if (dx === 0 && dy === 0) {
            // Single point
            this._linePset(x1, y1);
        } else if (dx === 0) {
            // Vertical line
            for (;;) {
                this._linePset(x1, y1);
                if (y1 === y2) break;
                y1 += uy;
            }
        } else if (dy === 0) {
            // Horizontal line
            for (;;) {
                this._linePset(x1, y1);
                if (x1 === x2) break;
                x1 += ux;
            }
        } else if (dx >= dy) {
            // Shallow line (DX >= DY)
            let r = dx >> 1;
            for (;;) {
                this._linePset(x1, y1);
                if (x1 === x2) break;
                x1 += ux;
                r -= dy;
                if (r < 0) {
                    r += dx;
                    y1 += uy;
                }
            }
        } else {
            // Steep line (DX < DY)
            let r = dy >> 1;
            for (;;) {
                this._linePset(x1, y1);
                if (y1 === y2) break;
                y1 += uy;
                r -= dx;
                if (r < 0) {
                    r += dy;
                    x1 += ux;
                }
            }
        }

        // Flush the last byte's ALU operation
        this._aluLineExec(this._lineAddrOld);

        // Calculate busy time (1 byte = 1/16 microsecond)
        // We set lineBusy but since we execute instantly in JS,
        // we'll track the count for status reads
        let busyTime = this._lineCount >> 4;
        this._lineCountSub += (this._lineCount & 0x0F);
        if (this._lineCountSub >= 0x10) {
            busyTime++;
            this._lineCountSub &= 0x0F;
        }

        if (busyTime > 0) {
            this.lineBusy = true;
            // In a real emulator we'd schedule an event to clear this.
            // For our web emulator, we clear it immediately since we
            // don't have cycle-accurate timing for line drawing.
            // Software that polls $D430 bit 4 will see it clear.
            this.lineBusy = false;
        }
    }

    // ---------------------------------------------------------------
    //  VRAM read/write with ALU interception
    // ---------------------------------------------------------------

    readVRAM(addr) {
        addr &= 0xFFFF;
        if (addr >= VRAM_SIZE) return 0xFF;

        const plane = (addr / PLANE_SIZE) | 0;
        const rawOffset = addr % PLANE_SIZE;

        // FM77AV: ALU intercept on read
        // On the real MB61VH010, VRAM reads with ALU enabled trigger the
        // full ALU operation (same as writes). This is used by programs to
        // erase graphics: set ALU to PSET with color 0, then READ VRAM
        // at the target address — the ALU writes black to all planes.
        if (this.isAV && (this.aluCommand & 0x80)) {
            this._dispatchAluOp(rawOffset);
        }
        if (this.isAV && (this.multiPage & (1 << plane))) {
            return 0xFF;
        }

        // No scroll offset applied - scroll is renderer-only
        const vram = this._getActiveVram();
        return vram[addr];
    }

    writeVRAM(addr, value) {
        addr &= 0xFFFF;
        if (addr >= VRAM_SIZE) return;

        const plane = (addr / PLANE_SIZE) | 0;
        const rawOffset = addr % PLANE_SIZE;

        // FM77AV: when ALU is enabled, writes trigger ALU operation (uses raw offset)
        // The write data from the CPU is ignored; the ALU determines what gets written.
        if (this.isAV && (this.aluCommand & 0x80)) {
            this._dispatchAluOp(rawOffset);
            return;
        }

        // Normal write - no scroll offset (scroll is renderer-only)
        if (this.multiPage & (1 << plane)) {
            return;
        }

        const vram = this._getActiveVram();

        if (vram[addr] !== value) {
            vram[addr] = value;
            // Calculate screen line accounting for VRAM offset (hardware scroll)
            // With non-zero offset, VRAM address doesn't directly map to screen line
            const offset = this.getDisplayVramOffset();
            const screenByte = (rawOffset - offset + PLANE_SIZE) % PLANE_SIZE;
            const screenLine = (screenByte / BYTES_PER_LINE) | 0;
            if (screenLine < SCREEN_HEIGHT) {
                this._dirtyBands[(screenLine >> 3)] = 1;
            }
        }
    }

    // ---------------------------------------------------------------
    //  Sub CPU memory read/write  ($0000 - $D40F)
    // ---------------------------------------------------------------

    read(addr) {
        addr &= 0xFFFF;
        if (addr < VRAM_SIZE) {
            return this.readVRAM(addr);
        }
        if (addr >= WORK_RAM_BASE && addr <= WORK_RAM_END) {
            return this.workRam[addr - WORK_RAM_BASE];
        }
        if (addr >= IO_BASE && addr <= IO_END_AV) {
            const result = this.readIO(addr);
            return result.value;
        }
        return 0xFF;
    }

    write(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;
        if (addr < VRAM_SIZE) {
            this.writeVRAM(addr, value);
            return;
        }
        if (addr >= WORK_RAM_BASE && addr <= WORK_RAM_END) {
            this.workRam[addr - WORK_RAM_BASE] = value;
            return;
        }
        if (addr >= IO_BASE && addr <= IO_END_AV) {
            this.writeIO(addr, value);
            return;
        }
    }

    // ---------------------------------------------------------------
    //  I/O register read ($D400 - $D42F)
    // ---------------------------------------------------------------

    readIO(addr) {
        addr &= 0xFFFF;

        switch (addr) {
            case 0xD402:
                return { value: 0xFF, sideEffect: 'cancelAck' };
            case 0xD403:
                return { value: 0xFF, sideEffect: 'beep' };
            case 0xD404:
                return { value: 0xFF, sideEffect: 'attention' };
            case 0xD408:
                this.crtOn = true;
                return { value: 0xFF };
            case 0xD409:
                this.vramaFlag = true;
                return { value: 0xFF };
            case 0xD40A:
                return { value: 0xFF, sideEffect: 'busyOff' };
            case 0xD40E: {
                // VRAM offset high byte read-back
                const pg = this.activeVramPage;
                return { value: (this.vramOffset[pg] >> 8) & 0x3F };
            }
            case 0xD40F: {
                // VRAM offset low byte read-back
                const pg = this.activeVramPage;
                return { value: this.vramOffset[pg] & 0xFF };
            }
        }

        // FM77AV ALU registers ($D410-$D42B)
        if (this.isAV && addr >= 0xD410 && addr <= 0xD42B) {
            switch (addr) {
                case 0xD410: return { value: this.aluCommand };
                case 0xD411: return { value: this.aluColor };
                case 0xD412: return { value: this.aluMask };
                case 0xD413: return { value: this.aluCmpStat };
                case 0xD41B: return { value: this.aluDisable };
            }
            // $D414-$D41A: compare data (write-only, read returns 0xFF)
            if (addr >= 0xD413 && addr <= 0xD41A) {
                return { value: 0xFF };
            }
            // $D41C-$D41E: tile patterns (write-only, read returns 0xFF)
            if (addr >= 0xD41C && addr <= 0xD41E) {
                return { value: 0xFF };
            }
            // $D420-$D42B: line drawing registers (write-only, read returns 0xFF)
            if (addr >= 0xD420 && addr <= 0xD42B) {
                return { value: 0xFF };
            }
        }

        return { value: 0xFF };
    }

    // ---------------------------------------------------------------
    //  I/O register write ($D400 - $D42F)
    // ---------------------------------------------------------------

    writeIO(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;

        switch (addr) {
            case 0xD408:
                this.crtOn = false;
                return {};
            case 0xD409:
                this.vramaFlag = false;
                return {};
            case 0xD40A:
                return { sideEffect: 'busyOn' };

            case 0xD40E:
                this._updateVramOffsetHigh(value);
                return {};
            case 0xD40F:
                this._updateVramOffsetLow(value);
                return {};
        }

        // FM77AV ALU registers ($D410-$D42B)
        if (this.isAV && addr >= 0xD410 && addr <= 0xD42B) {
            switch (addr) {
                // ALU command register
                case 0xD410:
                    this.aluCommand = value;
                    return {};
                // ALU color
                case 0xD411:
                    this.aluColor = value;
                    return {};
                // ALU mask
                case 0xD412:
                    this.aluMask = value;
                    return {};
                // ALU plane disable
                case 0xD41B:
                    this.aluDisable = value;
                    return {};

                // Line drawing: address offset (A1 and up; stored as even addresses)
                case 0xD420:
                    // High byte: bits map to offset bits 13-9
                    this.lineOffset = (this.lineOffset & 0x01FE) | ((value * 512) & 0x3E00);
                    return {};
                case 0xD421:
                    // Low byte: bits map to offset bits 8-1
                    this.lineOffset = (this.lineOffset & 0x3E00) | (value * 2);
                    return {};

                // Line style
                case 0xD422:
                    this.lineStyle = (this.lineStyle & 0x00FF) | (value << 8);
                    return {};
                case 0xD423:
                    this.lineStyle = (this.lineStyle & 0xFF00) | value;
                    return {};

                // X0 coordinate (10-bit)
                case 0xD424:
                    this.lineX0 = ((this.lineX0 & 0x00FF) | (value << 8)) & 0x03FF;
                    return {};
                case 0xD425:
                    this.lineX0 = (this.lineX0 & 0xFF00) | value;
                    return {};

                // Y0 coordinate (9-bit)
                case 0xD426:
                    this.lineY0 = ((this.lineY0 & 0x00FF) | (value << 8)) & 0x01FF;
                    return {};
                case 0xD427:
                    this.lineY0 = (this.lineY0 & 0xFF00) | value;
                    return {};

                // X1 coordinate (10-bit)
                case 0xD428:
                    this.lineX1 = ((this.lineX1 & 0x00FF) | (value << 8)) & 0x03FF;
                    return {};
                case 0xD429:
                    this.lineX1 = (this.lineX1 & 0xFF00) | value;
                    return {};

                // Y1 coordinate (9-bit)
                case 0xD42A:
                    this.lineY1 = ((this.lineY1 & 0x00FF) | (value << 8)) & 0x01FF;
                    return {};

                // Y1 low byte: writing triggers line drawing!
                case 0xD42B:
                    this.lineY1 = (this.lineY1 & 0xFF00) | value;
                    // Execute line drawing
                    this._lineDrawExec();
                    return {};
            }

            // $D413-$D41A: compare data registers
            if (addr >= 0xD413 && addr <= 0xD41A) {
                this.aluCmpDat[addr - 0xD413] = value;
                return {};
            }

            // $D41C-$D41E: tile pattern registers
            if (addr >= 0xD41C && addr <= 0xD41E) {
                this.aluTileDat[addr - 0xD41C] = value;
                return {};
            }

            return {};
        }

        return {};
    }

    // ---------------------------------------------------------------
    //  Palette
    // ---------------------------------------------------------------

    readPalette(index) {
        index &= 7;
        return this.palette[index];
    }

    writePalette(index, value) {
        index &= 7;
        value &= 7;
        if (this.palette[index] !== value) {
            this.palette[index] = value;
            this._rebuildResolvedPalette();
        }
    }

    resetPalette() {
        for (let i = 0; i < 8; i++) {
            this.palette[i] = i;
        }
        this._rebuildResolvedPalette();
    }

    // ---------------------------------------------------------------
    //  VRAM offset (scroll)
    // ---------------------------------------------------------------

    /** Write VRAM offset high byte — applied to the active page's offset */
    _updateVramOffsetHigh(value) {
        const pg = this.activeVramPage;
        const high = (value & 0x3F) << 8;
        this._pendingOffsetHigh = high;
    }

    /** Write VRAM offset low byte — applied to the active page's offset */
    _updateVramOffsetLow(value) {
        const pg = this.activeVramPage;
        // FM77AV: When extended offset flag is OFF, low 5 bits are masked
        // FM-7: no masking, all 14 bits of offset are used (MC6845 native)
        // FM77AV: extended offset flag ($D430 bit2) controls whether low
        // 5 bits of $D40F are used. When OFF, original hardware masks them.
        // However, Type-C ROM (F-BASIC) doesn't set this flag and expects
        // FM-7 compatible full-range offsets. Since our software scroll
        // always needs the full offset value to rotate correctly, we skip
        // the masking entirely — it only matters for hardware scroll which
        // we don't use in the renderer.
        // (The masking would only be needed for a true hardware scroll
        // implementation where the offset directly controls display start.)
        const high = (this._pendingOffsetHigh !== undefined)
            ? this._pendingOffsetHigh : (this.vramOffset[pg] & 0x3F00);
        this._pendingOffsetHigh = undefined;
        const newOffset = high | value;

        // Software scroll: physically rotate VRAM data so the sub CPU's
        // fixed addresses always match screen positions. Used by both FM-7
        // and FM77AV in BASIC/Type-C mode.
        // FM-7 ROM sends the same offset each scroll (workRam reset makes it
        // re-calculate from 0). FM77AV ROM sends cumulative offsets.
        // Use _scrollApplied to track cumulative rotation for FM77AV only.
        if (!this._scrollApplied) this._scrollApplied = [0, 0];
        const oldOffset = this.isAV ? this._scrollApplied[pg] : this.vramOffset[pg];
        const scrollAmount = (newOffset - oldOffset + PLANE_SIZE) % PLANE_SIZE;

        if (scrollAmount > 0 && scrollAmount < PLANE_SIZE / 2) {
            const vram = this._getActiveVram();
            for (let plane = 0; plane < 3; plane++) {
                const base = plane * PLANE_SIZE;
                const temp = new Uint8Array(scrollAmount);
                for (let i = 0; i < scrollAmount; i++) {
                    temp[i] = vram[base + ((oldOffset + i) % PLANE_SIZE)];
                }
                for (let i = 0; i < PLANE_SIZE - scrollAmount; i++) {
                    const src = (oldOffset + scrollAmount + i) % PLANE_SIZE;
                    const dst = (oldOffset + i) % PLANE_SIZE;
                    vram[base + dst] = vram[base + src];
                }
                for (let i = 0; i < scrollAmount; i++) {
                    const dst = (oldOffset + PLANE_SIZE - scrollAmount + i) % PLANE_SIZE;
                    vram[base + dst] = temp[i];
                }
            }
        }

        // Track cumulative rotation; keep display offset at 0
        this._scrollApplied[pg] = newOffset;
        this.vramOffset[pg] = 0;

        // Reset the sub CPU's software mirror of the offset.
        // FM-7 ROM re-calculates from 0 each scroll, so we must reset.
        // FM77AV ROM sends cumulative offsets based on work RAM, so
        // resetting would break the next scroll (ROM would re-send the
        // same value, giving scrollAmount=0).
        if (this.workRam && !this.isAV) {
            this.workRam[0x101F] = 0;
            this.workRam[0x1020] = 0;
        }

        this._fullDirty = true;
    }

    /** Get the display page's VRAM offset (for rendering) */
    getDisplayVramOffset() {
        return this.vramOffset[this.displayVramPage];
    }

    // ---------------------------------------------------------------
    //  FM77AV: VRAM page and display mode control
    // ---------------------------------------------------------------

    _setActiveVramPage(page) {
        page &= 1;
        if (this.activeVramPage !== page) {
            this.activeVramPage = page;
        }
    }

    _setDisplayVramPage(page) {
        page &= 1;
        if (this.displayVramPage !== page) {
            this.displayVramPage = page;
            this._fullDirty = true;
        }
    }

    _setDisplayMode(mode) {
        if (this.displayMode !== mode) {
            this.displayMode = mode;
            this._fullDirty = true;
        }
    }

    // ---------------------------------------------------------------
    //  FM77AV: Analog palette
    // ---------------------------------------------------------------

    rebuildAnalogPalette(analogPalette) {
        for (let i = 0; i < 4096; i++) {
            const entry = analogPalette[i];
            const b4 = (entry >> 8) & 0x0F;
            const r4 = (entry >> 4) & 0x0F;
            const g4 = entry & 0x0F;
            this._resolvedAnalogPalette[i] =
                0xFF000000 | ((b4 * 17) << 16) | ((g4 * 17) << 8) | (r4 * 17);
        }
    }

    // ---------------------------------------------------------------
    //  VSync
    // ---------------------------------------------------------------

    vsync() {
        this.frameCount++;
    }

    // ---------------------------------------------------------------
    //  Rendering
    // ---------------------------------------------------------------

    render(canvas, force = false) {
        if (this.displayMode === DISPLAY_MODE_320) {
            return this._render320x200(canvas, force);
        }
        return this._render640x200(canvas, force);
    }

    _render640x200(canvas, force = false) {
        if (this._canvas !== canvas || !this._ctx) {
            this._canvas = canvas;
            canvas.width = SCREEN_WIDTH;
            canvas.height = SCREEN_HEIGHT;
            this._ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
            this._imageData = this._ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
            this._pixelBuf = new Uint32Array(this._imageData.data.buffer);
            this._fullDirty = true;
        }

        const needFull = this._fullDirty || force;

        if (!needFull) {
            let anyDirty = false;
            for (let b = 0; b < 25; b++) {
                if (this._dirtyBands[b]) { anyDirty = true; break; }
            }
            if (!anyDirty) return;
        }

        const pixels = this._pixelBuf;
        const displayVram = this._getDisplayVram();
        const blue  = displayVram;
        const red   = displayVram;
        const green = displayVram;
        const pal   = this._resolvedPalette;
        const offset = this.getDisplayVramOffset();

        for (let band = 0; band < 25; band++) {
            if (!needFull && !this._dirtyBands[band]) continue;

            const yStart = band << 3;
            const yEnd = Math.min(yStart + 8, SCREEN_HEIGHT);

            for (let y = yStart; y < yEnd; y++) {
                const lineBase = ((y * BYTES_PER_LINE + offset) % PLANE_SIZE);
                const pixelRow = y * SCREEN_WIDTH;

                for (let byteX = 0; byteX < BYTES_PER_LINE; byteX++) {
                    const byteAddr = (lineBase + byteX) % PLANE_SIZE;
                    // multiPage bits 4-6: display mask (1=plane hidden)
                    const bByte = (this.multiPage & 0x10) ? 0 : blue [BLUE_BASE  + byteAddr];
                    const rByte = (this.multiPage & 0x20) ? 0 : red  [RED_BASE   + byteAddr];
                    const gByte = (this.multiPage & 0x40) ? 0 : green[GREEN_BASE + byteAddr];
                    const px = pixelRow + (byteX << 3);

                    pixels[px    ] = pal[((gByte >> 7) & 1) << 2 | ((rByte >> 7) & 1) << 1 | ((bByte >> 7) & 1)];
                    pixels[px + 1] = pal[((gByte >> 6) & 1) << 2 | ((rByte >> 6) & 1) << 1 | ((bByte >> 6) & 1)];
                    pixels[px + 2] = pal[((gByte >> 5) & 1) << 2 | ((rByte >> 5) & 1) << 1 | ((bByte >> 5) & 1)];
                    pixels[px + 3] = pal[((gByte >> 4) & 1) << 2 | ((rByte >> 4) & 1) << 1 | ((bByte >> 4) & 1)];
                    pixels[px + 4] = pal[((gByte >> 3) & 1) << 2 | ((rByte >> 3) & 1) << 1 | ((bByte >> 3) & 1)];
                    pixels[px + 5] = pal[((gByte >> 2) & 1) << 2 | ((rByte >> 2) & 1) << 1 | ((bByte >> 2) & 1)];
                    pixels[px + 6] = pal[((gByte >> 1) & 1) << 2 | ((rByte >> 1) & 1) << 1 | ((bByte >> 1) & 1)];
                    pixels[px + 7] = pal[( gByte       & 1) << 2 | ( rByte       & 1) << 1 | ( bByte       & 1)];
                }
            }
        }

        if (needFull) {
            this._ctx.putImageData(this._imageData, 0, 0);
        } else {
            for (let band = 0; band < 25; band++) {
                if (!this._dirtyBands[band]) continue;
                const yStart = band << 3;
                const h = Math.min(8, SCREEN_HEIGHT - yStart);
                this._ctx.putImageData(this._imageData, 0, 0,
                    0, yStart, SCREEN_WIDTH, h);
            }
        }

        this._fullDirty = false;
        this._dirtyBands.fill(0);
    }

    _render320x200(canvas, force = false) {
        if (this._canvas !== canvas || !this._ctx) {
            this._canvas = canvas;
            canvas.width = SCREEN_WIDTH;
            canvas.height = SCREEN_HEIGHT;
            this._ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
            this._imageData = this._ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
            this._pixelBuf = new Uint32Array(this._imageData.data.buffer);
            this._fullDirty = true;
        }

        if (this.analogPalette) {
            this.rebuildAnalogPalette(this.analogPalette);
        }

        const pixels = this._pixelBuf;
        const page0 = this.vram;
        const page1 = this.vramPage1;
        const pal = this._resolvedAnalogPalette;
        const offset = this.getDisplayVramOffset() & 0x1FFF;

        // FM77AV 320x200, 4096-color mode:
        // 40 bytes per line, 8 pixels per byte, each pixel doubled on 640-wide display
        // 12 sub-planes of 0x2000 bytes each, spread across both VRAM pages
        //
        // Sub-plane layout (verified against reference renderer):
        // Base = page1 offset 0 (vram_c + 0xC000 in contiguous layout)
        //   b0 = page0[0x0000+ofs]  b1 = page0[0x2000+ofs]  (Blue: page0 B plane halves)
        //   b2 = page1[0x0000+ofs]  b3 = page1[0x2000+ofs]  (Blue: page1 B plane halves)
        //   r0 = page0[0x4000+ofs]  r1 = page0[0x6000+ofs]  (Red:  page0 R plane halves)
        //   r2 = page1[0x4000+ofs]  r3 = page1[0x6000+ofs]  (Red:  page1 R plane halves)
        //   g0 = page0[0x8000+ofs]  g1 = page0[0xA000+ofs]  (Green: page0 G plane halves)
        //   g2 = page1[0x8000+ofs]  g3 = page1[0xA000+ofs]  (Green: page1 G plane halves)
        //
        // Palette index: g0<<11 | g1<<10 | g2<<9 | g3<<8 | r0<<7 | r1<<6 | r2<<5 | r3<<4 | b0<<3 | b1<<2 | b2<<1 | b3

        const HALF_PLANE = 0x2000;

        for (let y = 0; y < SCREEN_HEIGHT; y++) {
            const lineOfs = ((y * BYTES_PER_LINE_320 + offset) % HALF_PLANE);
            const pixelRow = y * SCREEN_WIDTH;

            for (let byteX = 0; byteX < BYTES_PER_LINE_320; byteX++) {
                const ofs = (lineOfs + byteX) % HALF_PLANE;

                // Read 12 sub-plane bytes (matching reference layout)
                const b0 = page0[0x0000 + ofs];
                const b1 = page0[0x2000 + ofs];
                const r0 = page0[0x4000 + ofs];
                const r1 = page0[0x6000 + ofs];
                const g0 = page0[0x8000 + ofs];
                const g1 = page0[0xA000 + ofs];
                const b2 = page1[0x0000 + ofs];
                const b3 = page1[0x2000 + ofs];
                const r2 = page1[0x4000 + ofs];
                const r3 = page1[0x6000 + ofs];
                const g2 = page1[0x8000 + ofs];
                const g3 = page1[0xA000 + ofs];

                for (let bit = 7; bit >= 0; bit--) {
                    const idx =
                        (((g0 >> bit) & 1) << 11) |
                        (((g1 >> bit) & 1) << 10) |
                        (((g2 >> bit) & 1) <<  9) |
                        (((g3 >> bit) & 1) <<  8) |
                        (((r0 >> bit) & 1) <<  7) |
                        (((r1 >> bit) & 1) <<  6) |
                        (((r2 >> bit) & 1) <<  5) |
                        (((r3 >> bit) & 1) <<  4) |
                        (((b0 >> bit) & 1) <<  3) |
                        (((b1 >> bit) & 1) <<  2) |
                        (((b2 >> bit) & 1) <<  1) |
                        (((b3 >> bit) & 1));

                    const color = pal[idx];
                    const destX = pixelRow + (byteX * 16) + ((7 - bit) * 2);
                    pixels[destX]     = color;
                    pixels[destX + 1] = color;
                }
            }
        }

        this._ctx.putImageData(this._imageData, 0, 0);
        this._fullDirty = false;
        this._dirtyBands.fill(0);
    }

    renderDoubled(canvas, force = false) {
        if (!this._offscreenCanvas) {
            this._offscreenCanvas = new OffscreenCanvas(SCREEN_WIDTH, SCREEN_HEIGHT);
        }
        const savedCanvas = this._canvas;
        const savedCtx = this._ctx;
        const savedImageData = this._imageData;
        const savedPixelBuf = this._pixelBuf;

        this._canvas = null;
        this.render(this._offscreenCanvas, force);

        this._canvas = savedCanvas;
        this._ctx = savedCtx;
        this._imageData = savedImageData;
        this._pixelBuf = savedPixelBuf;

        canvas.width = SCREEN_WIDTH;
        canvas.height = SCREEN_HEIGHT * 2;
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this._offscreenCanvas, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT * 2);
    }

    // ---------------------------------------------------------------
    //  Bulk operations
    // ---------------------------------------------------------------

    loadVRAM(data) {
        const src = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (src.length !== VRAM_SIZE) {
            throw new Error(`VRAM data must be ${VRAM_SIZE} bytes, got ${src.length}`);
        }
        this.vram.set(src);
        this._fullDirty = true;
    }

    clearVRAM() {
        this.vram.fill(0);
        this.vramPage1.fill(0);
        this._fullDirty = true;
    }

    clearWorkRam() {
        this.workRam.fill(0);
    }

    /**
     * Reset ALU and line drawing engine to power-on state.
     * Called when sub CPU is reset via $FD13.
     */
    resetALU() {
        this.aluCommand = 0;
        this.aluColor = 0;
        this.aluMask = 0;
        this.aluCmpStat = 0;
        this.aluCmpDat.fill(0x80);
        this.aluDisable = 0x00;
        this.aluTileDat.fill(0);

        this.lineBusy = false;
        this.lineOffset = 0;
        this.lineStyle = 0;
        this.lineX0 = 0;
        this.lineY0 = 0;
        this.lineX1 = 0;
        this.lineY1 = 0;
        this._lineAddrOld = 0xFFFF;
        this._lineMask = 0xFF;
        this._lineCount = 0;
        this._lineCountSub = 0;
    }

    /**
     * Full reset: clear VRAM, work RAM, reset palette, ALU, line engine.
     */
    reset() {
        this.clearVRAM();
        this.clearWorkRam();
        this.resetPalette();
        this.vramOffset = [0, 0];
        this._scrollApplied = [0, 0];
        this._vramOffsetCount = [0, 0];
        this.vramOffsetFlag = false;
        this.crtOn = false;
        this.vramaFlag = false;
        this.frameCount = 0;
        this.activeVramPage = 0;
        this.displayVramPage = 0;
        this.displayMode = DISPLAY_MODE_640;
        this.multiPage = 0;

        // Reset ALU and line drawing engine
        this.resetALU();

        this.miscReg = 0;
        this._resolvedAnalogPalette.fill(0xFF000000);
        this._fullDirty = true;
    }

    // ---------------------------------------------------------------
    //  Debug / inspection helpers
    // ---------------------------------------------------------------

    getPixelColor(x, y) {
        if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return 0;
        const byteOffset = (y * BYTES_PER_LINE + Math.floor(x / 8) + this.getDisplayVramOffset()) % PLANE_SIZE;
        const bit = 7 - (x & 7);
        const b = (this.vram[BLUE_BASE  + byteOffset] >> bit) & 1;
        const r = (this.vram[RED_BASE   + byteOffset] >> bit) & 1;
        const g = (this.vram[GREEN_BASE + byteOffset] >> bit) & 1;
        return (g << 2) | (r << 1) | b;
    }

    setPixel(x, y, colorIndex) {
        if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return;
        const byteOffset = (y * BYTES_PER_LINE + Math.floor(x / 8) + this.getDisplayVramOffset()) % PLANE_SIZE;
        const bit = 7 - (x & 7);
        const mask = 1 << bit;
        const invMask = ~mask & 0xFF;

        const bAddr = BLUE_BASE  + byteOffset;
        const rAddr = RED_BASE   + byteOffset;
        const gAddr = GREEN_BASE + byteOffset;

        this.vram[bAddr] = (colorIndex & 1) ? (this.vram[bAddr] | mask) : (this.vram[bAddr] & invMask);
        this.vram[rAddr] = (colorIndex & 2) ? (this.vram[rAddr] | mask) : (this.vram[rAddr] & invMask);
        this.vram[gAddr] = (colorIndex & 4) ? (this.vram[gAddr] | mask) : (this.vram[gAddr] & invMask);

        this._dirtyBands[(y >> 3)] = 1;
    }

    drawHLine(x0, x1, y, colorIndex) {
        for (let x = x0; x <= x1; x++) {
            this.setPixel(x, y, colorIndex);
        }
    }

    fillRect(x0, y0, w, h, colorIndex) {
        for (let y = y0; y < y0 + h && y < SCREEN_HEIGHT; y++) {
            for (let x = x0; x < x0 + w && x < SCREEN_WIDTH; x++) {
                this.setPixel(x, y, colorIndex);
            }
        }
    }
}
