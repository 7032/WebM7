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
import { OPN } from './opn.js';
import { usToCycles, cyclesToUs, setCPUClock } from './scheduler.js';
import { CMT } from './cmt.js';

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

// FM77AV Sub ROM layout
const SUB_ROM_AV_BASE    = 0xE000;   // Type-A/B ROM start ($E000-$FFFF, 8KB)
const SUB_ROM_AV_SIZE    = 0x2000;   // 8KB

// FM77AV Sub monitor types
const SUB_MONITOR_A      = 0;        // FM77AV native mode
const SUB_MONITOR_B      = 1;        // FM77AV extended
const SUB_MONITOR_C      = 2;        // FM-7 compatible

// I/O port addresses (main CPU side)
const FD00_KEY_STATUS    = 0xFD00;   // Keyboard status
const FD01_KEY_DATA      = 0xFD01;   // Keyboard data
const FD02_KEY_IRQ_MASK  = 0xFD02;   // Keyboard IRQ mask
const FD03_IRQ_STATUS    = 0xFD03;   // IRQ status / mask
const FD04_IRQ_MASK      = 0xFD04;   // IRQ mask register
const FD05_SUB_CTRL      = 0xFD05;   // Sub CPU control (write: HALT/CANCEL, read: BUSY)
const FD0F_ROM_SELECT    = 0xFD0F;   // ROM bank select

// FM77AV additional I/O ports (main CPU side)
const FD12_SUB_MONITOR   = 0xFD12;   // Sub monitor type / initiator control
const FD13_SUB_BANK      = 0xFD13;   // Sub ROM bank switch + sub CPU reset
const FD30_APAL_ADDR_HI  = 0xFD30;   // Analog palette address high nibble
const FD31_APAL_ADDR_LO  = 0xFD31;   // Analog palette address low byte
const FD32_APAL_BLUE     = 0xFD32;   // Analog palette Blue data
const FD33_APAL_RED      = 0xFD33;   // Analog palette Red data

// FM77AV MMR (Memory Management Register)
const FD92_MMR_SEG       = 0xFD92;   // MMR segment register
const FD93_MMR_CTRL      = 0xFD93;   // MMR control register
const MMR_WINDOW_SIZE    = 0x1000;   // 4KB per MMR window
const MMR_NUM_SEGMENTS   = 16;       // 16 × 4KB = 64KB logical space
const MMR_EXTENDED_RAM   = 0x30000;  // 192KB extended RAM

// FDC I/O ($FD18-$FD1F)
const FDC_IO_BASE        = 0xFD18;
const FDC_IO_END         = 0xFD1F;

// Timer IRQ period (microseconds)
const TIMER_PERIOD_US    = 2034;


// =============================================================================
// FM7 Main System Class
// =============================================================================

// Machine types
export const MACHINE_FM7    = 'fm7';
export const MACHINE_FM77AV = 'fm77av';

export class FM7 {
    constructor() {
        // --- Machine type ---
        this._machineType = MACHINE_FM7;
        // --- Component instances ---
        this.mainCPU   = new CPU6809();
        this.subCPU    = new CPU6809();
        this.display   = new Display();
        this.fdc       = new FDC();
        this.scheduler = new Scheduler();
        this.keyboard  = new Keyboard();
        this.cmt       = new CMT();
        this.psg       = new PSG();
        this.opn       = new OPN();

        // --- Memory arrays ---
        this.mainRAM    = new Uint8Array(0x10000);              // Full 64KB RAM (ROM overlays on top)
        this.fbasicROM  = new Uint8Array(FBASIC_ROM_SIZE);     // $8000-$FBFF
        this.bootROM    = new Uint8Array(BOOT_ROM_SIZE);        // $FE00-$FFFF (DOS boot)
        this.bootBasROM = new Uint8Array(BOOT_ROM_SIZE);       // $FE00-$FFFF (BASIC boot)
        this.subROM     = new Uint8Array(SUB_ROM_SIZE);         // Sub CPU $D800-$FFFF
        this.cgROM      = new Uint8Array(0x2000);               // CG ROM (8KB, 4 banks x 2KB)
        this.sharedRAM  = new Uint8Array(SHARED_RAM_SIZE);      // $FC80-$FCFF

        // --- FM77AV additional ROM arrays ---
        this.initiateROM = new Uint8Array(0x2000);    // Initiator ROM (up to 8KB)
        this.subROM_A    = new Uint8Array(0x2800);    // Sub-system Type-A ROM (up to 10KB: $D800-$FFFF)
        this.subROM_B    = new Uint8Array(0x2800);    // Sub-system Type-B ROM (up to 10KB: $D800-$FFFF)

        // --- ROM loaded flags ---
        this.romLoaded = {
            fbasic: false,
            boot: false,
            bootBas: false,
            sub: false,
            cg: false,
            // FM77AV ROMs
            initiate: false,
            subA: false,
            subB: false,
        };

        // --- I/O state ---
        this._subHalted   = true;   // Sub CPU starts halted after reset
        this._subBusy     = true;   // Sub CPU BUSY flag (set on reset, cleared by sub CPU reading $D40A)
        this._subCancel   = false;  // Sub CPU CANCEL flag
        this._subAttn     = false;  // Sub CPU attention flag (FIRQ to main CPU)
        this._breakKey    = false;  // BREAK key state (directly read via $FD04 bit1)
        this._breakKeyCodes = ['Backquote', 'Pause']; // Configurable break key assignments
        this._bootMode    = 'dos';  // 'dos' or 'basic'
        this._basicRomEnabled = true; // BASIC ROM overlay at $8000-$FBFF

        // --- FM77AV specific state ---
        this._initiateROMSize = 0;       // Actual size of loaded Initiator ROM
        this._subROM_ASize    = 0;       // Actual size of loaded Type-A ROM
        this._subROM_BSize    = 0;       // Actual size of loaded Type-B ROM
        this._initiatorActive = false;   // Initiator ROM mapped at $FE00-$FFFF
        this._fd10Reg         = 0;       // FM77AV extended sub CPU mode register ($FD10)
        this._subMonitorType  = SUB_MONITOR_C; // Sub monitor: A=0, B=1, C=2
        this._cgRomBank       = 0;       // CG ROM bank (0-3, bits 0-1 of $D430)
        this._nmiMaskSub      = false;   // NMI mask for sub CPU (bit 7 of $D430)
        this._subResetFlag    = false;   // Sub CPU reset flag (read via $D430 bit 0)
        this._vsyncFlag       = true;    // TRUE=active display, FALSE=vertical blanking
        this._blankFlag       = false;   // TRUE=horizontal blanking active
        this._vblankCycles    = 0;       // Cycle counter for VBlank period
        this._subNmiDelay     = 0;       // Cycles to delay NMI after sub CPU reset (INTR_SLOAD emulation)
        // RTC (MS58321) via key encoder ($D431/$D432)
        this._rtcRxBuf = [];      // Receive buffer (sub CPU reads $D431)
        this._rtcAck = false;     // ACK flag (cleared on $D432 read)
        this._rtcCmdBuf = [];     // Command accumulator
        this._rtcState = 0;       // Protocol state

        // BEEP
        this._beepOsc = null;
        this._beepGain = null;
        this._beepTimer = null;
        this._beepContinuous = false;

        // Analog palette (4096 entries, 12-bit RGB: B4:R4:G4)
        this._analogPalette     = new Uint16Array(4096);
        this._analogPaletteAddr = 0;     // Palette write address

        // MMR (Memory Management Register) - FM77AV
        // Maps 16 × 4KB windows in logical $0000-$FFFF to physical extended RAM
        this._mmrEnabled   = false;        // MMR active flag
        this._mmrBankReg   = 0;            // $FD90: bank select (0-7) for register access AND address translation
        this._mmrBank93    = 0;            // $FD93 bit 6 stored for read-back (not used for bank selection)
        this._mmrSegSelect = 0;            // Segment select for $FD92 writes
        this._mmrRegs      = new Uint8Array(128); // 8 banks × 16 segments
        this._extRAM       = new Uint8Array(MMR_EXTENDED_RAM); // 192KB extended RAM

        // --- OPN (YM2203) / FM Sound Card ---
        this._fmCardEnabled = false; // FM sound card: off by default for FM-7
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
        this._opnIrqLatch = false;  // OPN timer IRQ latch (edge-triggered, cleared by $FD03 read)
        this._opnIrqPrev  = false;  // Previous OPN IRQ state for edge detection
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

        // FM77AV: Initiator ROM overlay takes priority over MMR.
        // When active, $6000-$7FFF always reads from Initiator ROM.
        if (this.isFM77AV && this._initiatorActive && this.romLoaded.initiate
            && addr >= 0x6000 && addr < 0x8000) {
            return this.initiateROM[addr - 0x6000];
        }

        // FM77AV MMR: remap through segment table
        // MMR applies to $0000-$FC7F only; shared RAM ($FC80+) and I/O ($FD00+) bypass MMR
        if (this._mmrEnabled && addr < SHARED_RAM_BASE) {
            const seg = addr >> 12;  // 4KB segment number (0-15)
            const bankOff = this._mmrBankReg * MMR_NUM_SEGMENTS;
            const physPage = this._mmrRegs[bankOff + seg];
            // FM77AV MMR physical page mapping:
            //   Pages 0x00-0x0F: extended RAM bank 0 (64KB)
            //   Pages 0x10-0x1F: sub CPU direct access when halted, else extended RAM bank 1
            //   Pages 0x20-0x2F: extended RAM bank 2 (64KB)
            //   Pages 0x30-0x3F: main RAM (same physical memory as CPU direct access)
            if ((physPage & 0x30) === 0x30) {
                const mainPage = physPage & 0x0F;
                if (mainPage !== seg) {
                    return this.mainRAM[(mainPage << 12) | (addr & 0x0FFF)];
                }
                // Identity mapping: fall through to normal map
            } else if (this._subHalted && (physPage & 0xF0) === 0x10) {
                // Sub CPU direct access: pages $10-$1F → sub CPU address space
                // Physical page $1N maps to sub CPU address $N000-$NFFF
                const subAddr = ((physPage & 0x0F) << 12) | (addr & 0x0FFF);
                return this._subRead(subAddr);
            } else {
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < MMR_EXTENDED_RAM) {
                    return this._extRAM[physAddr];
                }
                return 0xFF;
            }
        }

        // $0000-$7FFF: Main RAM (32KB)
        // (Initiator ROM overlay already handled above, before MMR)
        if (addr < MAIN_RAM_SIZE) {
            return this.mainRAM[addr];
        }

        // $8000-$FBFF: F-BASIC ROM (if enabled) or RAM
        if (addr >= 0x8000 && addr < 0xFC00) {
            if (this._basicRomEnabled) {
                if (this.romLoaded.fbasic) {
                    return this.fbasicROM[addr - 0x8000];
                }
                // ROM enabled but not loaded - warn once
                if (!this._fbasicWarnShown) {
                    this._fbasicWarnShown = true;
                    console.error(`[ROM MISSING] F-BASIC ROM read at $${addr.toString(16).toUpperCase()} but not loaded! PC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
                }
            }
            return this.mainRAM[addr];
        }

        // $FC00-$FC7F: RAM
        if (addr >= 0xFC00 && addr < SHARED_RAM_BASE) {
            return this.mainRAM[addr];
        }

        // $FC80-$FCFF: Shared RAM (dual-port, always accessible)
        if (addr >= SHARED_RAM_BASE && addr <= SHARED_RAM_END) {
            return this.sharedRAM[addr - SHARED_RAM_BASE];
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            return this._mainIORead(addr);
        }

        // $FE00-$FFFF: Boot ROM / Initiator ROM
        if (addr >= BOOT_ROM_BASE) {
            // $FFE0-$FFFF: Always read from RAM (interrupt vectors live in RAM)
            if (addr >= 0xFFE0) {
                return this.mainRAM[addr];
            }
            if (this.isFM77AV && this._initiatorActive && this.romLoaded.initiate) {
                // Initiator ROM vector area: last 512 bytes map to $FE00-$FFFF
                const romSize = this._initiateROMSize || BOOT_ROM_SIZE;
                const romOffset = (romSize > BOOT_ROM_SIZE)
                    ? (addr - BOOT_ROM_BASE) + (romSize - BOOT_ROM_SIZE)
                    : (addr - BOOT_ROM_BASE);
                return this.initiateROM[romOffset];
            }
            // FM77AV after Initiator ROM disabled: boot RAM (TWR) was written
            // by the Initiator ROM's old boot code, so read from mainRAM
            if (this.isFM77AV && this.romLoaded.initiate) {
                return this.mainRAM[addr];
            }
            // FM-7 BASIC boot: use boot_bas.rom (merged with boot_dos.rom vectors)
            if (this._basicBootStub) {
                return this._basicBootStub[addr - BOOT_ROM_BASE];
            }
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

        // FM77AV MMR: remap writes through segment table
        // MMR applies to $0000-$FC7F only; shared RAM ($FC80+) and I/O ($FD00+) bypass MMR
        if (this._mmrEnabled && addr < SHARED_RAM_BASE) {
            const seg = addr >> 12;
            const bankOff = this._mmrBankReg * MMR_NUM_SEGMENTS;
            const physPage = this._mmrRegs[bankOff + seg];
            // Pages 0x30-0x3F: main RAM
            if ((physPage & 0x30) === 0x30) {
                const mainPage = physPage & 0x0F;
                if (mainPage !== seg) {
                    this.mainRAM[(mainPage << 12) | (addr & 0x0FFF)] = val;
                    return;
                }
                // Identity: fall through to normal write path
            } else if (this._subHalted && (physPage & 0xF0) === 0x10) {
                // Sub CPU direct access: pages $10-$1F → sub CPU address space
                // Physical page $1N maps to sub CPU address $N000-$NFFF
                const subAddr = ((physPage & 0x0F) << 12) | (addr & 0x0FFF);
                this._subWrite(subAddr, val);
                return;
            } else {
                // Pages 0x00-0x0F, 0x20-0x2F: extended RAM
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < MMR_EXTENDED_RAM) {
                    this._extRAM[physAddr] = val;
                }
                return;
            }
        }

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

        // $FC80-$FCFF: Shared RAM (dual-port, always writable)
        if (addr >= SHARED_RAM_BASE && addr <= SHARED_RAM_END) {
            this.sharedRAM[addr - SHARED_RAM_BASE] = val;
            return;
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            this._mainIOWrite(addr, val);
            return;
        }

        // $FE00-$FFFF: Boot ROM area - writes go to underlying RAM
        // (ROM overlay only affects reads; the stack often lives here)
        if (addr >= BOOT_ROM_BASE) {
            this.mainRAM[addr] = val;
            return;
        }
    }

    // =========================================================================
    // Main CPU I/O Read ($FD00-$FDFF)
    // =========================================================================

    _mainIORead(addr) {
        // Keyboard ($FD00 read: bit 7 = BREAK key, bit 0 = CPU speed flag)
        if (addr === FD00_KEY_STATUS) {
            let val = this.keyboard.readIO(addr);
            // bit 0: CPU speed flag (1=normal 1.794MHz, 0=low speed 1.2288MHz)
            // BIOS uses this to select tape timing routine
            val |= 0x01;  // FM-7 runs at 1.794MHz (normal speed)
            return val;
        }
        if (addr === FD01_KEY_DATA) {
            return this.keyboard.readIO(addr);
        }

        // $FD02 read: bit 7 = cassette data input, bit 1 = printer, bit 0 = printer ACK
        if (addr === FD02_KEY_IRQ_MASK) {
            let val = 0x7F; // bit 7 = 0 by default
            // bit 7: cassette data input (from tape) - BIOS reads via ANDB #$80
            val = (val & ~0x80) | this.cmt.readDataBit();
            return val;
        }

        // IRQ status ($FD03 read)
        // bit 0: keyboard data available (active low: 0=data ready)
        //        NOT gated by IRQ mask - shows raw data availability
        // bit 2: timer IRQ (active low) - clears on read
        // IRQ status ($FD03 read) - active low: 0 = pending, read clears flags
        // bit 0: keyboard, bit 1: printer, bit 2: timer, bit 3: extended (OPN/DMA/PTM)
        if (addr === FD03_IRQ_STATUS) {
            let status = 0xFF;
            if (this.keyboard._keyAvailable) status &= ~0x01;
            if (this._timerIRQ) {
                status &= ~0x04;
                this._timerIRQ = false;
            }
            // bit 3: extended interrupt (OPN timer A/B overflow)
            // Reading $FD03 clears the edge-triggered IRQ latch.
            if (this._opnIrqLatch) {
                status &= ~0x08;
                this._opnIrqLatch = false;
            }
            return status;
        }

        // $FD04: Sub CPU status (BUSY, attention, break key)
        if (addr === FD04_IRQ_MASK) {
            let ret = this._subBusy ? 0xFF : 0x7F;  // bit 7 = BUSY only
            if (this._subAttn) {
                ret &= ~0x01;  // bit 0 = attention (active low)
                this._subAttn = false;  // Clear attention on read
            }
            // bit 1 = break key (active low: 0=pressed, 1=not pressed)
            if (this._breakKey) ret &= ~0x02;
            // FM77AV: clear subreset_flag when initiator ROM is no longer active
            if (this.isFM77AV && this._subResetFlag && !this._initiatorActive) {
                this._subResetFlag = false;
            }
            return ret;
        }

        // Sub CPU status ($FD05 read)
        // bit 7 = BUSY. bit 0 = EXTDET.
        if (addr === FD05_SUB_CTRL) {
            return this._subBusy ? 0xFE : 0x7E;
        }

        // $FD0B: FM77AV boot/mode register read
        // Returns machine configuration: bit 0-1 = boot device, bit 6 = FM77AV ID
        if (addr === 0xFD0B) {
            if (this.isFM77AV) {
                // bit 0: 0=BASIC boot, 1=DOS boot (active high for DOS)
                // bit 6: 0 = FM77AV present
                let val = 0x00;
                if (this._bootMode !== 'basic') val |= 0x01;
                return val;
            }
            return 0xFF;
        }

        // $FD0F: Reading enables BASIC ROM overlay
        if (addr === FD0F_ROM_SELECT) {
            this._basicRomEnabled = true;
            return 0xFE;
        }

        // FM77AV: $FD10 read - Extended sub CPU status
        if (addr === 0xFD10 && this.isFM77AV) {
            // Returns mode/status byte
            return this._fd10Reg || 0x00;
        }

        // FM77AV: $FD12 read - Sub mode status
        // bit 6: mode320 (1=320x200, 0=640x200)
        // bit 1: blank_flag (0=blanking active)
        // bit 0: vsync_flag (0=NOT in vsync)
        if (addr === FD12_SUB_MONITOR && this.isFM77AV) {
            let ret = 0xFF;
            if (this.display.displayMode === 1) ret |= 0x40; else ret &= ~0x40;
            // bit 1: blank_flag (0 when blanking active)
            if (this._blankFlag) ret &= ~0x02;
            // bit 0: vsync_flag (0 when NOT in vsync)
            if (!this._vsyncFlag) ret &= ~0x01;
            return ret;
        }

        // FM77AV: $FD30-$FD34 read — analog palette read-back
        if (this.isFM77AV && addr >= 0xFD30 && addr <= 0xFD34) {
            const idx = this._analogPaletteAddr & 0xFFF;
            const entry = this._analogPalette[idx];
            switch (addr) {
                case 0xFD30: return (this._analogPaletteAddr >> 8) & 0x0F;
                case 0xFD31: return this._analogPaletteAddr & 0xFF;
                case 0xFD32: return (entry >> 8) & 0x0F;  // Blue
                case 0xFD33: return (entry >> 4) & 0x0F;  // Red
                case 0xFD34: return entry & 0x0F;          // Green
            }
        }

        // FDC registers ($FD18-$FD1F)
        if (addr >= FDC_IO_BASE && addr <= FDC_IO_END) {
            return this.fdc.readIO(addr);
        }

        // $FD37: Multi-page register (main CPU side access)
        if (addr === 0xFD37) {
            return this.display.multiPage;
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

        // $FD15: OPN status register / BDIR-BC1 read
        if (addr === 0xFD15) {
            if (!this._fmCardEnabled) return 0xFF;
            return this.opn.readStatus();
        }

        // $FD16: OPN data bus read
        if (addr === 0xFD16) {
            if (!this._fmCardEnabled) return 0xFF;
            return this._opnDataBus;
        }

        // $FD06/$FD07: RS-232C USART (not installed: return open bus)
        if (addr === 0xFD06 || addr === 0xFD07) return 0xFF;

        // $FD20-$FD2F: Kanji ROM ($FD20-$FD23, $FD2C-$FD2F) + reserved ($FD24-$FD2B)
        if (addr >= 0xFD20 && addr <= 0xFD2F) return 0xFF;

        // $FD08-$FD0C: Printer/timer I/O (stub)
        if (addr >= 0xFD08 && addr <= 0xFD0C) return 0xFF;

        // $FD11: Extended sub interface (stub)
        if (addr === 0xFD11) return 0xFF;

        // $FD13: Sub ROM bank read (return current Type-A/B/C, FM77AV only)
        if (addr === FD13_SUB_BANK && this.isFM77AV) return this._subMonitorType & 0x03;

        // $FD14: Extended register (stub)
        if (addr === 0xFD14) return 0xFF;

        // $FDFD-$FDFF: Boot mode / extended registers (stub)
        if (addr >= 0xFDFD) return 0xFF;

        // FM77AV: MMR registers ($FD80-$FD9F)
        // $FD80-$FD8F: Segment registers for current bank (selected by $FD93 bit 6)
        // $FD93: Control register (read returns enable/bank/segSelect)
        // $FD90-$FD92, $FD94-$FD9F: unused (return $FF)
        if (this.isFM77AV && addr >= 0xFD80 && addr <= 0xFD9F) {
            if (addr === FD93_MMR_CTRL) {
                return (this._mmrEnabled ? 0x80 : 0x00) | (this._mmrBank93 ? 0x40 : 0x00) | (this._mmrSegSelect & 0x0F);
            }
            if (addr === 0xFD90) {
                return this._mmrBankReg;
            }
            if (addr <= 0xFD8F) {
                // $FD80-$FD8F: read segment registers for bank selected by $FD90
                return this._mmrRegs[this._mmrBankReg * MMR_NUM_SEGMENTS + (addr - 0xFD80)];
            }
            // $FD92: Indirect segment register read
            if (addr === FD92_MMR_SEG) {
                const seg = this._mmrSegSelect & 0x0F;
                return this._mmrRegs[this._mmrBankReg * MMR_NUM_SEGMENTS + seg];
            }
            return 0xFF;
        }

        // Log unhandled I/O reads (FM77AV mode only, throttled)
        if (this.isFM77AV) {
            const key = addr & 0xFFFF;
            if (!this._ioWarnSeen) this._ioWarnSeen = new Set();
            if (!this._ioWarnSeen.has(key)) {
                this._ioWarnSeen.add(key);
                console.warn(`[IO READ] Unhandled $${addr.toString(16).toUpperCase()} at MainPC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
            }
        }

        // Other I/O - return default
        return 0xFF;
    }

    // =========================================================================
    // Main CPU I/O Write ($FD00-$FDFF)
    // =========================================================================

    _mainIOWrite(addr, val) {
        // $FD00 write: cassette motor control + write data
        // bit 0: cassette write data (recording), bit 1: motor (1=ON)
        if (addr === FD00_KEY_STATUS) {
            this.cmt.writeControl(val);
            return;
        }

        // $FD02: IRQ mask register (write)
        // Bit 0: key IRQ mask, Bit 2: timer IRQ mask (0=enabled, 1=masked)
        if (addr === FD02_KEY_IRQ_MASK) {
            this._irqMaskReg = val;
            this.keyboard.writeIO(addr, val);
            return;
        }

        // $FD03 write: BEEP/speaker control (§7.1)
        // bit 7: continuous BEEP, bit 6: single BEEP (205ms), bit 0: speaker on/off
        if (addr === FD03_IRQ_STATUS) {
            if (val & 0x40) {
                // Single BEEP: 205ms tone at ~2kHz
                this._beepStart(205);
            }
            if (val & 0x80) {
                // Continuous BEEP on
                this._beepStart(-1); // -1 = continuous
            } else if (this._beepContinuous) {
                // Continuous BEEP off (bit7 cleared)
                this._beepStop();
            }
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
                if (!this._subHalted) {
                    this._subHalted = true;
                    this._subBusy = true;
                    this.scheduler.setSubHalted(true);
                }
            } else {
                if (this._subHalted) {
                    this._subHalted = false;
                    this.scheduler.setSubHalted(false);
                }
            }

            if (cancelReq) {
                this._subCancel = true;
            }
            this.subCPU.irq();
            return;
        }

        // $FD0F: Writing disables BASIC ROM overlay
        if (addr === FD0F_ROM_SELECT) {
            if (this._basicRomEnabled) {
                console.log(`[ROM] BASIC ROM DISABLED (write $FD0F) at PC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
            }
            this._basicRomEnabled = false;
            return;
        }

        // FM77AV: $FD10 write - Mode control / Initiator ROM disable
        // Writing to $FD10 disables the Initiator ROM overlay,
        // returning $FE00-$FFFF to normal boot ROM and $6000-$7FFF to RAM.
        if (addr === 0xFD10 && this.isFM77AV) {
            this._fd10Reg = val;
            if (this._initiatorActive) {
                this._initiatorActive = false;
                // After Initiator hands off to F-BASIC, switch sub-CPU to
                // Type-C (FM-7 compatible) mode for full FM-7 software support.
                // The Initiator ROM boots with Type-A but F-BASIC and FM-7
                // tape software expect Type-C sub-system behavior.
                if (this._bootMode === 'basic') {
                    this._mainIOWrite(FD13_SUB_BANK, SUB_MONITOR_C);
                }
                console.log(`FM77AV: Initiator disabled via $FD10 write ($${val.toString(16)}), boot ROM now active`);
            }
            return;
        }

        // FM77AV: $FD12 write - 320/640 mode select
        // bit 6: 1=320x200 mode, 0=640x200 mode
        if (addr === FD12_SUB_MONITOR && this.isFM77AV) {
            const mode320 = (val & 0x40) !== 0;
            this.display._setDisplayMode(mode320 ? 1 : 0);
            return;
        }

        // FM77AV: $FD13 write - Sub ROM bank switch + Sub CPU reset
        // bit 1-0: subrom_bank (0=Type-A, 1=Type-B, 2=Type-C)
        // Writing triggers sub CPU reset
        if (addr === FD13_SUB_BANK && this.isFM77AV) {
            const bank = val & 0x03;
            const oldType = this._subMonitorType;
            this._subMonitorType = bank;
            // Reset sub CPU
            this._subBusy = true;
            this._subHalted = false;
            this._subResetFlag = true;

            // Reset display subsystem (matches display_reset in reference)
            this.display.resetALU();
            this.display.resetPalette();
            this.display.multiPage = 0;
            this.display.vramOffset[0] = 0;
            this.display.vramOffset[1] = 0;
            this.display._scrollApplied = [0, 0];
            this.display.vramOffsetFlag = false;
            this.display.crtOn = false;
            this.display.vramaFlag = false;
            this.display.activeVramPage = 0;
            this.display.displayVramPage = 0;
            // NOTE: displayMode (320/640) is NOT reset by sub ROM bank switch
            // NOTE: cgRomBank is NOT reset by sub ROM bank switch

            // Reset NMI mask (NMI enabled after sub reset)
            this._nmiMaskSub = false;
            this._blankFlag = true;  // Blanking active after reset

            // Keyboard mode: Type-A/B ROMs have internal scan-to-ASCII
            // conversion, so the keyboard sends scan codes. Type-C ROM
            // expects pre-converted ASCII codes (FM-7 compatible).
            if (bank === SUB_MONITOR_C) {
                this.keyboard._useScanCodes = false;
                this.keyboard._enableBreakCodes = false;
            } else {
                this.keyboard._useScanCodes = true;
                this.keyboard._enableBreakCodes = true;
            }

            this.subCPU.reset();
            this._subNmiDelay = 50; // Block NMI until sub CPU sets up stack
            this.scheduler.setSubHalted(false);
            if (oldType !== bank) {
                console.log('FM77AV: Sub ROM bank → Type-' +
                    ['A', 'B', 'C', 'CG'][bank] + ', sub CPU reset');
            }
            return;
        }

        // FM77AV: $FD30-$FD34 - Analog palette
        // $FD30: palette address high (bits 11-8 from low nibble of data)
        // $FD31: palette address low (full byte = bits 7-0)
        // $FD32: Blue level (low nibble = 4-bit blue intensity)
        // $FD33: Red level (low nibble = 4-bit red intensity)
        // $FD34: Green level (low nibble = 4-bit green intensity)
        if (this.isFM77AV) {
            if (addr === FD30_APAL_ADDR_HI) {
                // High nibble of 12-bit palette address
                this._analogPaletteAddr = (this._analogPaletteAddr & 0x0FF) | ((val & 0x0F) << 8);
                return;
            }
            if (addr === FD31_APAL_ADDR_LO) {
                // Low byte of 12-bit palette address
                this._analogPaletteAddr = (this._analogPaletteAddr & 0xF00) | (val & 0xFF);
                return;
            }
            if (addr === FD32_APAL_BLUE) {
                // Blue data for current palette entry
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0x0FF) | ((val & 0x0F) << 8);
                return;
            }
            if (addr === FD33_APAL_RED) {
                // Red data for current palette entry
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0xF0F) | ((val & 0x0F) << 4);
                return;
            }
            // $FD34: Green data for current palette entry
            if (addr === 0xFD34) {
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0xFF0) | (val & 0x0F);
                return;
            }
        }

        // $FD37: Multi-page register (main CPU side access)
        // Controls which color planes are visible (bit=1 → plane disabled)
        if (addr === 0xFD37) {
            if (this.display.multiPage !== val) {
                this.display.multiPage = val;
                this.display._fullDirty = true;
            }
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

        // $FD15: OPN command register (FM7 Programmers Guide §7.3)
        if (addr === 0xFD15 && !this._fmCardEnabled) return;
        //   bit1:0 (BDIR/BC1): $00=Inactive, $01=Read reg, $02=Write reg, $03=Address Latch
        //   bit2: Status read — loads OPN status register onto $FD16 data bus
        if (addr === 0xFD15) {
            // bit2: OPN status read mode — demo reads status via STA #$04,$FD15 / LDA $FD16
            if (val & 0x04) {
                this._opnDataBus = this.opn.readStatus();
            }
            switch (val & 0x03) {
                case 0x03: // Address Latch: latch data bus as register number
                    this._opnAddrLatch = this._opnDataBus & 0xFF;
                    break;
                case 0x02: // Write: write data bus to latched register
                    this.opn.writeReg(this._opnAddrLatch, this._opnDataBus);
                    // Also keep local copy for port A/B joystick reads
                    this._opnRegs[this._opnAddrLatch] = this._opnDataBus;
                    // SSG registers ($00-$0F): forward to PSG for audio output.
                    // PSG step() now converts CPU cycles to PSG clock internally,
                    // so no period scaling is needed — just forward raw values.
                    if (this._opnAddrLatch <= 0x0F) {
                        this.psg._writeReg(this._opnAddrLatch, this._opnDataBus);
                    }
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
            if (!this._fmCardEnabled) return;
            this._opnDataBus = val & 0xFF;
            return;
        }

        // $FD00: Keyboard port write (no-op, read-only register)
        if (addr === 0xFD00) return;

        // $FD04: FM77AV sub RAM protect / mode control (stub)
        if (addr === 0xFD04 && this.isFM77AV) return;

        // $FD06/$FD07: RS-232C USART write (stub: no device)
        if (addr === 0xFD06 || addr === 0xFD07) return;

        // $FD20-$FD2F: Kanji ROM ($FD20-$FD23, $FD2C-$FD2F) + reserved ($FD24-$FD2B)
        if (addr >= 0xFD20 && addr <= 0xFD2F) return;

        // $FDFD-$FDFF: Boot mode / extended registers (stub)
        if (addr >= 0xFDFD) return;

        // FM77AV: MMR registers ($FD80-$FD9F)
        if (this.isFM77AV && addr >= 0xFD80 && addr <= 0xFD9F) {
            // $FD93: MMR control register
            // bit 7: MMR enable, bit 6: stored for read-back, bits 3-0: segment select
            if (addr === FD93_MMR_CTRL) {
                this._mmrEnabled = (val & 0x80) !== 0;
                this._mmrBank93 = (val >> 6) & 0x01;
                this._mmrSegSelect = val & 0x0F;
                return;
            }
            // $FD90: MMR bank select register (selects which bank for $FD80-$FD8F AND address translation)
            if (addr === 0xFD90) {
                this._mmrBankReg = val & 0x07;
                return;
            }
            if (addr <= 0xFD8F) {
                // $FD80-$FD8F: write to segment registers for bank selected by $FD90
                this._mmrRegs[this._mmrBankReg * MMR_NUM_SEGMENTS + (addr - 0xFD80)] = val;
                return;
            }
            // $FD92: Indirect segment register write
            // Writes to the segment selected by $FD93 bits 3-0, in the bank selected by $FD90
            if (addr === FD92_MMR_SEG) {
                const seg = this._mmrSegSelect & 0x0F;
                this._mmrRegs[this._mmrBankReg * MMR_NUM_SEGMENTS + seg] = val;
                return;
            }
            // $FD91, $FD94-$FD9F: unused
            return;
        }

        // Log unhandled I/O writes (FM77AV mode only, throttled)
        if (this.isFM77AV) {
            const key = 0x10000 | (addr & 0xFFFF);
            if (!this._ioWarnSeen) this._ioWarnSeen = new Set();
            if (!this._ioWarnSeen.has(key)) {
                this._ioWarnSeen.add(key);
                console.warn(`[IO WRITE] Unhandled $${addr.toString(16).toUpperCase()} = $${val.toString(16).toUpperCase()} at MainPC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
            }
        }
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

            // $D400: Cancel/communication status from main CPU (NOT keyboard)
            // FIRQ handler reads LDD $D400: A=$D400 (cancel), B=$D401 (key)
            // bit 7: cancel flag from main CPU
            if (ioAddr === 0xD400) {
                let ret = 0x00;
                if (this._subCancel) {
                    ret |= 0x80; // Cancel pending
                }
                return ret;
            }
            // $D401: Keyboard data (same as main CPU $FD01)
            if (ioAddr === 0xD401) {
                return this.keyboard.readIO(0xFD01);
            }

            // Display/control I/O ($D402-$D40F)
            const result = this.display.readIO(ioAddr);

            // Handle side effects that need fm7-level state
            if (result.sideEffect === 'cancelAck') {
                // $D402: Cancel IRQ ACK
                this._subCancel = false;
                // De-assert IRQ on sub CPU
                // Since cancel is the only IRQ source for sub CPU, clear it
                this.subCPU.intr &= ~0x04;  // INTR_IRQ = 0x04
            } else if (result.sideEffect === 'attention') {
                // $D404: Set attention flag, trigger main CPU FIRQ
                this._subAttn = true;
                this.mainCPU.firq();
            } else if (result.sideEffect === 'beep') {
                // $D403: Sub CPU BEEP trigger (single 205ms tone)
                this._beepStart(205);
            } else if (result.sideEffect === 'busyOff') {
                // $D40A: Clear BUSY flag
                this._subBusy = false;
            }

            return result.value;
        }

        // FM77AV: $D410-$D4FF I/O area
        if (this.isFM77AV && addr >= 0xD410 && addr < 0xD500) {
            // $D440-$D4FF: Mirror to $D400-$D43F (6-bit mask)
            if (addr >= 0xD440) {
                return this._subRead(0xD400 + ((addr - 0xD400) & 0x3F));
            }
            // $D410-$D42B: ALU + line drawing registers
            if (addr <= 0xD42B) {
                const result = this.display.readIO(addr);
                return result.value;
            }
            // $D42C-$D42F: Additional FM77AV registers
            if (addr <= 0xD42F) {
                return 0xFF;
            }
            // $D430: MISC register read — STATUS (different from write!)
            // bit 7: blank_flag (0 when blanking active)
            // bit 4: line_busy (0 when line drawing active)
            // bit 2: vsync_flag (0 when NOT in vsync)
            // bit 0: subreset_flag (0 when sub CPU NOT reset)
            if (addr === 0xD430) {
                let ret = 0xFF;
                // bit 7: blank_flag (0 when blanking active)
                if (this._blankFlag) {
                    ret &= ~0x80;
                }
                // bit 4: line_busy (0 = busy)
                if (this.display.lineBusy) {
                    ret &= ~0x10;
                }
                // bit 2: vsync_flag (0 when NOT in vsync, i.e., during VBlank)
                if (!this._vsyncFlag) {
                    ret &= ~0x04;
                }
                // bit 0: subreset_flag (0 when sub CPU NOT in reset state)
                if (!this._subResetFlag) {
                    ret &= ~0x01;
                }
                return ret;
            }
            // $D431: Key encoder data receive (RTC MS58321 serial data)
            if (addr === 0xD431) {
                if (this._rtcRxBuf.length > 0) {
                    return this._rtcRxBuf.shift();
                }
                return 0xFF;
            }
            // $D432: Key encoder status
            // bit 7: RXRDY (0 = data ready in receive buffer)
            // bit 0: ACK (0 = ACK signal active after command processed)
            if (addr === 0xD432) {
                let val = 0xFF;
                if (this._rtcRxBuf.length > 0) val &= ~0x80; // RXRDY: data available
                if (this._rtcAck) { val &= ~0x01; this._rtcAck = false; }
                return val;
            }
            // $D433-$D43F: Other FM77AV registers
            return 0xFF;
        }

        // FM77AV: Extended work RAM at $D500-$D7FF
        if (this.isFM77AV && addr >= 0xD500 && addr < SUB_ROM_BASE) {
            return this.display.workRam[0x1380 + (addr - 0xD500)];
        }

        // $D410-$D7FF: mirror / open bus
        if (addr < SUB_ROM_BASE) {
            if (this.isFM77AV) {
                // FM77AV: $D410-$D4FF already handled above
                return 0xFF;
            }
            // FM-7: $D410-$D7FF mirrors $D400-$D40F
            return this._subRead(0xD400 + ((addr - 0xD400) & 0x0F));
        }

        // $D800-$DFFF: CG ROM (FM77AV) or Sub ROM (FM-7)
        if (addr < SUB_ROM_AV_BASE) {
            if (this.isFM77AV) {
                // Type-C: use sub ROM (FM-7 compatible)
                if (this._subMonitorType === SUB_MONITOR_C) {
                    return this.subROM[addr - SUB_ROM_BASE];
                }
                // Type-A/B: CG ROM with bank switching
                const cgAddr = this._cgRomBank * 0x0800 + (addr - 0xD800);
                if (cgAddr < this.cgROM.length) {
                    return this.cgROM[cgAddr];
                }
                return 0xFF;
            }
            // FM-7: Sub ROM
            return this.subROM[addr - SUB_ROM_BASE];
        }

        // $E000-$FFFF: Code ROM (bank-switched on FM77AV)
        if (this.isFM77AV) {
            // Type-C: FM-7 compatible sub ROM
            if (this._subMonitorType === SUB_MONITOR_C) {
                return this.subROM[addr - SUB_ROM_BASE];
            }
            // Type-A or Type-B
            const rom = (this._subMonitorType === SUB_MONITOR_A) ? this.subROM_A : this.subROM_B;
            const romSize = (this._subMonitorType === SUB_MONITOR_A)
                ? (this._subROM_ASize || 0x2000)
                : (this._subROM_BSize || 0x2000);

            if (romSize > 0x2000) {
                // 10KB ROM: $E000-$FFFF portion
                return rom[addr - SUB_ROM_BASE];
            }
            // 8KB ROM: covers $E000-$FFFF
            return rom[addr - SUB_ROM_AV_BASE];
        }

        // FM-7: Type-C ROM fixed
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
            // $D000=$FF is written by sub CPU IRQ handler at $E073 (STA $D000).
            // Command processing returns via $E06C (BRA $E034 → LDS #$D000 → $E13E loop).
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

        // FM77AV: $D410-$D4FF I/O area
        if (this.isFM77AV && addr >= 0xD410 && addr < 0xD500) {
            // $D440-$D4FF: Mirror to $D400-$D43F (6-bit mask)
            if (addr >= 0xD440) {
                this._subWrite(0xD400 + ((addr - 0xD400) & 0x3F), val);
                return;
            }
            // $D410-$D42B: ALU + line drawing registers
            if (addr <= 0xD42B) {
                this.display.writeIO(addr, val);
                return;
            }
            // $D42C-$D42F: Additional FM77AV registers
            if (addr <= 0xD42F) {
                return;
            }
            // $D430: MISC register write
            // bit 7: NMI mask (1=masked)
            // bit 6: display page select
            // bit 5: active page select
            // bit 2: extended VRAM offset flag
            // bit 1-0: CG ROM bank
            if (addr === 0xD430) {
                // NMI mask (bit 7)
                this._nmiMaskSub = (val & 0x80) !== 0;
                if (this._nmiMaskSub) {
                    // Clear pending NMI on sub CPU
                    this.subCPU.intr &= ~0x01;  // INTR_NMI = 0x01
                }

                // Active VRAM page (bit 5)
                this.display._setActiveVramPage((val >> 5) & 1);

                // Display VRAM page (bit 6)
                this.display._setDisplayVramPage((val >> 6) & 1);

                // Extended VRAM offset flag (bit 2)
                this.display.vramOffsetFlag = (val & 0x04) !== 0;

                // CG ROM bank (bits 1-0)
                this._cgRomBank = val & 0x03;

                this.display.miscReg = val;
                return;
            }
            // $D431: Key encoder data send — RTC commands from sub CPU
            if (addr === 0xD431) {
                this._rtcProcessCommand(val);
                return;
            }
            // $D432: Key encoder status (read-only, writes ignored)
            // $D433-$D43F: Other FM77AV registers
            return;
        }

        // FM77AV: Extended work RAM at $D500-$D7FF
        if (this.isFM77AV && addr >= 0xD500 && addr < SUB_ROM_BASE) {
            this.display.workRam[0x1380 + (addr - 0xD500)] = val;
            return;
        }

        // $D410+: mirrors / open bus
        if (addr < SUB_ROM_BASE) {
            if (this.isFM77AV) {
                // FM77AV: $D410-$D4FF already handled above
                return;
            }
            // FM-7: mirrors $D400-$D40F
            this._subWrite(0xD400 + ((addr - 0xD400) & 0x0F), val);
            return;
        }

        // $D800-$FFFF: ROM area, writes are ignored
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

                // VBlank timing: count down VBlank period
                if (this._vblankCycles > 0) {
                    this._vblankCycles -= mainElapsed;
                    if (this._vblankCycles <= 0) {
                        this._vsyncFlag = true;  // Active display resumes
                        this._vblankCycles = 0;
                    }
                }

                // Sub CPU NMI delay (INTR_SLOAD emulation)
                if (this._subNmiDelay > 0) {
                    this._subNmiDelay -= mainElapsed;
                }

                // HBlank timing (§12.1): line period ≈63.5μs (127 cycles @2MHz)
                // HBlank = 24μs (48 cycles), display = 39-40μs (79 cycles)
                if (this.isFM77AV) {
                    this._hblankCounter = ((this._hblankCounter || 0) + mainElapsed) % 127;
                    this._blankFlag = this._hblankCounter >= 79;
                }

                // PSG audio synthesis (generates samples into ring buffer)
                this.psg.step(mainElapsed);
                if (this._fmCardEnabled) this.opn.step(mainElapsed);
                this.cmt.step(mainElapsed);

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
            return actualCycles / (1794000 / 1000000);
        };

        // Timer IRQ event (~2034.5us period, ~491.6 Hz)
        this.scheduler.addTimerEvent(() => {
            this._timerIRQ = true;
        });

        // VSync event (66.1 Hz, ~15120μs frame period per FM7 Programmers Guide §12.1)
        this.scheduler.addEvent('vsync', 15120, () => {
            this.display.frameCount++;

            // Start vertical blanking period
            this._vsyncFlag = false;  // Enter VBlank
            // VBlank lasts ~510μs (VSYNC pulse)
            this._vblankCycles = usToCycles(510);
        });

        // Sub CPU NMI timer (50 Hz = 20ms, independent of VSync per §4.2)
        this.scheduler.addEvent('subnmi', 20000, () => {
            if (!this._subHalted && !(this.isFM77AV && this._nmiMaskSub)
                && this._subNmiDelay <= 0) {
                if (!(this.subCPU.intr & 0x01)) {
                    this.subCPU.nmi();
                }
            }
        });
    }

    /** Check all IRQ/FIRQ sources and assert on CPUs */
    _checkAndAssertInterrupts() {
        // Main CPU IRQ: timer, keyboard, FDC, OPN timers
        // FM-7 IRQ is level-triggered: asserted as long as source is active
        let mainIrq = false;

        // Timer IRQ: $FD02 bit2 (1=enable)
        if (this._timerIRQ && (this._irqMaskReg & 0x04)) mainIrq = true;

        // Keyboard IRQ: use keyboard module's actual state (handles its own mask)
        if (this.keyboard.isIRQActive()) mainIrq = true;

        // FDC IRQ: check FDC's own flag directly (cleared by reading $FD18)
        if (this.fdc.irqFlag) mainIrq = true;

        // OPN Timer IRQ: routed through $FD03 bit3 "extended interrupt"
        // (FM7 Programmers Guide §3.1). Edge-triggered latch: set on new
        // OPN timer overflow, cleared by reading $FD03. This prevents the
        // level-triggered OPN status flag from causing continuous IRQ re-entry.
        if (this._fmCardEnabled) {
            const opnActive = (this.opn.timerAFlag && this.opn._timerAIRQ) ||
                              (this.opn.timerBFlag && this.opn._timerBIRQ);
            if (opnActive && !this._opnIrqPrev) this._opnIrqLatch = true;
            this._opnIrqPrev = opnActive;
            if (this._opnIrqLatch) mainIrq = true;
        }

        if (mainIrq) this.mainCPU.irq();

        // Sub CPU FIRQ: keyboard-driven (active whenever key data available)
        // On real FM-7, the keyboard encoder IC generates FIRQ to sub CPU
        // independently of the main CPU IRQ mask ($FD02). FIRQ is asserted
        // as long as keyboard data is available, regardless of mask setting.
        if (this.keyboard._keyAvailable) {
            this.subCPU.intr |= 0x02; // INTR_FIRQ
        } else {
            this.subCPU.intr &= ~0x02;
        }

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
            // Start / resume audio on first user gesture
            if (!this.psg._audioCtx) {
                this.psg.startAudio();
            } else {
                this.psg.resumeAudio();
            }
            if (!this.opn._audioCtx) {
                this.opn.startAudio();
            } else {
                this.opn.resumeAudio();
            }

            if (this._breakKeyCodes.includes(e.code)) {
                e.preventDefault();
                this._breakKey = true;
                this.mainRAM[0x0313] = 0xFF;
                return;
            }
            this.keyboard.keyDown(e);
        };
        this._keyUpHandler = (e) => {
            if (this._breakKeyCodes.includes(e.code)) {
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
            { name: 'FBASIC30.ROM',  loader: (d) => this.loadFBasicROM(d) },
            { name: 'BOOT_BAS.ROM',  loader: (d) => this.loadBootBasROM(d) },
            { name: 'BOOT_DOS.ROM',  loader: (d) => this.loadBootROM(d) },
            { name: 'SUBSYS_C.ROM',  loader: (d) => this.loadSubROM(d) },
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
        console.log(`F-BASIC ROM loaded: ${len} bytes`);
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
        console.log(`Boot DOS ROM loaded: ${len} bytes`);
    }

    /**
     * Load BASIC Boot ROM ($FE00-$FFFF, 512 bytes)
     * @param {ArrayBuffer} data
     */
    loadBootBasROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, BOOT_ROM_SIZE);
        this.bootBasROM.set(src.subarray(0, len));
        this.romLoaded.bootBas = true;
        console.log(`Boot BASIC ROM loaded: ${len} bytes`);
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
     * Load CG ROM (character generator, up to 8KB = 4 banks x 2KB)
     * @param {ArrayBuffer} data
     */
    loadCGROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.cgROM.length);
        this.cgROM.set(src.subarray(0, len));
        this.romLoaded.cg = true;
        console.log(`CG ROM loaded: ${len} bytes (${Math.ceil(len / 0x0800)} banks)`);
    }

    // =========================================================================
    // FM77AV ROM Loading
    // =========================================================================

    /**
     * Load Initiator ROM (FM77AV, 8KB)
     * @param {ArrayBuffer} data
     */
    loadInitiateROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.initiateROM.length);
        this.initiateROM.set(src.subarray(0, len));
        this._initiateROMSize = len;

        // Detect original model for ROM info display
        this._initiateOriginalModel = null;
        if (len > 0x0B13) {
            const b = [src[0x0B0E], src[0x0B0F], src[0x0B10], src[0x0B11], src[0x0B12], src[0x0B13]];
            if (b.every(v => v === 0xFF)) {
                this._initiateOriginalModel = 'FM77AV';
            } else {
                const str = String.fromCharCode(...b);
                const models = {
                    '200Ma.': 'FM77AV20', '201Ma.': 'FM77AV20EX',
                    '400Ma.': 'FM77AV40', '401Ma.': 'FM77AV40EX/SX'
                };
                this._initiateOriginalModel = models[str] || `Unknown ("${str}")`;
            }
        }

        this.romLoaded.initiate = true;
        console.log(`Initiator ROM loaded: ${len} bytes`);
    }

    /**
     * Patch Initiator ROM to behave as FM77AV (初代).
     * 1. Force version string to all $FF (FM77AV identity)
     * 2. Disable "new boot" code transfer (BRA → BRN)
     * 3. Redirect new boot JMP $5000 → JMP $FE00 (old boot)
     */
    _patchInitiatorToAV() {
        const rom = this.initiateROM;
        const patches = [];

        // 1. Version string patch: force all $FF at $0B0E-$0B13
        if (rom[0x0B0E] !== 0xFF) {
            for (let i = 0x0B0E; i <= 0x0B13; i++) {
                rom[i] = 0xFF;
            }
            patches.push('version string → $FF');
        }

        // 2. Find and disable BRA to new boot transfer code
        //    First locate LDU #$7C00 (CE 7C 00) — the new boot copy source setup.
        //    Then find the BRA ($20) that branches to that address.
        //    Patch BRA ($20 xx) → BRN ($21 xx) to skip new boot code copy.
        let newBootCopyAddr = -1;
        for (let i = 0; i < this._initiateROMSize - 2; i++) {
            if (rom[i] === 0xCE && rom[i + 1] === 0x7C && rom[i + 2] === 0x00) {
                newBootCopyAddr = i;
                break;
            }
        }
        if (newBootCopyAddr >= 0) {
            for (let i = 0; i < this._initiateROMSize - 1; i++) {
                if (rom[i] === 0x20) {
                    const disp = rom[i + 1];
                    const target = i + 2 + (disp > 127 ? disp - 256 : disp);
                    if (target === newBootCopyAddr) {
                        rom[i] = 0x21; // BRA → BRN (Branch Never)
                        patches.push(`BRA→BRN at $${(0x6000 + i).toString(16).toUpperCase()}`);
                        break;
                    }
                }
            }
        }

        // 3. Find and redirect JMP $5000 → JMP $FE00
        //    Patch $7E $50 $00 → $7E $FE $00
        for (let i = 0; i < this._initiateROMSize - 2; i++) {
            if (rom[i] === 0x7E && rom[i + 1] === 0x50 && rom[i + 2] === 0x00) {
                rom[i + 1] = 0xFE;
                // rom[i + 2] stays 0x00
                patches.push(`JMP $5000→$FE00 at $${(0x6000 + i).toString(16).toUpperCase()}`);
                break;
            }
        }

        if (patches.length > 0) {
            console.warn(`Initiator ROM patched to FM77AV: ${patches.join(', ')}`);
        }
    }

    /**
     * Load Sub-system Type-A ROM (FM77AV, 8KB)
     * @param {ArrayBuffer} data
     */
    loadSubROM_A(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.subROM_A.length);
        this.subROM_A.set(src.subarray(0, len));
        this._subROM_ASize = src.length;
        this.romLoaded.subA = true;
        console.log(`Sub ROM Type-A loaded: ${src.length} bytes`);
    }

    /**
     * Load Sub-system Type-B ROM (FM77AV, 8KB)
     * @param {ArrayBuffer} data
     */
    loadSubROM_B(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.subROM_B.length);
        this.subROM_B.set(src.subarray(0, len));
        this._subROM_BSize = src.length;
        this.romLoaded.subB = true;
        console.log(`Sub ROM Type-B loaded: ${src.length} bytes`);
    }

    // =========================================================================
    // Machine Type
    // =========================================================================

    /**
     * Set the machine type. Must be called before reset().
     * @param {string} type - 'fm7' or 'fm77av'
     */
    setMachineType(type) {
        if (type !== MACHINE_FM7 && type !== MACHINE_FM77AV) {
            console.warn(`Unknown machine type: ${type}, defaulting to fm7`);
            type = MACHINE_FM7;
        }
        this._machineType = type;
        const isAV = type === MACHINE_FM77AV;
        const cpuHz = isAV ? 2000000 : 1794000;
        setCPUClock(cpuHz);
        this.opn.setAVMode(isAV);
        this.opn.setCPUClock(cpuHz);
        this.psg.setCPUClock(cpuHz);
        console.log(`Machine type set to: ${type} (CPU ${cpuHz/1000}kHz)`);
    }

    /**
     * @returns {boolean} true if current machine type is FM77AV
     */
    get isFM77AV() {
        return this._machineType === MACHINE_FM77AV;
    }

    /**
     * Enable/disable FM sound card (OPN + joystick port).
     * FM77AV always has OPN built-in; this only affects FM-7 mode.
     */
    setFMCard(enabled) {
        this._fmCardEnabled = enabled || this.isFM77AV;
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

    /**
     * Load a T77 tape image.
     * @param {ArrayBuffer} data - T77 file data
     * @returns {boolean} success
     */
    loadTape(data) {
        return this.cmt.loadT77(data);
    }

    // =========================================================================
    // Debug: Sub CPU ROM dump & trace
    // =========================================================================

    /**
     * Dump sub CPU memory as hex string.
     * Usage from console: fm7.dumpSub(0xE100, 256)
     */
    dumpSub(addr, length = 128) {
        const lines = [];
        for (let i = 0; i < length; i += 16) {
            const a = (addr + i) & 0xFFFF;
            let hex = '';
            let ascii = '';
            for (let j = 0; j < 16 && (i + j) < length; j++) {
                const b = this._subRead((a + j) & 0xFFFF);
                hex += b.toString(16).padStart(2, '0') + ' ';
                ascii += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
            }
            lines.push(`${a.toString(16).padStart(4, '0')}: ${hex.padEnd(48)} ${ascii}`);
        }
        console.log(lines.join('\n'));
        return lines.join('\n');
    }

    /**
     * Enable sub CPU execution trace for N instructions.
     * Usage: fm7.traceSubOn(500) then trigger scroll
     */
    traceSubOn(count = 200) {
        this._subTraceCount = count;
        this._subTraceLog = [];
        console.log(`[TRACE] Sub CPU trace enabled for ${count} instructions`);
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
        this._subHaltRequest = false;
        this._subHaltDeferred = 0;
        this._subBusy     = true;   // BUSY set on reset (sub CPU clears via $D40A read during init)
        this._subCancel   = false;
        this._subAttn     = false;
        this._breakKey    = false;
        this._timerIRQ    = false;
        this._irqMaskReg  = 0;
        // BASIC ROM: enabled on BASIC boot, disabled on DOS boot
        this._basicRomEnabled = (this._bootMode === 'basic');
        this._fbasicWarnShown = false;

        // Reset OPN state
        this._opnAddrLatch = 0;
        this._opnDataBus = 0;
        this._opnRegs.fill(0);
        this._gamepadState[0] = 0xFF;
        this._gamepadState[1] = 0xFF;

        // FM77AV specific reset
        if (this.isFM77AV) {
            // Patch Initiator ROM to FM77AV (初代)
            // Ensures any AV20/AV40/EX/SX ROM behaves as FM77AV
            if (this._initiateROMSize > 0x0B13) {
                this._patchInitiatorToAV();
            }
            this._initiatorActive = true;  // Initiator ROM active at power-on
            this._subMonitorType = SUB_MONITOR_A;  // FM77AV boots with Type-A (native)
            // The Initiator ROM will write $FD13 to switch to Type-A
            this._cgRomBank = 0;
            this._nmiMaskSub = false;
            this._subResetFlag = false;
            this._vsyncFlag = true;
            this._blankFlag = true;   // Blanking active at power-on
            this._vblankCycles = 0;
            this._analogPaletteAddr = 0;
            this._analogPalette.fill(0);
            // MMR reset
            this._mmrEnabled = false;
            this._mmrBankReg = 0;
            this._mmrBank93 = 0;
            this._mmrSegSelect = 0;
            this._mmrRegs.fill(0);
            // Default MMR mapping: identity (segment N → physical page N + $30 for main RAM)
            for (let bank = 0; bank < 8; bank++) {
                for (let seg = 0; seg < MMR_NUM_SEGMENTS; seg++) {
                    this._mmrRegs[bank * MMR_NUM_SEGMENTS + seg] = 0x30 + seg;
                }
            }
            // Share analog palette reference with display
            this.display.analogPalette = this._analogPalette;
            // Enable FM77AV features in display (ALU, line drawing)
            this.display.isAV = true;
            // FM77AV: scan codes + break codes
            this.keyboard._enableBreakCodes = true;
            this.keyboard._useScanCodes = true;
        } else {
            this._initiatorActive = false;
            this._subMonitorType = SUB_MONITOR_C;
            this._cgRomBank = 0;
            this.display.analogPalette = null;
            this.display.isAV = false;
            // FM-7: ASCII character codes, no break codes
            // FM-7 keyboard encoder outputs ASCII, sub CPU passes through
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
        }

        // Reset all components
        this.display.reset();
        this.fdc.reset();
        this.cmt.reset();
        this.keyboard.reset();
        this.psg.reset();
        this.opn.reset();
        this.scheduler.reset();

        // Re-apply keyboard mode after reset
        if (this.isFM77AV) {
            this.keyboard._enableBreakCodes = true;
            this.keyboard._useScanCodes = true;
        }

        // For FM-7 BASIC boot: install a minimal boot stub that jumps
        // directly to F-BASIC cold start ($8000), bypassing boot_dos.rom
        // which tries disk boot and fails without proper NOT_READY handling.
        // On real FM-7 without disk controller, the boot ROM at $FE00 simply
        // jumps to F-BASIC. With disk controller in BASIC mode, the DIP switch
        // or boot ROM variant skips disk boot.
        if (bootMode === 'basic' && this.romLoaded.bootBas) {
            if (this.isFM77AV) {
                // FM77AV BASIC boot: Initiator ROM handles boot device selection
                // via $FD0B bit0 (1=BASIC). Initiator reads $FD0B and branches
                // to F-BASIC cold start instead of disk boot.
                // No stub needed — Initiator ROM + $FD0B is sufficient.
                this._basicBootStub = null;
            } else {
                // FM-7 BASIC boot: use boot_bas.rom ($FE00-$FFDF code area)
                this._basicBootStub = new Uint8Array(BOOT_ROM_SIZE);
                this._basicBootStub.set(this.bootBasROM);
            }
        } else {
            this._basicBootStub = null;
        }

        // $FFE0-$FFFF is always RAM on FM-7 (interrupt vectors, reset vector)
        // Write interrupt/reset vectors to RAM at $FFE0-$FFFF.
        // CPU reads vectors from RAM (the $FFE0+ area is always RAM).
        {
            const bootSrc = this._basicBootStub || this.bootROM;
            // Step 1: Copy boot ROM vectors (IRQ, NMI, FIRQ, SWI, etc.)
            for (let i = 0xFFE0; i <= 0xFFFF; i++) {
                const romByte = bootSrc[i - BOOT_ROM_BASE];
                if (romByte !== 0xFF) {
                    this.mainRAM[i] = romByte;
                }
            }
            // Step 2: FM77AV — overlay with Initiator ROM vectors.
            // The initiator ROM defines only the reset vector ($6000),
            // all others are $FF. This overwrites boot ROM's $FE00 reset
            // with the initiator's $6000 entry point.
            if (this.isFM77AV && this.romLoaded.initiate) {
                const romSize = this._initiateROMSize || BOOT_ROM_SIZE;
                for (let i = 0xFFE0; i <= 0xFFFF; i++) {
                    const romOffset = (romSize > BOOT_ROM_SIZE)
                        ? (i - BOOT_ROM_BASE) + (romSize - BOOT_ROM_SIZE)
                        : (i - BOOT_ROM_BASE);
                    const romByte = this.initiateROM[romOffset];
                    if (romByte !== 0xFF) {
                        this.mainRAM[i] = romByte;
                    }
                }
            }
            // Fallback: ensure reset vector is not $0000
            if (this.mainRAM[0xFFFE] === 0x00 && this.mainRAM[0xFFFF] === 0x00) {
                if (this.romLoaded.boot) {
                    this.mainRAM[0xFFFE] = this.bootROM[0x1FE];
                    this.mainRAM[0xFFFF] = this.bootROM[0x1FF];
                }
            }
        }

        // Reset CPUs - they read their reset vectors
        // On FM-7: Boot ROM at $FE00-$FFFF determines the reset vector
        // On FM77AV: Initiator ROM at $FE00-$FFFF runs first
        this.mainCPU.reset();
        this.subCPU.reset();
        this._subNmiDelay = 50; // Block NMI until sub CPU sets up stack

        // Sub CPU is already set to running above; sync scheduler
        this.scheduler.setSubHalted(false);

        // Log reset vector for debugging
        const rvHi = this._mainRead(0xFFFE);
        const rvLo = this._mainRead(0xFFFF);
        const resetVec = (rvHi << 8) | rvLo;
        console.log(`${this._machineType.toUpperCase()} reset (boot mode: ${bootMode})`);
        console.log(`  Main CPU reset vector: $${resetVec.toString(16).toUpperCase().padStart(4, '0')}`);
        console.log(`  Initiator: ${this._initiatorActive ? 'ACTIVE' : 'OFF'}, ROM loaded: ${this.romLoaded.initiate}`);
        console.log(`  Sub monitor: Type-${['A','B','C'][this._subMonitorType]}, ROM loaded: A=${this.romLoaded.subA} B=${this.romLoaded.subB} C=${this.romLoaded.sub}`);

        // Sub CPU reset vector
        const srvHi = this._subRead(0xFFFE);
        const srvLo = this._subRead(0xFFFF);
        const subResetVec = (srvHi << 8) | srvLo;
        console.log(`  Sub CPU reset vector: $${subResetVec.toString(16).toUpperCase().padStart(4, '0')}`);

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

        // Start audio on emulation start (user gesture context)
        if (!this.psg._audioCtx) {
            this.psg.startAudio();
        } else {
            this.psg.resumeAudio();
        }
        if (!this.opn._audioCtx) {
            this.opn.startAudio();
        } else {
            this.opn.resumeAudio();
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

        // Stop any active BEEP sound
        this._beepStop();

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

        // Run scheduler for one browser frame (~16667μs = 60 Hz).
        // Internal VSync event fires at 66.1 Hz (15120μs) independently.
        // CMT turbo: run 50x faster only when actively reading a tape
        const cmtTurbo = (this.cmt.motor && this.cmt.loaded) ? 50 : 1;
        try {
            this.scheduler.exec(16667 * cmtTurbo);
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
            machineType: this._machineType,
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
            // FM77AV specific
            initiatorActive: this._initiatorActive,
            subMonitorType: this._subMonitorType,
            // FDC status
            fdcBusy: (this.fdc.statusReg & 0x01) !== 0,
            fdcAccess: this.fdc.accessLatch,
            fdcMotor: this.fdc.motorOn,
            fdcDrive: this.fdc.currentDrive,
            fdcTrack: this.fdc.headPosition[this.fdc.currentDrive],
            fdcSector: this.fdc.sectorReg,
            fdcState: this.fdc.state,
        };
    }

    /**
     * Debug: dump display and VRAM state to console.
     * Call from browser console: fm7.debugDisplay()
     */
    debugDisplay() {
        const d = this.display;
        console.log('=== Display Debug ===');
        console.log(`  displayMode: ${d.displayMode === 0 ? '640x200' : '320x200'}`);
        console.log(`  crtOn: ${d.crtOn}, vramaFlag: ${d.vramaFlag}`);
        console.log(`  activeVramPage: ${d.activeVramPage}, displayVramPage: ${d.displayVramPage}`);
        console.log(`  multiPage: $${(d.multiPage||0).toString(16)}`);
        console.log(`  vramOffset: [${d.vramOffset[0]}, ${d.vramOffset[1]}]`);
        console.log(`  subMonitorType: ${['A','B','C'][this._subMonitorType] || this._subMonitorType}`);
        console.log(`  subBusy: ${this._subBusy}, subHalted: ${this._subHalted}`);
        console.log(`  blankFlag: ${this._blankFlag}, nmiMask: ${this._nmiMaskSub}`);
        console.log(`  subPC: $${(this.subCPU.pc||0).toString(16).toUpperCase()}`);
        console.log(`  MMR: enabled=${this._mmrEnabled} bankReg=$FD90=${this._mmrBankReg}`);
        // Check VRAM content
        let page0nonzero = 0, page1nonzero = 0;
        for (let i = 0; i < d.vram.length; i++) { if (d.vram[i]) page0nonzero++; }
        for (let i = 0; i < d.vramPage1.length; i++) { if (d.vramPage1[i]) page1nonzero++; }
        console.log(`  VRAM page0 non-zero bytes: ${page0nonzero}/${d.vram.length}`);
        console.log(`  VRAM page1 non-zero bytes: ${page1nonzero}/${d.vramPage1.length}`);
        // Shared RAM content
        const shHex = Array.from(this.sharedRAM.slice(0, 32)).map(v=>v.toString(16).padStart(2,'0')).join(' ');
        console.log(`  SharedRAM[0..31]: ${shHex}`);
        // Analog palette sample
        if (this._analogPalette) {
            const nonzero = Array.from(this._analogPalette).filter(v=>v!==0).length;
            console.log(`  AnalogPalette non-zero: ${nonzero}/4096`);
        }
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

    /**
     * Set the FM-7 joystick port (0 or 1) that the first browser gamepad maps to.
     * @param {number} port - 0 for Port 1, 1 for Port 2
     */
    setJoystickPort(port) {
        this._joystickPort = port & 1;
    }

    /** Poll Gamepad API and update joystick state. */
    _pollGamepads() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        // Reset both ports
        this._gamepadState[0] = 0xFF;
        this._gamepadState[1] = 0xFF;

        for (let gi = 0; gi < gamepads.length; gi++) {
            const gp = gamepads[gi];
            if (!gp || !gp.connected) continue;

            let state = 0xFF;  // active low: 1 = not pressed
            const deadzone = 0.3;
            const ax0 = gp.axes[0] || 0;
            const ax1 = gp.axes[1] || 0;
            if (ax1 < -deadzone || (gp.buttons[12] && gp.buttons[12].pressed)) state &= ~0x01;
            if (ax1 >  deadzone || (gp.buttons[13] && gp.buttons[13].pressed)) state &= ~0x02;
            if (ax0 < -deadzone || (gp.buttons[14] && gp.buttons[14].pressed)) state &= ~0x04;
            if (ax0 >  deadzone || (gp.buttons[15] && gp.buttons[15].pressed)) state &= ~0x08;
            if ((gp.buttons[0] && gp.buttons[0].pressed) ||
                (gp.buttons[2] && gp.buttons[2].pressed)) state &= ~0x10;
            if ((gp.buttons[1] && gp.buttons[1].pressed) ||
                (gp.buttons[3] && gp.buttons[3].pressed)) state &= ~0x20;

            // Map browser gamepad to FM-7 port based on user selection
            const port = (gi === 0) ? (this._joystickPort || 0) : (1 - (this._joystickPort || 0));
            if (port < 2) {
                this._gamepadState[port] = state;
            }
            if (gi >= 1) break; // Max 2 gamepads
        }
    }

    // =========================================================================
    // RTC (MS58321) via Key Encoder
    // =========================================================================

    /**
     * Process a command byte sent by sub CPU to key encoder ($D431 write).
     * The RTC is accessed through a simple serial protocol:
     * - Command $00: reset
     * - Command $01-$0C: read RTC register (returns BCD nibble)
     * - Command $11-$1C: write RTC register
     */
    _rtcProcessCommand(val) {
        // Simple implementation: respond to RTC read commands
        // by returning current host time in BCD format.
        // Registers: 0=sec1, 1=sec10, 2=min1, 3=min10, 4=hr1, 5=hr10,
        //            6=weekday, 7=day1, 8=day10, 9=month1, 10=month10,
        //            11=year1, 12=year10
        const now = new Date();
        const rtcRegs = [
            now.getSeconds() % 10,       // S1
            Math.floor(now.getSeconds() / 10), // S10
            now.getMinutes() % 10,       // M1
            Math.floor(now.getMinutes() / 10), // M10
            now.getHours() % 10,         // H1
            Math.floor(now.getHours() / 10),   // H10
            now.getDay(),                // weekday (0=Sun)
            now.getDate() % 10,          // D1
            Math.floor(now.getDate() / 10),    // D10
            (now.getMonth() + 1) % 10,   // Mon1
            Math.floor((now.getMonth() + 1) / 10), // Mon10
            (now.getFullYear() % 100) % 10,    // Y1
            Math.floor((now.getFullYear() % 100) / 10), // Y10
        ];

        if (val >= 0x01 && val <= 0x0D) {
            // Read register: return BCD nibble
            const reg = val - 1;
            if (reg < rtcRegs.length) {
                this._rtcRxBuf.push(rtcRegs[reg] & 0x0F);
            } else {
                this._rtcRxBuf.push(0);
            }
            this._rtcAck = true;
        } else if (val >= 0x11 && val <= 0x1D) {
            // Write register: accept but ignore (host clock is read-only)
            this._rtcAck = true;
        } else if (val === 0x00) {
            // Reset
            this._rtcRxBuf = [];
            this._rtcAck = true;
        }
    }

    // =========================================================================
    // BEEP Sound
    // =========================================================================

    /**
     * Start BEEP tone.
     * @param {number} durationMs - Duration in ms, or -1 for continuous
     */
    _beepStart(durationMs) {
        // Use PSG's AudioContext if available
        const ctx = this.psg._audioCtx;
        if (!ctx) return;

        this._beepStop(); // Stop any existing beep

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 1200; // FM-7 BEEP frequency ~1.2kHz

        // Smooth gain ramp to avoid click noise
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.003); // 3ms fade-in

        osc.connect(gain);
        // Route through PSG volume control so BEEP respects the volume slider
        gain.connect(this.psg._gainNode || ctx.destination);
        osc.start(now);

        this._beepOsc = osc;
        this._beepGain = gain;
        this._beepContinuous = (durationMs < 0);

        if (durationMs > 0) {
            // Use Web Audio API scheduling instead of setTimeout for precise timing
            const endTime = now + durationMs / 1000;
            gain.gain.setValueAtTime(0.15, endTime - 0.003);
            gain.gain.linearRampToValueAtTime(0, endTime); // 3ms fade-out
            osc.stop(endTime + 0.001);
            // Clean up references after oscillator ends
            osc.onended = () => {
                if (this._beepOsc === osc) {
                    this._beepOsc = null;
                    this._beepGain = null;
                    this._beepContinuous = false;
                }
            };
        }
    }

    /** Stop BEEP tone. */
    _beepStop() {
        if (this._beepOsc) {
            const ctx = this.psg._audioCtx;
            if (ctx && this._beepGain) {
                // Smooth fade-out to avoid click
                const now = ctx.currentTime;
                this._beepGain.gain.cancelScheduledValues(now);
                this._beepGain.gain.setValueAtTime(this._beepGain.gain.value, now);
                this._beepGain.gain.linearRampToValueAtTime(0, now + 0.003);
                try { this._beepOsc.stop(now + 0.005); } catch (e) { /* ignore */ }
            } else {
                try { this._beepOsc.stop(); } catch (e) { /* ignore */ }
                this._beepOsc.disconnect();
            }
            this._beepOsc = null;
        }
        if (this._beepGain) {
            // Don't disconnect immediately - let fade-out complete
            const g = this._beepGain;
            this._beepGain = null;
            setTimeout(() => { try { g.disconnect(); } catch (e) {} }, 10);
        }
        this._beepContinuous = false;
    }

    /**
     * Clean up event listeners.
     */
    destroy() {
        this.stop();
        this.psg.stopAudio();
        this.opn.stopAudio();
        document.removeEventListener('keydown', this._keyDownHandler);
        document.removeEventListener('keyup', this._keyUpHandler);
        if (this._gamepadHandler) {
            window.removeEventListener('gamepadconnected', this._gamepadHandler);
        }
    }
}
