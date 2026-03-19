// =============================================================================
// FM-7 Web Emulator - Main System Class
//
// Ties together all components: dual 6809 CPUs, memory, display, FDC,
// scheduler, and keyboard into a working FM-7 emulation.
// =============================================================================

import { CPU6809 } from './cpu6809.js';
import { Display } from './display.js';
import { FDC } from './fdc.js';
import { Scheduler } from './scheduler.js';
import { Keyboard } from './keyboard.js';
import { PSG } from './psg.js';
import { usToCycles, cyclesToUs } from './scheduler.js';

// =============================================================================
// Memory Map Constants
// =============================================================================

// Main CPU memory map
const MAIN_RAM_SIZE      = 0x8000;   // 32KB main RAM ($0000-$7FFF)
const FBASIC_ROM_BASE    = 0x8000;   // F-BASIC ROM ($8000-$FBFF)
const FBASIC_ROM_SIZE    = 0x7C00;   // 31KB
const IO_BASE            = 0xFD00;   // I/O space ($FD00-$FDFF)
const IO_END             = 0xFDFF;
const BOOT_ROM_BASE      = 0xFE00;   // Boot ROM ($FE00-$FFFF)
const BOOT_ROM_SIZE      = 0x0200;   // 512 bytes
const SHARED_RAM_BASE    = 0xFC80;   // Shared RAM ($FC80-$FCFF)
const SHARED_RAM_END     = 0xFCFF;
const SHARED_RAM_SIZE    = 0x0080;

// Sub CPU memory map (handled by Display class for $0000-$D40F)
const SUB_ROM_BASE       = 0xD800;   // Sub CPU ROM ($D800-$FFFF)
const SUB_ROM_SIZE       = 0x2800;   // 10KB
const CG_ROM_BASE        = 0xD000;   // CG ROM region (within sub address space)

// I/O port addresses (main CPU side)
const FD00_KEY_STATUS    = 0xFD00;   // Keyboard status
const FD01_KEY_DATA      = 0xFD01;   // Keyboard data
const FD02_KEY_IRQ_MASK  = 0xFD02;   // Keyboard IRQ mask
const FD03_IRQ_STATUS    = 0xFD03;   // IRQ status / mask
const FD04_IRQ_MASK      = 0xFD04;   // IRQ mask register
const FD05_SUB_CTRL      = 0xFD05;   // Sub CPU control (write: HALT/CANCEL, read: BUSY)
const FD0F_ROM_SELECT    = 0xFD0F;   // ROM bank select

// FDC I/O ($FD18-$FD1F)
const FDC_IO_BASE        = 0xFD18;
const FDC_IO_END         = 0xFD1F;

// Timer IRQ period (microseconds)
const TIMER_PERIOD_US    = 2034;


// =============================================================================
// FM7 Main System Class
// =============================================================================

export class FM7 {
    constructor() {
        // --- Component instances ---
        this.mainCPU   = new CPU6809();
        this.subCPU    = new CPU6809();
        this.display   = new Display();
        this.fdc       = new FDC();
        this.scheduler = new Scheduler();
        this.keyboard  = new Keyboard();
        this.psg       = new PSG();

        // --- Memory arrays ---
        this.mainRAM    = new Uint8Array(0x10000);              // Full 64KB RAM (ROM overlays on top)
        this.fbasicROM  = new Uint8Array(FBASIC_ROM_SIZE);     // $8000-$FBFF
        this.bootROM    = new Uint8Array(BOOT_ROM_SIZE);        // $FE00-$FFFF
        this.subROM     = new Uint8Array(SUB_ROM_SIZE);         // Sub CPU $D800-$FFFF
        this.cgROM      = new Uint8Array(0x1000);               // CG ROM (4KB)
        this.sharedRAM  = new Uint8Array(SHARED_RAM_SIZE);      // $FC80-$FCFF

        // --- ROM loaded flags ---
        this.romLoaded = {
            fbasic: false,
            boot: false,
            sub: false,
            cg: false,
        };

        // --- I/O state ---
        this._subHalted   = true;   // Sub CPU starts halted after reset
        this._subBusy     = true;   // Sub CPU BUSY flag (TRUE on reset)
        this._subCancel   = false;  // Sub CPU CANCEL flag
        this._subAttn     = false;  // Sub CPU attention flag (FIRQ to main CPU)
        this._breakKey    = false;  // BREAK key state (directly read via $FD04 bit1)
        this._bootMode    = 'dos';  // 'dos' or 'basic'
        this._basicRomEnabled = true; // BASIC ROM overlay at $8000-$FBFF

        // --- OPN (YM2203) stub with BDIR/BC1 protocol ---
        this._opnAddrLatch = 0;
        this._opnDataBus   = 0;
        this._opnRegs      = new Uint8Array(256);
        this._opnRegs[0x0E] = 0xFF;     // Port A: all released (active low)
        this._opnRegs[0x0F] = 0xFF;     // Port B: no joystick selected
        this._gamepadState = new Uint8Array(2);
        this._gamepadState[0] = 0xFF;   // All buttons released (active low)
        this._gamepadState[1] = 0xFF;

        // IRQ / FIRQ flags for main CPU
        this._timerIRQ    = false;  // Timer IRQ pending (cleared by reading $FD03)
        this._irqMaskReg  = 0;      // $FD02 keyboard IRQ mask (bit 0)

        // Emulation loop state
        this._running     = false;
        this._animFrameId = null;
        this._canvas      = null;
        this._fpsCounter  = 0;
        this._fpsTime     = 0;
        this._currentFPS  = 0;

        // --- Wire components together ---
        this._wireMemory();
        this._wireScheduler();
        this._wireKeyboard();
        this._wireFDC();
        this._wireGamepad();
    }

    // =========================================================================
    // Memory Wiring
    // =========================================================================

    _wireMemory() {
        // Main CPU memory read
        this.mainCPU.setReadMem((addr) => this._mainRead(addr));
        this.mainCPU.setWriteMem((addr, val) => this._mainWrite(addr, val));

        // Sub CPU memory read
        this.subCPU.setReadMem((addr) => this._subRead(addr));
        this.subCPU.setWriteMem((addr, val) => this._subWrite(addr, val));
    }

    // =========================================================================
    // Main CPU Memory Read ($0000-$FFFF)
    // =========================================================================

    _mainRead(addr) {
        addr &= 0xFFFF;

        // $0000-$7FFF: Main RAM (32KB)
        if (addr < MAIN_RAM_SIZE) {
            return this.mainRAM[addr];
        }

        // $8000-$FBFF: F-BASIC ROM (if enabled) or RAM
        if (addr >= 0x8000 && addr < 0xFC00) {
            if (this._basicRomEnabled && this.romLoaded.fbasic) {
                return this.fbasicROM[addr - 0x8000];
            }
            return this.mainRAM[addr]; // RAM under ROM overlay
        }

        // $FC00-$FC7F: RAM
        if (addr >= 0xFC00 && addr < SHARED_RAM_BASE) {
            return this.mainRAM[addr];
        }

        // $FC80-$FCFF: Shared RAM (accessible only when sub CPU is halted)
        if (addr >= SHARED_RAM_BASE && addr <= SHARED_RAM_END) {
            if (this._subHalted) {
                return this.sharedRAM[addr - SHARED_RAM_BASE];
            }
            return 0xFF; // Not accessible while sub CPU is running
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            return this._mainIORead(addr);
        }

        // $FE00-$FFFF: Boot ROM
        if (addr >= BOOT_ROM_BASE) {
            return this.bootROM[addr - BOOT_ROM_BASE];
        }

        return 0xFF;
    }

    // =========================================================================
    // Main CPU Memory Write ($0000-$FFFF)
    // =========================================================================

    _mainWrite(addr, val) {
        addr &= 0xFFFF;
        val &= 0xFF;

        // $0000-$FBFF: RAM (writes always go to RAM, even under ROM overlay)
        if (addr < 0xFC00) {
            this.mainRAM[addr] = val;
            return;
        }

        // $FC00-$FC7F: RAM
        if (addr < SHARED_RAM_BASE) {
            this.mainRAM[addr] = val;
            return;
        }

        // $FC80-$FCFF: Shared RAM (writable only when sub CPU is halted)
        if (addr >= SHARED_RAM_BASE && addr <= SHARED_RAM_END) {
            if (this._subHalted) {
                this.sharedRAM[addr - SHARED_RAM_BASE] = val;
            }
            return;
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            this._mainIOWrite(addr, val);
            return;
        }

        // ROM areas: writes are ignored
    }

    // =========================================================================
    // Main CPU I/O Read ($FD00-$FDFF)
    // =========================================================================

    _mainIORead(addr) {
        // Keyboard
        if (addr === FD00_KEY_STATUS || addr === FD01_KEY_DATA) {
            return this.keyboard.readIO(addr);
        }

        // $FD02: IRQ mask (write-only, read returns $FF)
        if (addr === FD02_KEY_IRQ_MASK) {
            return 0xFF;
        }

        // IRQ status ($FD03 read)
        // FM-7 I/O $FD03 read: IRQ status
        // bit 0: keyboard data available (active low) - NOT gated by IRQ mask
        // bit 2: timer IRQ (active low) - clears on read
        // bit 3: printer IRQ (active low) - clears on read
        if (addr === FD03_IRQ_STATUS) {
            let status = 0xFF;
            if (this.keyboard.hasKey()) status &= ~0x01;
            if (this._timerIRQ) {
                status &= ~0x04;
                this._timerIRQ = false;  // Timer IRQ clears on read
            }
            return status;
        }

        // $FD04: Sub CPU status (BUSY, attention, break key)
        // FM-7 I/O $FD04 read: sub CPU status
        if (addr === FD04_IRQ_MASK) {
            let ret = this._subBusy ? 0xFF : 0x7F;  // bit 7 = BUSY
            if (this._subAttn) {
                ret &= ~0x01;  // bit 0 = attention (active low)
                this._subAttn = false;  // Clear attention on read
            }
            // bit 1 = break key (active low: 0=pressed, 1=not pressed)
            if (this._breakKey) ret &= ~0x02;
            return ret;
        }

        // Sub CPU status ($FD05 read)
        // FM-7 I/O $FD05 read: sub CPU control status
        // Default 0xFF; bit 7 cleared when NOT busy; bit 0 = EXTDET (peripheral)
        if (addr === FD05_SUB_CTRL) {
            let ret = 0xFF;
            if (!this._subBusy) ret &= ~0x80;  // bit 7: 0 = not busy
            // bit 0: EXTDET (FDC/OPN present) - always set for FM-7 with FDC
            ret &= ~0x01;
            return ret;
        }

        // $FD0F: Reading enables BASIC ROM overlay
        if (addr === FD0F_ROM_SELECT) {
            this._basicRomEnabled = true;
            return 0xFE;
        }

        // FDC registers ($FD18-$FD1F)
        if (addr >= FDC_IO_BASE && addr <= FDC_IO_END) {
            return this.fdc.readIO(addr);
        }

        // $FD38-$FD3F: TTL palette (main CPU side access)
        if (addr >= 0xFD38 && addr <= 0xFD3F) {
            return this.display.readPalette(addr - 0xFD38);
        }

        // $FD0D: PSG command port (read)
        if (addr === 0xFD0D) {
            return this.psg.readCmd();
        }

        // $FD0E: PSG data port (read)
        if (addr === 0xFD0E) {
            return this.psg.readData();
        }

        // $FD15: OPN status register read (bit 7=BUSY, bit 1=Timer B, bit 0=Timer A)
        if (addr === 0xFD15) {
            return 0x00;  // OPN present, not busy
        }

        // $FD16: OPN data bus read
        // Returns value set by last BDIR/BC1 Read command ($FD15 ← $01)
        if (addr === 0xFD16) {
            return this._opnDataBus;
        }

        // Other I/O - return default
        return 0xFF;
    }

    // =========================================================================
    // Main CPU I/O Write ($FD00-$FDFF)
    // =========================================================================

    _mainIOWrite(addr, val) {
        // $FD02: IRQ mask register (write)
        // Bit 0: key IRQ mask, Bit 2: timer IRQ mask (0=enabled, 1=masked)
        if (addr === FD02_KEY_IRQ_MASK) {
            this._irqMaskReg = val;
            this.keyboard.writeIO(addr, val);
            return;
        }

        // $FD03 write: BEEP/speaker control
        // bit 0: speaker on/off, bit 6: single BEEP, bit 7: continuous BEEP
        // Note: timer IRQ is cleared by READING $FD03, not writing.
        if (addr === FD03_IRQ_STATUS) {
            // BEEP/speaker control (sound not yet implemented)
            return;
        }

        // Sub CPU control ($FD05 write)
        // FM-7 I/O $FD05 write: sub CPU control
        // bit 7: 1 = HALT request, 0 = RUN request
        // bit 6: CANCEL IRQ
        if (addr === FD05_SUB_CTRL) {
            const haltReq = (val & 0x80) !== 0;
            const cancelReq = (val & 0x40) !== 0;

            if (haltReq) {
                // HALT request
                if (!this._subHalted) {
                    this._subHalted = true;
                    this._subBusy = true;  // HALT sets BUSY
                    this.scheduler.setSubHalted(true);
                }
            } else {
                // RUN request (release from halt)
                if (this._subHalted) {
                    this._subHalted = false;
                    this.scheduler.setSubHalted(false);
                }
            }

            if (cancelReq) {
                this._subCancel = true;
                // CANCEL sends FIRQ to sub CPU
                this.subCPU.firq();
            }
            return;
        }

        // $FD0F: Writing disables BASIC ROM overlay
        if (addr === FD0F_ROM_SELECT) {
            this._basicRomEnabled = false;
            return;
        }

        // $FD38-$FD3F: TTL palette (main CPU side access)
        if (addr >= 0xFD38 && addr <= 0xFD3F) {
            this.display.writePalette(addr - 0xFD38, val);
            return;
        }

        // FDC registers ($FD18-$FD1F)
        if (addr >= FDC_IO_BASE && addr <= FDC_IO_END) {
            this.fdc.writeIO(addr, val);
            return;
        }

        // $FD0D: PSG command port (write)
        if (addr === 0xFD0D) {
            this.psg.writeCmd(val);
            return;
        }

        // $FD0E: PSG data port (write)
        if (addr === 0xFD0E) {
            this.psg.writeData(val);
            return;
        }

        // $FD15: OPN command (BDIR/BC1 protocol)
        //   $00 = Inactive, $01 = Read, $02 = Write, $03 = Address Latch
        if (addr === 0xFD15) {
            switch (val & 0x03) {
                case 0x03: // Address Latch: latch data bus as register number
                    this._opnAddrLatch = this._opnDataBus & 0xFF;
                    break;
                case 0x02: // Write: write data bus to latched register
                    this._opnRegs[this._opnAddrLatch] = this._opnDataBus;
                    break;
                case 0x01: { // Read: load latched register onto data bus
                    const reg = this._opnAddrLatch;
                    if (reg === 0x0E) {
                        // Port A input: joystick data (active low)
                        const portB = this._opnRegs[0x0F];
                        if (!(portB & 0x40)) this._opnDataBus = this._gamepadState[0];
                        else                 this._opnDataBus = this._gamepadState[1];
                    } else {
                        this._opnDataBus = this._opnRegs[reg];
                    }
                    break;
                }
                // 0x00 = Inactive — do nothing
            }
            return;
        }

        // $FD16: OPN data bus write
        if (addr === 0xFD16) {
            this._opnDataBus = val & 0xFF;
            return;
        }

        // Other I/O writes (printer, etc.) - ignored
    }

    // =========================================================================
    // Sub CPU Memory Read ($0000-$FFFF)
    // =========================================================================

    _subRead(addr) {
        addr &= 0xFFFF;

        // $0000-$BFFF: VRAM (48KB) + $C000-$D37F: Work RAM
        if (addr < 0xD380) {
            return this.display.read(addr);
        }

        // $D380-$D3FF: Shared RAM (always accessible from sub CPU)
        if (addr <= 0xD3FF) {
            return this.sharedRAM[addr - 0xD380];
        }

        // $D400-$D40F: Sub CPU I/O
        if (addr <= 0xD40F) {
            // FM-7: $D410-$D7FF mirrors $D400-$D40F
            const ioAddr = 0xD400 + ((addr - 0xD400) & 0x0F);

            // Keyboard ($D400-$D401) - sub CPU side access
            // Keyboard: $D400=status, $D401=data+clear IRQ
            if (ioAddr === 0xD400) {
                return this.keyboard.hasKey() ? 0x7F : 0xFF;
            }
            if (ioAddr === 0xD401) {
                const data = this.keyboard.readIO(0xFD01);
                // Reading $D401 also sends FIRQ to sub CPU
                this.subCPU.firq();
                return data;
            }

            // Display/control I/O ($D402-$D40F)
            const result = this.display.readIO(ioAddr);

            // Handle side effects that need fm7-level state
            if (result.sideEffect === 'cancelAck') {
                // $D402: Cancel IRQ ACK
                this._subCancel = false;
            } else if (result.sideEffect === 'attention') {
                // $D404: Set attention flag, trigger main CPU FIRQ
                this._subAttn = true;
                this.mainCPU.firq();
            } else if (result.sideEffect === 'busyOff') {
                // $D40A: Clear BUSY
                this._subBusy = false;
            }

            return result.value;
        }

        // $D410-$D7FF: Sub CPU I/O mirrors (FM-7: mirrors $D400-$D40F)
        if (addr < SUB_ROM_BASE) {
            // Mirror: redirect to $D400-$D40F
            return this._subRead(0xD400 + ((addr - 0xD400) & 0x0F));
        }

        // $D800-$FFFF: Sub CPU ROM
        return this.subROM[addr - SUB_ROM_BASE];
    }

    // =========================================================================
    // Sub CPU Memory Write ($0000-$FFFF)
    // =========================================================================

    _subWrite(addr, val) {
        addr &= 0xFFFF;
        val &= 0xFF;

        // $0000-$BFFF: VRAM + $C000-$D37F: Work RAM
        if (addr < 0xD380) {
            this.display.write(addr, val);
            return;
        }

        // $D380-$D3FF: Shared RAM (always accessible from sub CPU)
        if (addr <= 0xD3FF) {
            this.sharedRAM[addr - 0xD380] = val;
            return;
        }

        // $D400-$D40F: Sub CPU I/O
        if (addr <= 0xD40F) {
            const ioAddr = 0xD400 + ((addr - 0xD400) & 0x0F);

            // Keyboard ($D400-$D401) - writes ignored
            if (ioAddr <= 0xD401) return;

            // Display/control I/O
            const result = this.display.writeIO(ioAddr, val);

            // Handle side effects
            if (result && result.sideEffect === 'busyOn') {
                // $D40A write: Set BUSY
                this._subBusy = true;
            }
            return;
        }

        // $D410-$D7FF: mirrors
        if (addr < SUB_ROM_BASE) {
            this._subWrite(0xD400 + ((addr - 0xD400) & 0x0F), val);
            return;
        }

        // ROM area ($D800+): writes are ignored
    }

    // =========================================================================
    // Scheduler Wiring
    // =========================================================================

    _wireScheduler() {
        this.scheduler.setMainCPU(this.mainCPU);
        this.scheduler.setSubCPU(this.subCPU);

        // Override scheduler exec to add per-instruction IRQ checks and FDC step
        this.scheduler.exec = (microseconds) => {
            const targetCycles = usToCycles(microseconds);
            const startMain = this.scheduler.mainCyclesTotal;
            let loopGuard = 100000; // prevent infinite loop

            while (this.scheduler.mainCyclesTotal - startMain < targetCycles) {
                if (--loopGuard <= 0) {
                    console.warn('[EXEC] loop guard hit — possible stuck CPU. MainPC=$' +
                        this.mainCPU.pc.toString(16) + ' SubPC=$' + this.subCPU.pc.toString(16));
                    break;
                }

                // Main CPU: execute one instruction
                const mainElapsed = this.mainCPU.exec();
                if (mainElapsed <= 0) {
                    console.error('[EXEC] mainCPU.exec() returned 0 at PC=$' +
                        this.mainCPU.pc.toString(16) + ' opcode=$' +
                        this._mainRead(this.mainCPU.pc).toString(16));
                    this.scheduler.mainCyclesTotal += 2; // skip
                    continue;
                }
                this.scheduler.mainCyclesTotal += mainElapsed;

                // FDC state machine step
                this.fdc.step(mainElapsed);

                // PSG audio synthesis (generates samples into ring buffer)
                this.psg.step(mainElapsed);

                // Check and assert IRQ/FIRQ on main CPU (level-triggered)
                this._checkAndAssertInterrupts();

                // Sub CPU: catch up to main CPU
                if (!this.scheduler.subHalted && this.subCPU) {
                    let subGuard = 1000;
                    while (this.scheduler.subCyclesTotal < this.scheduler.mainCyclesTotal) {
                        const subElapsed = this.subCPU.exec();
                        if (subElapsed <= 0) {
                            console.error('[EXEC] subCPU.exec() returned 0 at PC=$' +
                                this.subCPU.pc.toString(16));
                            this.scheduler.subCyclesTotal += 2;
                            break;
                        }
                        this.scheduler.subCyclesTotal += subElapsed;
                        if (--subGuard <= 0) break;
                    }
                }

                // Tick all scheduler events
                for (let i = 0; i < this.scheduler.events.length; i++) {
                    this.scheduler.events[i].tick(mainElapsed);
                }
            }

            const actualCycles = this.scheduler.mainCyclesTotal - startMain;
            return actualCycles / (1228800 / 1000000);
        };

        // Timer IRQ event (~2034.5us period, ~491.6 Hz)
        this.scheduler.addTimerEvent(() => {
            this._timerIRQ = true;
        });

        // VSync event (60 Hz) → NMI to sub CPU
        this.scheduler.addVSyncEvent(() => {
            this.display.frameCount++;
            if (!this._subHalted) {
                this.subCPU.nmi();
            }
        });
    }

    /** Check all IRQ/FIRQ sources and assert on CPUs */
    _checkAndAssertInterrupts() {
        // Main CPU IRQ: timer, keyboard, FDC
        // FM-7 IRQ is level-triggered: asserted as long as source is active
        let mainIrq = false;

        // Timer IRQ: no mask register, always enabled. Cleared by writing $FD03.
        if (this._timerIRQ) mainIrq = true;

        // Keyboard IRQ: use keyboard module's actual state (handles its own mask)
        if (this.keyboard.isIRQActive()) mainIrq = true;

        // FDC IRQ: check FDC's own flag directly (cleared by reading $FD18)
        if (this.fdc.irqFlag) mainIrq = true;

        if (mainIrq) this.mainCPU.irq();

        // Main CPU FIRQ is edge-triggered: asserted once when sub CPU
        // reads $D404 (in _subRead). Do NOT re-assert here every cycle,
        // or the main CPU gets stuck in infinite FIRQ.
    }

    // =========================================================================
    // Keyboard Wiring
    // =========================================================================

    _wireKeyboard() {
        this.keyboard.onIRQ = () => {
            // Keyboard IRQ is level-triggered; _checkAndAssertInterrupts
            // polls keyboard.isIRQActive() each instruction cycle.
            // Immediately poke the CPU so it notices quickly.
            this.mainCPU.irq();
        };

        // Bind keyboard events to document
        // BREAK key (Backquote `) is handled separately — it doesn't go
        // through the keyboard encoder buffer; instead it directly drives
        // $FD04 bit 1 (active low).
        this._keyDownHandler = (e) => {
            // Start / resume PSG audio on first user gesture
            if (!this.psg._audioCtx) {
                this.psg.startAudio();
            } else {
                this.psg.resumeAudio();
            }

            if (e.code === 'Backquote') {
                e.preventDefault();
                this._breakKey = true;
                return;
            }
            this.keyboard.keyDown(e);
        };
        this._keyUpHandler = (e) => {
            if (e.code === 'Backquote') {
                e.preventDefault();
                this._breakKey = false;
                return;
            }
            this.keyboard.keyUp(e);
        };
        document.addEventListener('keydown', this._keyDownHandler);
        document.addEventListener('keyup', this._keyUpHandler);
    }

    // =========================================================================
    // FDC Wiring
    // =========================================================================

    _wireFDC() {
        // FDC IRQ is level-triggered: _checkAndAssertInterrupts polls
        // fdc.irqFlag directly each cycle.  The flag is cleared when the
        // CPU reads the FDC status register ($FD18) inside fdc.readIO().
        // No separate callback-driven flag is needed.
    }

    // =========================================================================
    // ROM Loading
    // =========================================================================

    /**
     * Load all required ROMs from a given path (for fetch-based loading).
     * @param {string} romPath - Base URL path to ROM files
     */
    async loadROMs(romPath) {
        const romFiles = [
            { name: 'fbasic30.rom',  loader: (d) => this.loadFBasicROM(d) },
            { name: 'boot_dos.rom',  loader: (d) => this.loadBootROM(d) },
            { name: 'subsys_c.rom',  loader: (d) => this.loadSubROM(d) },
            { name: 'SUBSYSCG.ROM',  loader: (d) => this.loadCGROM(d) },
        ];

        const results = await Promise.allSettled(
            romFiles.map(async (rom) => {
                const url = romPath.endsWith('/') ? romPath + rom.name : romPath + '/' + rom.name;
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`Failed to fetch ${rom.name}: ${resp.status}`);
                const data = await resp.arrayBuffer();
                rom.loader(data);
                console.log(`ROM loaded: ${rom.name} (${data.byteLength} bytes)`);
            })
        );

        for (const r of results) {
            if (r.status === 'rejected') {
                console.warn('ROM load warning:', r.reason.message);
            }
        }
    }

    /**
     * Load F-BASIC ROM ($8000-$FBFF, 31KB)
     * @param {ArrayBuffer} data
     */
    loadFBasicROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, FBASIC_ROM_SIZE);
        this.fbasicROM.set(src.subarray(0, len));
        this.romLoaded.fbasic = true;
    }

    /**
     * Load Boot ROM ($FE00-$FFFF, 512 bytes)
     * @param {ArrayBuffer} data
     */
    loadBootROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, BOOT_ROM_SIZE);
        this.bootROM.set(src.subarray(0, len));
        this.romLoaded.boot = true;
    }

    /**
     * Load Sub CPU ROM ($D800-$FFFF, 10KB)
     * @param {ArrayBuffer} data
     */
    loadSubROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, SUB_ROM_SIZE);
        this.subROM.set(src.subarray(0, len));
        this.romLoaded.sub = true;
    }

    /**
     * Load CG ROM (character generator)
     * @param {ArrayBuffer} data
     */
    loadCGROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.cgROM.length);
        this.cgROM.set(src.subarray(0, len));
        this.romLoaded.cg = true;
    }

    // =========================================================================
    // Disk Loading
    // =========================================================================

    /**
     * Load a D77 disk image into a drive.
     * @param {number} driveNum - Drive number (0-3)
     * @param {ArrayBuffer} data - Disk image data
     * @returns {boolean} success
     */
    loadDisk(driveNum, data) {
        return this.fdc.loadDisk(driveNum, data);
    }

    // =========================================================================
    // Reset
    // =========================================================================

    /**
     * Reset the entire system.
     * @param {string} bootMode - 'dos' or 'basic'
     */
    reset(bootMode = 'dos') {
        this._bootMode = bootMode;

        // Clear main RAM; shared RAM to 0xFF (FM-7 hardware default)
        this.mainRAM.fill(0x00);
        this.sharedRAM.fill(0xFF);

        // Reset I/O state
        this._subHalted   = false;  // Sub CPU runs after reset
        this._subBusy     = true;   // BUSY on reset
        this._subCancel   = false;
        this._subAttn     = false;
        this._breakKey    = false;
        this._timerIRQ    = false;
        this._irqMaskReg  = 0;
        this._basicRomEnabled = true; // BASIC ROM enabled on reset

        // Reset OPN state
        this._opnAddrLatch = 0;
        this._opnDataBus = 0;
        this._opnRegs.fill(0);
        this._gamepadState[0] = 0xFF;
        this._gamepadState[1] = 0xFF;

        // Reset all components
        this.display.reset();
        this.fdc.reset();
        this.keyboard.reset();
        this.psg.reset();
        this.scheduler.reset();

        // Set boot mode determines which boot ROM vector is used
        // On FM-7, the boot ROM at $FE00-$FFFF determines the reset vector

        // Reset CPUs - they read their reset vectors
        this.mainCPU.reset();
        this.subCPU.reset();

        // Sub CPU is already set to running above; sync scheduler
        this.scheduler.setSubHalted(false);

        console.log(`FM-7 reset (boot mode: ${bootMode})`);
    }

    // =========================================================================
    // Emulation Loop
    // =========================================================================

    /**
     * Start the emulation loop.
     * @param {HTMLCanvasElement} canvas - Canvas element for display output
     */
    start(canvas) {
        if (this._running) return;

        this._canvas = canvas || this._canvas;
        this._running = true;
        this._fpsTime = performance.now();
        this._fpsCounter = 0;

        // Start PSG audio on emulation start (user gesture context)
        if (!this.psg._audioCtx) {
            this.psg.startAudio();
        } else {
            this.psg.resumeAudio();
        }

        // Bind frame method
        this._boundFrame = () => this._frame();
        this._animFrameId = requestAnimationFrame(this._boundFrame);

        console.log('FM-7 emulation started');
    }

    /**
     * Stop the emulation loop.
     */
    stop() {
        if (!this._running) return;

        this._running = false;
        if (this._animFrameId !== null) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = null;
        }

        console.log('FM-7 emulation stopped');
    }

    /**
     * Execute a single emulation frame.
     * Called by requestAnimationFrame at ~60fps.
     */
    _frame() {
        if (!this._running) return;

        // Poll gamepads for joystick input
        this._pollGamepads();

        // Run scheduler for one frame (~16667 microseconds = 60fps)
        try {
            this.scheduler.exec(16667);
        } catch (e) {
            console.error('Emulation error:', e);
            this.stop();
            return;
        }

        // Render display to canvas
        if (this._canvas) {
            this.display.render(this._canvas);
        }

        // FPS calculation
        this._fpsCounter++;
        const now = performance.now();
        if (now - this._fpsTime >= 1000) {
            this._currentFPS = this._fpsCounter;
            this._fpsCounter = 0;
            this._fpsTime = now;
        }

        // Schedule next frame
        this._animFrameId = requestAnimationFrame(this._boundFrame);
    }

    // =========================================================================
    // Status / Debug
    // =========================================================================

    /**
     * Get current emulation status for UI display.
     * @returns {object} Status information
     */
    getStatus() {
        return {
            running: this._running,
            fps: this._currentFPS,
            bootMode: this._bootMode,
            subHalted: this._subHalted,
            mainPC: this.mainCPU.pc || 0,
            subPC: this.subCPU.pc || 0,
            romsLoaded: { ...this.romLoaded },
            diskLoaded: [
                this.fdc.disks[0] !== null,
                this.fdc.disks[1] !== null,
                this.fdc.disks[2] !== null,
                this.fdc.disks[3] !== null,
            ],
        };
    }

    // =========================================================================
    // Gamepad Polling
    // =========================================================================

    /** Set up gamepad connection event tracking. */
    _wireGamepad() {
        this._gamepadHandler = (e) => {
            console.log('Gamepad connected:', e.gamepad.id);
        };
        window.addEventListener('gamepadconnected', this._gamepadHandler);
    }

    // FM-7 joystick is read via OPN ($FD15/$FD16) Port A/B only.
    // PSG ($FD0D/$FD0E) does not provide joystick input on FM-7.

    /** Poll Gamepad API and update joystick state. */
    _pollGamepads() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < 2; i++) {
            const gp = gamepads[i];
            if (!gp) {
                this._gamepadState[i] = 0xFF;
                continue;
            }
            let state = 0xFF;  // active low: 1 = not pressed
            const deadzone = 0.3;
            const ax0 = gp.axes[0] || 0;
            const ax1 = gp.axes[1] || 0;
            // D-pad buttons (standard mapping: 12=Up,13=Down,14=Left,15=Right)
            if (ax1 < -deadzone || (gp.buttons[12] && gp.buttons[12].pressed)) state &= ~0x01; // Up
            if (ax1 >  deadzone || (gp.buttons[13] && gp.buttons[13].pressed)) state &= ~0x02; // Down
            if (ax0 < -deadzone || (gp.buttons[14] && gp.buttons[14].pressed)) state &= ~0x04; // Left
            if (ax0 >  deadzone || (gp.buttons[15] && gp.buttons[15].pressed)) state &= ~0x08; // Right
            // Triggers: A/X → Trigger1, B/Y → Trigger2
            if ((gp.buttons[0] && gp.buttons[0].pressed) ||
                (gp.buttons[2] && gp.buttons[2].pressed)) state &= ~0x10; // Trigger 1
            if ((gp.buttons[1] && gp.buttons[1].pressed) ||
                (gp.buttons[3] && gp.buttons[3].pressed)) state &= ~0x20; // Trigger 2
            this._gamepadState[i] = state;
        }
    }

    /**
     * Clean up event listeners.
     */
    destroy() {
        this.stop();
        this.psg.stopAudio();
        document.removeEventListener('keydown', this._keyDownHandler);
        document.removeEventListener('keyup', this._keyUpHandler);
        if (this._gamepadHandler) {
            window.removeEventListener('gamepadconnected', this._gamepadHandler);
        }
    }
}
