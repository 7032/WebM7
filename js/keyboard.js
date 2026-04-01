/**
 * FM-7 Keyboard Handler
 *
 * The FM-7 keyboard encoder produces 7-bit key codes (not standard ASCII).
 * Main CPU accesses keyboard through I/O ports:
 *   $FD00 (read)  - bit 7: key data available (active low: 0=yes, 1=no)
 *   $FD01 (read)  - key code (7-bit); reading clears the interrupt flag
 *   $FD02 (write) - bit 0: keyboard IRQ mask (0=enabled, 1=masked)
 *
 * A key press pushes a make code into the buffer.
 * A key release pushes a break code (make code | 0x80) into the buffer.
 *
 * The FM-7 keyboard generates an IRQ to the main CPU when a key event
 * is available and the IRQ mask allows it.
 */

// =====================================================================
// FM-7 key code table
//
// These are the FM-7 native key codes (7-bit, 0x00-0x7F).
// They loosely resemble ASCII for printable characters but diverge
// for control keys and special keys.
// =====================================================================

const FM7_KEY_NONE    = 0xFF;  // sentinel: no key

// FM-7 hardware scan codes (key matrix positions)
const FM7_KEY_SPACE   = 0x35;
const FM7_KEY_RETURN  = 0x1D;
const FM7_KEY_ESC     = 0x01;
const FM7_KEY_BS      = 0x0F;
const FM7_KEY_TAB     = 0x10;
const FM7_KEY_DEL     = 0x4B;

// Arrow keys (hardware scan codes)
const FM7_KEY_LEFT    = 0x4F;
const FM7_KEY_RIGHT   = 0x51;
const FM7_KEY_UP      = 0x4D;
const FM7_KEY_DOWN    = 0x50;

// Home / Cls
const FM7_KEY_HOME    = 0x4B;  // HOME → same as DEL scan code

// Function keys PF1-PF10 (hardware scan codes)
const FM7_KEY_F1      = 0x57;
const FM7_KEY_F2      = 0x58;
const FM7_KEY_F3      = 0x59;
const FM7_KEY_F4      = 0x5A;
const FM7_KEY_F5      = 0x5B;
const FM7_KEY_F6      = 0x5C;
const FM7_KEY_F7      = 0x5D;
const FM7_KEY_F8      = 0x5E;
const FM7_KEY_F9      = 0x5F;
const FM7_KEY_F10     = 0x60;

// Break flag for key-up (release) events
const FM7_KEY_BREAK   = 0x80;

// =====================================================================
// PC key (KeyboardEvent.code) -> FM-7 key code mapping
// =====================================================================

/**
 * FM-7 mode: ASCII-based key codes.
 * The FM-7 keyboard encoder converts scan codes to ASCII internally.
 * $FD01 returns ASCII character codes.
 */
const CODE_TO_FM7_ASCII = new Map([
    // Letters (FM-7: lowercase by default, CAPS OFF = lowercase)
    ['KeyA', 0x61], ['KeyB', 0x62], ['KeyC', 0x63], ['KeyD', 0x64],
    ['KeyE', 0x65], ['KeyF', 0x66], ['KeyG', 0x67], ['KeyH', 0x68],
    ['KeyI', 0x69], ['KeyJ', 0x6A], ['KeyK', 0x6B], ['KeyL', 0x6C],
    ['KeyM', 0x6D], ['KeyN', 0x6E], ['KeyO', 0x6F], ['KeyP', 0x70],
    ['KeyQ', 0x71], ['KeyR', 0x72], ['KeyS', 0x73], ['KeyT', 0x74],
    ['KeyU', 0x75], ['KeyV', 0x76], ['KeyW', 0x77], ['KeyX', 0x78],
    ['KeyY', 0x79], ['KeyZ', 0x7A],
    // Digits
    ['Digit0', 0x30], ['Digit1', 0x31], ['Digit2', 0x32], ['Digit3', 0x33],
    ['Digit4', 0x34], ['Digit5', 0x35], ['Digit6', 0x36], ['Digit7', 0x37],
    ['Digit8', 0x38], ['Digit9', 0x39],
    // Numpad
    ['Numpad0', 0x30], ['Numpad1', 0x31], ['Numpad2', 0x32], ['Numpad3', 0x33],
    ['Numpad4', 0x34], ['Numpad5', 0x35], ['Numpad6', 0x36], ['Numpad7', 0x37],
    ['Numpad8', 0x38], ['Numpad9', 0x39],
    // Symbols
    ['Minus', 0x2D], ['Equal', 0x3D], ['BracketLeft', 0x5B],
    ['BracketRight', 0x5D], ['Backslash', 0x5C], ['Semicolon', 0x3B],
    ['Quote', 0x27], ['Comma', 0x2C], ['Period', 0x2E], ['Slash', 0x2F],
    ['NumpadAdd', 0x2B], ['NumpadSubtract', 0x2D], ['NumpadMultiply', 0x2A],
    ['NumpadDivide', 0x2F], ['NumpadDecimal', 0x2E], ['NumpadEnter', 0x0D],
    // Control keys
    ['Enter', 0x0D], ['Space', 0x20], ['Escape', 0x1B], ['Backspace', 0x08],
    ['Tab', 0x09], ['Delete', 0x7F], ['Insert', 0x12], ['Home', 0x0B],
    // Arrow keys
    ['ArrowLeft', 0x1D], ['ArrowRight', 0x1C], ['ArrowUp', 0x1E], ['ArrowDown', 0x1F],
    // Function keys
    ['F1', 0x01], ['F2', 0x02], ['F3', 0x03], ['F4', 0x04], ['F5', 0x05],
    ['F6', 0x06], ['F7', 0x07], ['F8', 0x0E], ['F9', 0x0F], ['F10', 0x10],
]);

/**
 * FM77AV mode: Hardware scan codes (key matrix positions).
 * FM77AV can operate in scan code mode where $FD01 returns raw
 * keyboard matrix positions instead of ASCII.
 */
const CODE_TO_FM7_SCAN = new Map([
    // Row 0: ESC, digits, symbols
    ['Escape',     0x01],
    ['Digit1',     0x02], ['Digit2', 0x03], ['Digit3', 0x04], ['Digit4', 0x05],
    ['Digit5',     0x06], ['Digit6', 0x07], ['Digit7', 0x08], ['Digit8', 0x09],
    ['Digit9',     0x0A], ['Digit0', 0x0B],
    ['Minus',      0x0C],  // -
    ['Equal',      0x0D],  // ^ (JIS) / = (US)
    ['Backslash',  0x0E],  // ¥ / backslash
    ['Backspace',  0x0F],  // BS

    // Row 1: TAB, QWERTYUIOP, @, [
    ['Tab',        0x10],
    ['KeyQ', 0x11], ['KeyW', 0x12], ['KeyE', 0x13], ['KeyR', 0x14],
    ['KeyT', 0x15], ['KeyY', 0x16], ['KeyU', 0x17], ['KeyI', 0x18],
    ['KeyO', 0x19], ['KeyP', 0x1A],
    ['BracketLeft',  0x1C],  // [

    // Row 2: RETURN, ASDFGHJKL, ;, :, ]
    ['Enter',      0x1D],  // RETURN
    ['KeyA', 0x1E], ['KeyS', 0x1F], ['KeyD', 0x20], ['KeyF', 0x21],
    ['KeyG', 0x22], ['KeyH', 0x23], ['KeyJ', 0x24], ['KeyK', 0x25],
    ['KeyL', 0x26],
    ['Semicolon',    0x27],  // ;
    ['Quote',        0x28],  // : (JIS) / ' (US)
    ['BracketRight', 0x29],  // ]

    // Row 3: ZXCVBNM, symbols, SPACE
    ['KeyZ', 0x2A], ['KeyX', 0x2B], ['KeyC', 0x2C], ['KeyV', 0x2D],
    ['KeyB', 0x2E], ['KeyN', 0x2F], ['KeyM', 0x30],
    ['Comma',      0x31],  // ,
    ['Period',     0x32],  // .
    ['Slash',      0x33],  // /
    ['IntlRo',     0x34],  // _ (JIS underscore key)
    ['Space',      0x35],  // SPACE

    // Numpad
    ['Numpad7',        0x3A], ['Numpad8',    0x3B], ['Numpad9',        0x3C],
    ['NumpadDivide',   0x3D],
    ['Numpad4',        0x3E], ['Numpad5',    0x3F], ['Numpad6',        0x40],
    ['NumpadMultiply', 0x41],
    ['Numpad1',        0x42], ['Numpad2',    0x43], ['Numpad3',        0x44],
    ['NumpadSubtract', 0x45],
    ['Numpad0',        0x46],
    ['NumpadDecimal',  0x47],
    ['Insert',         0x48],  // INS
    ['NumpadEnter',    0x49],
    ['Delete',         0x4B],  // DEL
    ['Home',           0x4B],  // HOME → DEL (FM-7 CLS/HOME)

    // Cursor keys
    ['ArrowUp',    0x4D],
    ['ArrowLeft',  0x4F],
    ['ArrowDown',  0x50],
    ['ArrowRight', 0x51],

    // Function keys (PF1-PF10)
    ['F1',  0x57], ['F2',  0x58], ['F3',  0x59], ['F4',  0x5A],
    ['F5',  0x5B], ['F6',  0x5C], ['F7',  0x5D], ['F8',  0x5E],
    ['F9',  0x5F], ['F10', 0x60],
]);

/**
 * Shifted key code overrides (FM-7 ASCII mode only).
 * In scan code mode (FM77AV), Shift is a separate key and doesn't
 * change the scan code, so these are not used.
 */
const SHIFTED_OVERRIDE = new Map([
    // Letters: Shift produces uppercase on FM-7 (default is lowercase)
    ['KeyA', 0x41], ['KeyB', 0x42], ['KeyC', 0x43], ['KeyD', 0x44],
    ['KeyE', 0x45], ['KeyF', 0x46], ['KeyG', 0x47], ['KeyH', 0x48],
    ['KeyI', 0x49], ['KeyJ', 0x4A], ['KeyK', 0x4B], ['KeyL', 0x4C],
    ['KeyM', 0x4D], ['KeyN', 0x4E], ['KeyO', 0x4F], ['KeyP', 0x50],
    ['KeyQ', 0x51], ['KeyR', 0x52], ['KeyS', 0x53], ['KeyT', 0x54],
    ['KeyU', 0x55], ['KeyV', 0x56], ['KeyW', 0x57], ['KeyX', 0x58],
    ['KeyY', 0x59], ['KeyZ', 0x5A],
    // Shifted digit row
    ['Digit1', 0x21], ['Digit2', 0x22], ['Digit3', 0x23], ['Digit4', 0x24],
    ['Digit5', 0x25], ['Digit6', 0x26], ['Digit7', 0x27], ['Digit8', 0x28],
    ['Digit9', 0x29],
    // Shifted symbols
    ['Minus', 0x3D], ['Equal', 0x2B], ['Semicolon', 0x2B], ['Quote', 0x2A],
    ['Comma', 0x3C], ['Period', 0x3E], ['Slash', 0x3F],
    ['BracketLeft', 0x7B], ['BracketRight', 0x7D], ['Backslash', 0x7C],
]);

/**
 * Maximum number of key events in the buffer.
 * FM-7 hardware has a small buffer; 16 is generous.
 */
const KEY_BUFFER_SIZE = 16;

export class Keyboard {
    constructor() {
        /**
         * Use hardware scan codes instead of ASCII.
         * FM-7: false (ASCII mode), FM77AV: true (scan code mode).
         * Set by fm7.js based on machine type.
         */
        this._useScanCodes = false;

        // --- Key event FIFO buffer ---
        /** @type {number[]} circular buffer of FM-7 key codes (7-bit + break bit) */
        this._buffer = [];

        // --- I/O register state ---
        /**
         * The most recently dequeued key code.
         * $FD01 returns this value.  Bit 7 doubles as break flag.
         */
        this._currentKey = 0x00;

        /**
         * True when a key event is pending (not yet read by the CPU).
         * $FD00 bit 7 reflects this.
         */
        this._keyAvailable = false;

        /**
         * Keyboard IRQ mask.  Written via $FD02 bit 0.
         * 0 = IRQ enabled, 1 = IRQ masked.
         */
        this._irqMask = 1; // key IRQ masked on init (keyboard via sub CPU FIRQ)

        /**
         * Internal IRQ flag.  Set when a new key event arrives and
         * the IRQ mask is clear.  Cleared when the CPU reads $FD01.
         */
        this._irqFlag = false;

        /**
         * Callback invoked when the keyboard wants to assert IRQ on the
         * main CPU.  Set this externally:
         *   keyboard.onIRQ = () => mainCPU.assertIRQ('keyboard');
         */
        this.onIRQ = null;

        // Track currently held keys to avoid auto-repeat flooding
        /** @type {Set<string>} set of KeyboardEvent.code values currently held */
        this._heldKeys = new Set();

        /**
         * FM77AV break code support.
         * When true, key-up events generate break codes (make code | 0x80).
         * FM-7 does not generate break codes; FM77AV does.
         */
        this._enableBreakCodes = false;

        // --- LED toggle states ---
        this.capsLock = false;
        this.kanaMode = false;
        this.insMode = false;

        // --- Custom key remapping ---
        /** @type {Map<string, string>} PC event.code → PC event.code remap */
        this._customMap = new Map();
    }

    // ------------------------------------------------------------------
    // Browser event interface
    // ------------------------------------------------------------------

    /**
     * Handle a browser keydown event.
     * Call this from your event listener:
     *   document.addEventListener('keydown', e => keyboard.keyDown(e));
     *
     * @param {KeyboardEvent} event
     */
    keyDown(event) {
        const code = event.code;

        // Toggle LED keys (handle before mapping to prevent browser default)
        if (code === 'CapsLock') {
            this.capsLock = !this.capsLock;
        } else if (code === 'Insert') {
            this.insMode = !this.insMode;
        } else if (code === 'AltRight' || code === 'KanaMode') {
            // Alt-Right or Kana key → カナ toggle
            this.kanaMode = !this.kanaMode;
        }

        const fm7Code = this._mapKey(code, event.shiftKey);
        if (fm7Code === FM7_KEY_NONE) return;

        event.preventDefault();
        // Track by original code so keyUp can match correctly
        this._heldKeys.add(code);
        this._pushKey(fm7Code & 0x7F);
    }

    /**
     * Handle a browser keyup event.
     *
     * FM-7: no break codes — only releases the held key tracking.
     * FM77AV: generates break codes (make code | 0x80) on key release.
     *
     * @param {KeyboardEvent} event
     */
    keyUp(event) {
        const code = event.code;

        if (!this._heldKeys.has(code)) return;
        this._heldKeys.delete(code);

        // Check remapped code for preventDefault
        const remapped = this._customMap.get(code) || code;
        const tbl = this._useScanCodes ? CODE_TO_FM7_SCAN : CODE_TO_FM7_ASCII;
        if (tbl.has(remapped)) {
            event.preventDefault();
        }

        // FM77AV: send break code (key release)
        if (this._enableBreakCodes) {
            const fm7Code = this._mapKey(code, event.shiftKey);
            if (fm7Code !== FM7_KEY_NONE) {
                this._pushKey((fm7Code & 0x7F) | FM7_KEY_BREAK);
            }
        }
    }

    // ------------------------------------------------------------------
    // I/O port interface (main CPU reads/writes)
    // ------------------------------------------------------------------

    /**
     * Read from keyboard I/O port.
     *
     * @param {number} addr - address ($FD00 or $FD01)
     * @returns {number} byte value
     */
    readIO(addr) {
        switch (addr) {
            case 0xFD00:
                // Keyboard status register:
                // bit 7: 0 = key data available, 1 = no data (ACTIVE LOW!)
                return this._keyAvailable ? 0x7F : 0xFF;

            case 0xFD01:
                // Keyboard data register:
                this._irqFlag = false;
                this._keyAvailable = false;
                const data = this._currentKey;
                this._prepareNext();
                return data;

            default:
                return 0xFF;  // unmapped
        }
    }

    /**
     * Write to keyboard I/O port.
     *
     * @param {number} addr  - address ($FD02)
     * @param {number} value - byte value
     */
    writeIO(addr, value) {
        switch (addr) {
            case 0xFD02:
                // Bit 0: IRQ mask (0 = enabled, 1 = masked)
                // bit=1 → IRQ enabled, bit=0 → IRQ masked
                this._irqMask = (value & 0x01) ? 0 : 1;
                if (this._irqMask === 0 && this._keyAvailable) {
                    this._assertIRQ();
                }
                break;
        }
    }

    // ------------------------------------------------------------------
    // Query interface
    // ------------------------------------------------------------------

    /**
     * Check whether key data is available for the CPU to read.
     * @returns {boolean}
     */
    hasKey() {
        this._prepareNext();
        return this._keyAvailable;
    }

    /**
     * Peek at the current key code without consuming it.
     * @returns {number} FM-7 key code (7-bit + break bit), or 0 if none
     */
    getKeyData() {
        this._prepareNext();
        return this._keyAvailable ? this._currentKey : 0x00;
    }

    /**
     * Return true if the keyboard IRQ line is asserted.
     */
    /**
     * Check if keyboard IRQ is active (for $FD03 status and CPU IRQ line).
     * Requires BOTH: flag set AND mask clear.
     */
    isIRQActive() {
        return this._irqFlag && (this._irqMask === 0);
    }

    /**
     * Current key code for display purposes.
     * @returns {number}
     */
    currentKey() {
        return this._currentKey;
    }

    /**
     * Number of keys waiting in the buffer.
     * @returns {number}
     */
    bufferCount() {
        return this._buffer.length;
    }

    // ------------------------------------------------------------------
    // Custom key remapping
    // ------------------------------------------------------------------

    /**
     * Set custom key remappings.
     * @param {Map<string, string>|Object} map - PC event.code → PC event.code
     */
    setCustomMap(map) {
        this._customMap.clear();
        if (map instanceof Map) {
            for (const [k, v] of map) this._customMap.set(k, v);
        } else if (map && typeof map === 'object') {
            for (const [k, v] of Object.entries(map)) this._customMap.set(k, v);
        }
    }

    /**
     * Clear all custom key remappings.
     */
    clearCustomMap() {
        this._customMap.clear();
    }

    // ------------------------------------------------------------------
    // Reset
    // ------------------------------------------------------------------

    /**
     * Reset the keyboard to power-on state.
     */
    reset() {
        this._buffer.length = 0;
        this._currentKey = 0x00;
        this._keyAvailable = false;
        this._irqMask = 1; // key IRQ masked on init (keyboard via sub CPU FIRQ)
        this._irqFlag = false;
        this._heldKeys.clear();
        this.capsLock = false;
        this.kanaMode = false;
        this.insMode = false;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * Map a PC KeyboardEvent.code to an FM-7 key code.
     *
     * @param {string}  code     - KeyboardEvent.code
     * @param {boolean} shifted  - true if Shift is held
     * @returns {number} FM-7 key code, or FM7_KEY_NONE if unmapped
     */
    _mapKey(code, shifted) {
        // Apply custom remap: PC code → PC code
        const remapped = this._customMap.get(code) || code;

        const table = this._useScanCodes ? CODE_TO_FM7_SCAN : CODE_TO_FM7_ASCII;
        if (!this._useScanCodes && shifted && SHIFTED_OVERRIDE.has(remapped)) {
            return SHIFTED_OVERRIDE.get(remapped);
        }
        if (table.has(remapped)) {
            return table.get(remapped);
        }
        return FM7_KEY_NONE;
    }

    /**
     * Push a key code into the FIFO buffer and potentially fire IRQ.
     *
     * @param {number} keyCode - 8-bit value (7-bit code + break flag)
     */
    _pushKey(keyCode) {
        if (this._buffer.length >= KEY_BUFFER_SIZE) {
            // Buffer full - drop oldest event
            this._buffer.shift();
        }
        this._buffer.push(keyCode);

        // If no key is currently staged, load immediately
        if (!this._keyAvailable) {
            this._prepareNext();
        }
    }

    /**
     * If no key is currently staged for reading, dequeue the next one
     * from the buffer and stage it.
     */
    _prepareNext() {
        if (this._keyAvailable) return;
        if (this._buffer.length === 0) return;

        this._currentKey = this._buffer.shift();
        this._keyAvailable = true;
        this._assertIRQ();
    }

    /**
     * Assert keyboard IRQ if the mask allows it.
     */
    _assertIRQ() {
        // Flag is ALWAYS set when a key event arrives (regardless of mask)
        this._irqFlag = true;

        // But only trigger CPU IRQ line if mask allows it
        if (this._irqMask !== 0) return;
        if (typeof this.onIRQ === 'function') {
            this.onIRQ();
        }
    }
}

// Export key code constants for external use
export {
    FM7_KEY_NONE, FM7_KEY_BREAK,
    FM7_KEY_SPACE, FM7_KEY_RETURN, FM7_KEY_ESC, FM7_KEY_BS, FM7_KEY_TAB, FM7_KEY_DEL,
    FM7_KEY_LEFT, FM7_KEY_RIGHT, FM7_KEY_UP, FM7_KEY_DOWN, FM7_KEY_HOME,
    FM7_KEY_F1, FM7_KEY_F2, FM7_KEY_F3, FM7_KEY_F4, FM7_KEY_F5,
    FM7_KEY_F6, FM7_KEY_F7, FM7_KEY_F8, FM7_KEY_F9, FM7_KEY_F10,
    CODE_TO_FM7_ASCII, CODE_TO_FM7_SCAN, SHIFTED_OVERRIDE,
};
