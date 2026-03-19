/**
 * FM-7 Keyboard Handler
 *
 * The FM-7 keyboard encoder produces 7-bit key codes (not standard ASCII).
 * Main CPU accesses keyboard through I/O ports:
 *   $FD00 (read)  - bit 7: key data available (1=yes), bits 0-6: unused
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

// Printable / common codes (match ASCII for convenience)
const FM7_KEY_SPACE   = 0x20;
const FM7_KEY_RETURN  = 0x0D;
const FM7_KEY_ESC     = 0x1B;
const FM7_KEY_BS      = 0x08;
const FM7_KEY_TAB     = 0x09;
const FM7_KEY_DEL     = 0x7F;

// Arrow keys (FM-7 native codes)
const FM7_KEY_LEFT    = 0x1D;
const FM7_KEY_RIGHT   = 0x1C;
const FM7_KEY_UP      = 0x1E;
const FM7_KEY_DOWN    = 0x1F;

// Home / Cls
const FM7_KEY_HOME    = 0x0B;  // HOME/CLS

// Function keys F1-F10 (FM-7 codes 0x101-0x10A mapped to internal IDs,
// but FM-7 actually sends these as multi-byte sequences via the key
// encoder.  For simplicity we use the PF key codes that F-BASIC
// recognises when read in raw mode.)
const FM7_KEY_F1      = 0x01;
const FM7_KEY_F2      = 0x02;
const FM7_KEY_F3      = 0x03;
const FM7_KEY_F4      = 0x04;
const FM7_KEY_F5      = 0x05;
const FM7_KEY_F6      = 0x06;
const FM7_KEY_F7      = 0x07;
const FM7_KEY_F8      = 0x0E;
const FM7_KEY_F9      = 0x0F;
const FM7_KEY_F10     = 0x10;

// Break flag for key-up (release) events
const FM7_KEY_BREAK   = 0x80;

// =====================================================================
// PC key (KeyboardEvent.code) -> FM-7 key code mapping
// =====================================================================

/** Map from KeyboardEvent.code to FM-7 key code (unshifted). */
const CODE_TO_FM7 = new Map([
    // Letters (FM-7 uses uppercase ASCII codes even without shift)
    ['KeyA', 0x41], ['KeyB', 0x42], ['KeyC', 0x43], ['KeyD', 0x44],
    ['KeyE', 0x45], ['KeyF', 0x46], ['KeyG', 0x47], ['KeyH', 0x48],
    ['KeyI', 0x49], ['KeyJ', 0x4A], ['KeyK', 0x4B], ['KeyL', 0x4C],
    ['KeyM', 0x4D], ['KeyN', 0x4E], ['KeyO', 0x4F], ['KeyP', 0x50],
    ['KeyQ', 0x51], ['KeyR', 0x52], ['KeyS', 0x53], ['KeyT', 0x54],
    ['KeyU', 0x55], ['KeyV', 0x56], ['KeyW', 0x57], ['KeyX', 0x58],
    ['KeyY', 0x59], ['KeyZ', 0x5A],

    // Digits (top row)
    ['Digit0', 0x30], ['Digit1', 0x31], ['Digit2', 0x32], ['Digit3', 0x33],
    ['Digit4', 0x34], ['Digit5', 0x35], ['Digit6', 0x36], ['Digit7', 0x37],
    ['Digit8', 0x38], ['Digit9', 0x39],

    // Numpad digits
    ['Numpad0', 0x30], ['Numpad1', 0x31], ['Numpad2', 0x32], ['Numpad3', 0x33],
    ['Numpad4', 0x34], ['Numpad5', 0x35], ['Numpad6', 0x36], ['Numpad7', 0x37],
    ['Numpad8', 0x38], ['Numpad9', 0x39],

    // Symbols (unshifted, US layout -> FM-7 JIS approximation)
    ['Minus',        0x2D],  // -
    ['Equal',        0x3D],  // = (FM-7: ^ on JIS, but we map = for usability)
    ['BracketLeft',  0x5B],  // [
    ['BracketRight', 0x5D],  // ]
    ['Backslash',    0x5C],  // backslash
    ['Semicolon',    0x3B],  // ;
    ['Quote',        0x27],  // '
    ['Backquote',    0x60],  // `
    ['Comma',        0x2C],  // ,
    ['Period',       0x2E],  // .
    ['Slash',        0x2F],  // /

    // Numpad operators
    ['NumpadAdd',      0x2B],  // +
    ['NumpadSubtract', 0x2D],  // -
    ['NumpadMultiply', 0x2A],  // *
    ['NumpadDivide',   0x2F],  // /
    ['NumpadDecimal',  0x2E],  // .
    ['NumpadEnter',    FM7_KEY_RETURN],

    // Control keys
    ['Enter',      FM7_KEY_RETURN],
    ['Space',      FM7_KEY_SPACE],
    ['Escape',     FM7_KEY_ESC],
    ['Backspace',  FM7_KEY_BS],
    ['Tab',        FM7_KEY_TAB],
    ['Delete',     FM7_KEY_DEL],
    ['Home',       FM7_KEY_HOME],

    // Arrow keys
    ['ArrowLeft',  FM7_KEY_LEFT],
    ['ArrowRight', FM7_KEY_RIGHT],
    ['ArrowUp',    FM7_KEY_UP],
    ['ArrowDown',  FM7_KEY_DOWN],

    // Function keys
    ['F1',  FM7_KEY_F1],
    ['F2',  FM7_KEY_F2],
    ['F3',  FM7_KEY_F3],
    ['F4',  FM7_KEY_F4],
    ['F5',  FM7_KEY_F5],
    ['F6',  FM7_KEY_F6],
    ['F7',  FM7_KEY_F7],
    ['F8',  FM7_KEY_F8],
    ['F9',  FM7_KEY_F9],
    ['F10', FM7_KEY_F10],
]);

/**
 * Shifted key code overrides.
 * When Shift is held, certain keys produce different FM-7 codes.
 * Letters become lowercase on FM-7 (the FM-7 keyboard sends uppercase
 * by default; Shift gives lowercase - opposite of PC convention).
 */
const SHIFTED_OVERRIDE = new Map([
    // Letters: Shift produces lowercase on FM-7
    ['KeyA', 0x61], ['KeyB', 0x62], ['KeyC', 0x63], ['KeyD', 0x64],
    ['KeyE', 0x65], ['KeyF', 0x66], ['KeyG', 0x67], ['KeyH', 0x68],
    ['KeyI', 0x69], ['KeyJ', 0x6A], ['KeyK', 0x6B], ['KeyL', 0x6C],
    ['KeyM', 0x6D], ['KeyN', 0x6E], ['KeyO', 0x6F], ['KeyP', 0x70],
    ['KeyQ', 0x71], ['KeyR', 0x72], ['KeyS', 0x73], ['KeyT', 0x74],
    ['KeyU', 0x75], ['KeyV', 0x76], ['KeyW', 0x77], ['KeyX', 0x78],
    ['KeyY', 0x79], ['KeyZ', 0x7A],

    // Shifted digit row (US layout -> FM-7 approximation)
    ['Digit1', 0x21],  // !
    ['Digit2', 0x22],  // "
    ['Digit3', 0x23],  // #
    ['Digit4', 0x24],  // $
    ['Digit5', 0x25],  // %
    ['Digit6', 0x26],  // &
    ['Digit7', 0x27],  // '
    ['Digit8', 0x28],  // (
    ['Digit9', 0x29],  // )
    ['Digit0', 0x30],  // 0 (no shifted variant on FM-7 for 0)

    // Shifted symbols
    ['Minus',        0x3D],  // = (Shift+- on FM-7 JIS)
    ['Equal',        0x2B],  // +
    ['Semicolon',    0x2B],  // + (Shift+; on FM-7)
    ['Quote',        0x2A],  // *
    ['Comma',        0x3C],  // <
    ['Period',       0x3E],  // >
    ['Slash',        0x3F],  // ?
    ['BracketLeft',  0x7B],  // {
    ['BracketRight', 0x7D],  // }
    ['Backslash',    0x7C],  // |
]);

/**
 * Maximum number of key events in the buffer.
 * FM-7 hardware has a small buffer; 16 is generous.
 */
const KEY_BUFFER_SIZE = 16;

export class Keyboard {
    constructor() {
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
        this._irqMask = 0;

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
        // Prevent default for mapped keys so the browser doesn't
        // interfere (e.g. F5 reload, arrow scroll).
        const code = event.code;

        // Ignore auto-repeat
        if (this._heldKeys.has(code)) {
            if (CODE_TO_FM7.has(code)) event.preventDefault();
            return;
        }

        const fm7Code = this._mapKey(code, event.shiftKey);
        if (fm7Code === FM7_KEY_NONE) return;

        event.preventDefault();
        this._heldKeys.add(code);

        // Ctrl modifier: for letters, produce control code (0x01-0x1A)
        let finalCode = fm7Code;
        if (event.ctrlKey && fm7Code >= 0x41 && fm7Code <= 0x5A) {
            finalCode = fm7Code - 0x40;  // Ctrl+A=0x01, Ctrl+Z=0x1A
        }

        this._pushKey(finalCode & 0x7F);  // make (key down)
    }

    /**
     * Handle a browser keyup event.
     *
     * FM-7 keyboard encoder does NOT generate break codes.
     * (Break codes are an FM77AV feature, not supported here.)
     * We only track held keys to filter browser auto-repeat.
     *
     * @param {KeyboardEvent} event
     */
    keyUp(event) {
        const code = event.code;

        if (!this._heldKeys.has(code)) return;
        this._heldKeys.delete(code);

        // FM-7: no break codes sent — just release the held key tracking
        if (CODE_TO_FM7.has(code)) {
            event.preventDefault();
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
                // FM-7: D7 = data ready (1=ready), D6-D0 = key code (without break flag)
                // FM-7: $FD00 returns key data byte with bit 7 as ready flag
                this._prepareNext();
                if (this._keyAvailable) {
                    return 0x80 | (this._currentKey & 0x7F);
                }
                return this._currentKey & 0x7F;

            case 0xFD01:
                // FM-7 I/O $FD01 read:
                // Return key code (7-bit + break flag), clear IRQ
                this._irqFlag = false;
                this._keyAvailable = false;
                const data = this._currentKey;
                // Automatically load next key from buffer if available
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
                this._irqMask = value & 0x01;
                // If unmasking and there is a pending key, fire IRQ now
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
    isIRQActive() {
        return this._irqFlag;
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
    // Reset
    // ------------------------------------------------------------------

    /**
     * Reset the keyboard to power-on state.
     */
    reset() {
        this._buffer.length = 0;
        this._currentKey = 0x00;
        this._keyAvailable = false;
        this._irqMask = 0;
        this._irqFlag = false;
        this._heldKeys.clear();
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
        if (shifted && SHIFTED_OVERRIDE.has(code)) {
            return SHIFTED_OVERRIDE.get(code);
        }
        if (CODE_TO_FM7.has(code)) {
            return CODE_TO_FM7.get(code);
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
        if (this._irqMask !== 0) return;

        this._irqFlag = true;
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
    CODE_TO_FM7, SHIFTED_OVERRIDE,
};
