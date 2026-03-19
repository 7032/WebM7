// FM-7 Display System for Web Emulator
// Handles VRAM (3 bitplanes), TTL palette, sub CPU memory, and canvas rendering.

// Sub CPU memory map:
//   $0000-$3FFF  VRAM Blue plane   (16KB)
//   $4000-$7FFF  VRAM Red plane    (16KB)
//   $8000-$BFFF  VRAM Green plane  (16KB)
//   $C000-$D37F  Sub CPU work RAM  (0x1380 bytes)
//   $D380-$D3FF  (reserved/unused gap)
//   $D400-$D40F  I/O registers

const VRAM_SIZE       = 0xC000;  // 48KB, 3 planes
const PLANE_SIZE      = 0x4000;  // 16KB per plane
const BLUE_BASE       = 0x0000;
const RED_BASE        = 0x4000;
const GREEN_BASE      = 0x8000;
const WORK_RAM_BASE   = 0xC000;
const WORK_RAM_END    = 0xD37F;
const WORK_RAM_SIZE   = WORK_RAM_END - WORK_RAM_BASE + 1;  // 0x1380
const IO_BASE         = 0xD400;
const IO_END          = 0xD40F;

const SCREEN_WIDTH    = 640;
const SCREEN_HEIGHT   = 200;
const BYTES_PER_LINE  = 80;  // 640 / 8

const DISPLAY_MODE_REG = 0xD40E; // VRAM offset high byte
const DISPLAY_MODE_LO  = 0xD40F; // VRAM offset low byte

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

// Pre-build a lookup table: for each palette mapping, cache the ABGR value.
// This avoids double indirection during rendering.

export class Display {
    constructor() {
        // VRAM: 3 bitplanes, 48KB total
        this._vramBuf = new ArrayBuffer(VRAM_SIZE);
        this.vram = new Uint8Array(this._vramBuf);

        // Sub CPU work RAM ($C000-$D37F)
        this._workBuf = new ArrayBuffer(WORK_RAM_SIZE);
        this.workRam = new Uint8Array(this._workBuf);

        // TTL Palette: 8 entries, each maps logical color -> physical color
        // Default: identity mapping
        // Palette is set from MAIN CPU side ($FD38-$FD3F), not sub CPU I/O.
        this.palette = new Uint8Array(8);
        for (let i = 0; i < 8; i++) {
            this.palette[i] = i;
        }

        // Resolved palette: logical index -> ABGR uint32
        this._resolvedPalette = new Uint32Array(8);
        this._rebuildResolvedPalette();

        // VRAM offset register (scroll offset within each plane)
        // Two-byte register: high ($D40E) and low ($D40F)
        this.vramOffset = 0;
        this._vramOffsetCount = 0;  // write counter (scroll triggers every 2 writes)

        // CRT and VRAM access flags (sub CPU I/O side effects)
        this.crtOn = false;         // CRT display enabled (read $D408 = ON, write = OFF)
        this.vramaFlag = false;     // VRAM access gate (read $D409 = ON, write = OFF)

        // Dirty tracking for efficient rendering
        // Track dirty state per group of 8 scanlines (25 bands)
        this._dirtyBands = new Uint8Array(25);  // ceil(200/8)
        this._fullDirty = true;  // force full redraw initially

        // VSync frame counter
        this.frameCount = 0;

        // Cached ImageData (created on first render)
        this._imageData = null;
        this._pixelBuf = null;   // Uint32Array view of ImageData.data
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
        // Palette change means every pixel could change color
        this._fullDirty = true;
    }

    // ---------------------------------------------------------------
    //  VRAM access
    // ---------------------------------------------------------------

    readVRAM(addr) {
        addr &= 0xFFFF;
        if (addr < VRAM_SIZE) {
            const plane = (addr / PLANE_SIZE) | 0;
            const offset = addr % PLANE_SIZE;
            const effective = (offset + this.vramOffset) % PLANE_SIZE;
            return this.vram[plane * PLANE_SIZE + effective];
        }
        return 0xFF;
    }

    writeVRAM(addr, value) {
        addr &= 0xFFFF;
        if (addr < VRAM_SIZE) {
            const plane = (addr / PLANE_SIZE) | 0;
            const offset = addr % PLANE_SIZE;
            const effective = (offset + this.vramOffset) % PLANE_SIZE;
            const physAddr = plane * PLANE_SIZE + effective;
            if (this.vram[physAddr] !== value) {
                this.vram[physAddr] = value;
                // Mark dirty band based on the scanline this byte belongs to
                const lineInPlane = (effective / BYTES_PER_LINE) | 0;
                if (lineInPlane < SCREEN_HEIGHT) {
                    this._dirtyBands[(lineInPlane >> 3)] = 1;
                }
            }
        }
    }

    // ---------------------------------------------------------------
    //  Sub CPU memory read/write  ($0000 - $D40F)
    // ---------------------------------------------------------------

    /**
     * Sub CPU memory read ($0000-$D40F).
     * Note: I/O reads ($D400-$D40F) return { value, sideEffect? }.
     * Callers that need side effects should call readIO() directly.
     */
    read(addr) {
        addr &= 0xFFFF;
        if (addr < VRAM_SIZE) {
            return this.readVRAM(addr);
        }
        if (addr >= WORK_RAM_BASE && addr <= WORK_RAM_END) {
            return this.workRam[addr - WORK_RAM_BASE];
        }
        if (addr >= IO_BASE && addr <= IO_END) {
            // I/O reads have side effects - return value only here.
            // fm7.js _subRead() handles side effects via direct readIO() calls.
            const result = this.readIO(addr);
            return result.value;
        }
        // Gap between work RAM and I/O
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
        if (addr >= IO_BASE && addr <= IO_END) {
            // I/O writes have side effects.
            // fm7.js _subWrite() handles side effects via direct writeIO() calls.
            this.writeIO(addr, value);
            return;
        }
    }

    // ---------------------------------------------------------------
    //  I/O register access  ($D400 - $D40F)
    // ---------------------------------------------------------------

    /**
     * Sub CPU I/O read ($D400-$D40F)
     * Sub CPU I/O read - reads have side effects!
     *
     * $D402: Cancel IRQ ACK (clears cancel flag)
     * $D403: BEEP trigger
     * $D404: Attention IRQ (sets attention flag, triggers main CPU FIRQ)
     * $D408: CRT ON (enables CRT display)
     * $D409: VRAM Access ON (enables VRAM access gate)
     * $D40A: BUSY OFF (clears sub CPU BUSY flag)
     *
     * @returns {{ value: number, sideEffect?: string }}
     */
    readIO(addr) {
        addr &= 0xFFFF;

        switch (addr) {
            case 0xD402:
                // Cancel IRQ ACK - cleared by fm7.js handler
                return { value: 0xFF, sideEffect: 'cancelAck' };

            case 0xD403:
                // BEEP trigger (ignored for now)
                return { value: 0xFF };

            case 0xD404:
                // Attention IRQ ON - fm7.js should trigger main CPU FIRQ
                return { value: 0xFF, sideEffect: 'attention' };

            case 0xD408:
                // CRT ON
                this.crtOn = true;
                return { value: 0xFF };

            case 0xD409:
                // VRAM access ON
                this.vramaFlag = true;
                return { value: 0xFF };

            case 0xD40A:
                // BUSY flag OFF - fm7.js should clear _subBusy
                return { value: 0xFF, sideEffect: 'busyOff' };

            default:
                return { value: 0xFF };
        }
    }

    /**
     * Sub CPU I/O write ($D400-$D40F)
     * Sub CPU I/O write - writes have side effects!
     *
     * $D408: CRT OFF
     * $D409: VRAM Access OFF
     * $D40A: BUSY ON (sets sub CPU BUSY flag)
     * $D40E: VRAM offset high byte
     * $D40F: VRAM offset low byte
     *
     * @returns {{ sideEffect?: string }}
     */
    writeIO(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;

        switch (addr) {
            case 0xD408:
                // CRT OFF
                this.crtOn = false;
                return {};

            case 0xD409:
                // VRAM access OFF
                this.vramaFlag = false;
                return {};

            case 0xD40A:
                // BUSY flag ON - fm7.js should set _subBusy
                return { sideEffect: 'busyOn' };

            case 0xD40E:
                // VRAM offset high byte (bits 5-0 valid)
                this._updateVramOffsetHigh(value);
                return {};

            case 0xD40F:
                // VRAM offset low byte (bits 7-5 valid on FM-7)
                this._updateVramOffsetLow(value);
                return {};

            default:
                return {};
        }
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

    // Reset palette to identity mapping
    resetPalette() {
        for (let i = 0; i < 8; i++) {
            this.palette[i] = i;
        }
        this._rebuildResolvedPalette();
    }

    // ---------------------------------------------------------------
    //  VRAM offset (scroll)
    // ---------------------------------------------------------------

    /**
     * VRAM offset high byte ($D40E write) - bits 5-0 are valid.
     * FM-7 hardware: offset = (dat & 0x3f) << 8 | low_byte
     */
    _updateVramOffsetHigh(value) {
        const high = (value & 0x3F) << 8;
        const newOffset = high | (this.vramOffset & 0xFF);
        this.vramOffset = newOffset;
        this._vramOffsetCount++;
        if ((this._vramOffsetCount & 1) === 0) {
            this._fullDirty = true;
        }
    }

    /**
     * VRAM offset low byte ($D40F write) - bits 7-5 valid on FM-7.
     * FM-7 hardware: offset = high_part | (dat & 0xe0)
     */
    _updateVramOffsetLow(value) {
        const newOffset = (this.vramOffset & 0x3F00) | (value & 0xE0);
        this.vramOffset = newOffset;
        this._vramOffsetCount++;
        if ((this._vramOffsetCount & 1) === 0) {
            this._fullDirty = true;
        }
    }

    setVramOffset(offset) {
        offset &= (PLANE_SIZE - 1);  // wrap within 16KB
        if (this.vramOffset !== offset) {
            this.vramOffset = offset;
            this._fullDirty = true;
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

    /**
     * Render VRAM contents to a <canvas> element.
     *
     * The canvas internal resolution is 640x200.
     * CSS should scale it to 640x400 (or larger) for correct aspect ratio.
     *
     * @param {HTMLCanvasElement} canvas - target canvas element
     * @param {boolean} [force=false] - force full redraw ignoring dirty tracking
     */
    render(canvas, force = false) {
        // Lazily acquire / re-acquire context when canvas changes
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

        // Quick bail-out: if nothing is dirty and no full redraw requested
        if (!needFull) {
            let anyDirty = false;
            for (let b = 0; b < 25; b++) {
                if (this._dirtyBands[b]) { anyDirty = true; break; }
            }
            if (!anyDirty) return;
        }

        const pixels = this._pixelBuf;
        const blue  = this.vram;  // base 0x0000
        const red   = this.vram;  // base 0x4000
        const green = this.vram;  // base 0x8000
        const pal   = this._resolvedPalette;
        const offset = this.vramOffset;

        // Pre-compute a 256-entry table for each possible byte value:
        // For a given VRAM byte, extract 8 single-bit values.
        // We do this inline for speed rather than a separate table,
        // because the hot loop is already tight with Uint32Array writes.

        for (let band = 0; band < 25; band++) {
            if (!needFull && !this._dirtyBands[band]) continue;

            const yStart = band << 3;          // band * 8
            const yEnd = Math.min(yStart + 8, SCREEN_HEIGHT);

            for (let y = yStart; y < yEnd; y++) {
                const lineBase = ((y * BYTES_PER_LINE + offset) % PLANE_SIZE);
                const pixelRow = y * SCREEN_WIDTH;

                for (let byteX = 0; byteX < BYTES_PER_LINE; byteX++) {
                    const byteAddr = (lineBase + byteX) % PLANE_SIZE;

                    const bByte = blue [BLUE_BASE  + byteAddr];
                    const rByte = red  [RED_BASE   + byteAddr];
                    const gByte = green[GREEN_BASE + byteAddr];

                    const px = pixelRow + (byteX << 3);  // byteX * 8

                    // Unrolled 8-pixel decode (MSB = leftmost)
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

        // Blit to canvas
        if (needFull) {
            this._ctx.putImageData(this._imageData, 0, 0);
        } else {
            // Only blit dirty bands for efficiency
            for (let band = 0; band < 25; band++) {
                if (!this._dirtyBands[band]) continue;
                const yStart = band << 3;
                const h = Math.min(8, SCREEN_HEIGHT - yStart);
                this._ctx.putImageData(this._imageData, 0, 0,
                    0, yStart, SCREEN_WIDTH, h);
            }
        }

        // Clear dirty state
        this._fullDirty = false;
        this._dirtyBands.fill(0);
    }

    /**
     * Render with scanline-doubled output (640x400) for displays
     * that want the physical pixel grid without CSS scaling.
     *
     * @param {HTMLCanvasElement} canvas - target canvas (will be set to 640x400)
     * @param {boolean} [force=false]
     */
    renderDoubled(canvas, force = false) {
        // First render at native 640x200
        // Use an offscreen canvas for the native resolution
        if (!this._offscreenCanvas) {
            this._offscreenCanvas = new OffscreenCanvas(SCREEN_WIDTH, SCREEN_HEIGHT);
        }
        // Temporarily swap canvas reference to render to offscreen
        const savedCanvas = this._canvas;
        const savedCtx = this._ctx;
        const savedImageData = this._imageData;
        const savedPixelBuf = this._pixelBuf;

        this._canvas = null;  // force re-init in render()
        this.render(this._offscreenCanvas, force);

        // Restore
        this._canvas = savedCanvas;
        this._ctx = savedCtx;
        this._imageData = savedImageData;
        this._pixelBuf = savedPixelBuf;

        // Now draw doubled to the real canvas
        canvas.width = SCREEN_WIDTH;
        canvas.height = SCREEN_HEIGHT * 2;
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this._offscreenCanvas, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT * 2);
    }

    // ---------------------------------------------------------------
    //  Bulk operations (useful for loading snapshots, testing, etc.)
    // ---------------------------------------------------------------

    /**
     * Load raw VRAM data from an ArrayBuffer or Uint8Array.
     * @param {ArrayBuffer|Uint8Array} data - must be exactly 0xC000 bytes
     */
    loadVRAM(data) {
        const src = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (src.length !== VRAM_SIZE) {
            throw new Error(`VRAM data must be ${VRAM_SIZE} bytes, got ${src.length}`);
        }
        this.vram.set(src);
        this._fullDirty = true;
    }

    /**
     * Clear all VRAM to zero (black screen).
     */
    clearVRAM() {
        this.vram.fill(0);
        this._fullDirty = true;
    }

    /**
     * Clear work RAM to zero.
     */
    clearWorkRam() {
        this.workRam.fill(0);
    }

    /**
     * Full reset: clear VRAM, work RAM, reset palette, offset, frame count.
     */
    reset() {
        this.clearVRAM();
        this.clearWorkRam();
        this.resetPalette();
        this.vramOffset = 0;
        this._vramOffsetCount = 0;
        this.crtOn = false;
        this.vramaFlag = false;
        this.frameCount = 0;
        this._fullDirty = true;
    }

    // ---------------------------------------------------------------
    //  Debug / inspection helpers
    // ---------------------------------------------------------------

    /**
     * Get the logical color index at a given pixel coordinate.
     * @param {number} x - 0..639
     * @param {number} y - 0..199
     * @returns {number} color index 0-7
     */
    getPixelColor(x, y) {
        if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return 0;
        const byteOffset = (y * BYTES_PER_LINE + Math.floor(x / 8) + this.vramOffset) % PLANE_SIZE;
        const bit = 7 - (x & 7);
        const b = (this.vram[BLUE_BASE  + byteOffset] >> bit) & 1;
        const r = (this.vram[RED_BASE   + byteOffset] >> bit) & 1;
        const g = (this.vram[GREEN_BASE + byteOffset] >> bit) & 1;
        return (g << 2) | (r << 1) | b;
    }

    /**
     * Set a single pixel in VRAM (useful for testing).
     * @param {number} x - 0..639
     * @param {number} y - 0..199
     * @param {number} colorIndex - 0..7
     */
    setPixel(x, y, colorIndex) {
        if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return;
        const byteOffset = (y * BYTES_PER_LINE + Math.floor(x / 8) + this.vramOffset) % PLANE_SIZE;
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

    /**
     * Draw a horizontal line (for testing).
     */
    drawHLine(x0, x1, y, colorIndex) {
        for (let x = x0; x <= x1; x++) {
            this.setPixel(x, y, colorIndex);
        }
    }

    /**
     * Draw a filled rectangle (for testing).
     */
    fillRect(x0, y0, w, h, colorIndex) {
        for (let y = y0; y < y0 + h && y < SCREEN_HEIGHT; y++) {
            for (let x = x0; x < x0 + w && x < SCREEN_WIDTH; x++) {
                this.setPixel(x, y, colorIndex);
            }
        }
    }
}
