// =============================================================================
// FM-7 Web Emulator - Main System Class
//
// Ties together all components: dual 6809 CPUs, memory, display, FDC,
// scheduler, and keyboard into a working FM-7 emulation.
// =============================================================================

import { CPU6809 } from './cpu6809.js';
import { Display } from './display.js';
import { FDC } from './fdc.js';
import { FddSound } from './fdd_sound.js';
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
const FBASIC_ROM_BASE    = 0x8000;   // BASIC ROM ($8000-$FBFF)
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

// FM77AV Sub monitor types (matches $FD13 register values)
const SUB_MONITOR_C      = 0;        // FM-7 compatible ($FD13=0)
const SUB_MONITOR_A      = 1;        // FM77AV native / INITIATE ($FD13=1)
const SUB_MONITOR_B      = 2;        // FM77AV extended ($FD13=2)

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
const FD92_TWR_OFFSET    = 0xFD92;   // TWR (Text Window RAM) offset register
const FD93_MMR_CTRL      = 0xFD93;   // MMR control register
const MMR_WINDOW_SIZE    = 0x1000;   // 4KB per MMR window
const MMR_NUM_SEGMENTS   = 16;       // 16 × 4KB = 64KB logical space
const MMR_EXTENDED_RAM   = 0x70000;  // 448KB extended RAM (AV40: pages $40-$6F)

// FDC I/O ($FD18-$FD1F)
const FDC_IO_BASE        = 0xFD18;
const FDC_IO_END         = 0xFD1F;

// Timer IRQ period (microseconds)
const TIMER_PERIOD_US    = 2034;


// =============================================================================
// FM7 Main System Class
// =============================================================================

// Machine types
export const MACHINE_FM7        = 'fm7';
export const MACHINE_FM77AV     = 'fm77av';
export const MACHINE_FM77AV40   = 'fm77av40';
export const MACHINE_FM77AV40EX = 'fm77av40ex';

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
        this.fddSound  = new FddSound();

        // Wire FDC sound callbacks. The FddSound instance lazily binds to
        // whatever AudioContext PSG has created — if audio hasn't started yet,
        // the callbacks become no-ops and the synthesiser starts producing
        // sound once PSG's context is available.
        this.fdc.onSeekSound = (steps) => {
            this.fddSound.seek(steps, this.isFM77AV);
        };
        this.fdc.onHeadLoadSound = () => {
            this.fddSound.headLoad(this.isFM77AV);
        };
        this.fdc.onDiskInsert = () => {
            this.fddSound.diskInsert(this.isFM77AV);
        };
        this.fdc.onDiskEject = () => {
            this.fddSound.diskEject(this.isFM77AV);
        };

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
        this.extsubROM   = new Uint8Array(0xC000);    // EXTSUB.ROM (48KB, AV40EX Type-D/E banks)
        this._extsubROMSize = 0;

        // --- AV40 Type-D/E sub RAM ---
        this.subRAM_DE   = new Uint8Array(0x2000);    // $E000-$FFFF writable RAM (8KB)
        this.subRAM_CG   = new Uint8Array(0x4000);    // $D800-$DFFF CG RAM (2KB x 8 banks)
        this.subRAM_CN   = new Uint8Array(0x2000);    // $C000-$CFFF Console RAM (4KB x 2 banks)
        this._cgramBank    = 0;                        // CG RAM bank selector (0-7, $D42E bits 0-2)
        this._consramBank  = 0;                        // Console RAM bank (0-2, $D42E bits 3-4)

        // --- Dictionary card / EXTSUB.ROM access ---
        this._dicromBank  = 0;       // $FD2E bits 0-5: dictionary ROM bank (0-63)
        this._dicromEn    = false;   // $FD2E bit 6: dictionary ROM enable
        this._dicramEn    = false;   // $FD2E bit 7: learning RAM enable
        this._extromSel   = false;   // $FD95 bit 7: extended ROM select (EXTSUB.ROM, AV40EX only)
        this.dicromROM    = new Uint8Array(0x40000);   // DICROM.ROM (256KB, 64 banks x 4KB)
        this.dicromROM.fill(0xFF);
        this.dicramRAM    = new Uint8Array(0x2000);    // Learning RAM (8KB, $28000-$29FFF)

        // --- Kanji ROM (128KB level 1 + 128KB level 2) ---
        this.kanjiROM   = new Uint8Array(0x20000);    // 128KB level 1, via $FD22/$FD23
        this.kanjiROM.fill(0xFF);
        this.kanjiROM2  = new Uint8Array(0x20000);    // 128KB level 2, via $FD2E/$FD2F (read)
        this.kanjiROM2.fill(0xFF);
        this._kanjiAddr = 0;                           // 16-bit kanji ROM address register (shared L1/L2)
        this._subKanjiBank = false;                    // $D42E bit 7: sub kanji level (false=L1, true=L2)
        this._subKanjiFlag = false;                    // $FD04 bit 5: kanji ROM connected to sub (AV40+)

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
            kanji: false,
            kanji2: false,
            dicrom: false,
            extsub: false,
        };

        // --- I/O state ---
        this._subHalted   = true;   // Sub CPU starts halted after reset
        this._subHaltRequest = false; // Deferred HALT request (applied after sub CPU instruction)
        this._subCancelRequest = false; // Deferred CANCEL request
        this._subBusy     = true;   // Sub CPU BUSY flag (set on reset, cleared by sub CPU reading $D40A)
        this._subBusyWasCleared = false; // One-shot: sub CPU cleared BUSY via $D40A read
        this._subCancel   = false;  // Sub CPU CANCEL flag
        this._subAttn     = false;  // Sub CPU attention flag (FIRQ to main CPU)
        this._breakKey    = false;  // BREAK key state (directly read via $FD04 bit1)
        this._breakKeyCodes = ['Backquote', 'Pause']; // Configurable break key assignments
        this._bootMode    = 'dos';  // 'dos' or 'basic' (current active mode)
        this._bootModeOverride = 'auto'; // 'auto' | 'dos' | 'basic' — UI override
        this._basicRomEnabled = true; // BASIC ROM overlay at $8000-$FBFF

        // --- FM77AV specific state ---
        this._initiateROMSize = 0;       // Actual size of loaded Initiator ROM
        this._subROM_ASize    = 0;       // Actual size of loaded Type-A ROM
        this._subROM_BSize    = 0;       // Actual size of loaded Type-B ROM
        this._initiatorActive = false;   // Initiator ROM mapped at $FE00-$FFFF
        this._initiatorHandoffDone = false; // Sub-monitor switch + log only on first disable
        this._fd10Reg         = 0;       // FM77AV extended sub CPU mode register ($FD10)
        this._subMonitorType  = SUB_MONITOR_C; // Sub monitor: C=0, A=1, B=2
        this._cgRomBank       = 0;       // CG ROM bank (0-3, bits 0-1 of $D430)
        this._nmiMaskSub      = false;   // NMI mask for sub CPU (bit 7 of $D430)
        this._subResetFlag    = false;   // Sub CPU reset flag (read via $D430 bit 0)
        this._subResetDeferred = false;  // $FD13 reset deferred while sub CPU is halted
        this._vsyncFlag       = true;    // TRUE=active display, FALSE=vertical blanking
        this._blankFlag       = false;   // TRUE=horizontal blanking active
        this._vblankCycles    = 0;       // Cycle counter for VBlank period
        this._subNmiDelay     = 0;       // Cycles to delay NMI after sub CPU reset (INTR_SLOAD emulation)
        // FM77AV key encoder MCU at sub $D431/$D432 (see _keyEncProcessByte)
        this._rtcRxBuf = [];      // Sub-side response buffer (read via $D431)
        this._rtcAck = false;     // ACK flag (cleared on $D432 read)
        this._keyEncSendBuf = []; // MCU command FIFO (write via $D431)
        this._keyEncFormat = 0;   // 0=9BIT FM-7 ASCII, 1=FM16β, 2=SCAN

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
        this._twrFlag      = false;        // $FD93 bit 6: TWR (Text Window RAM) enable
        this._twrReg       = 0;            // $FD92: TWR offset register
        this._mmrRegs      = new Uint8Array(128); // 8 banks × 16 segments
        this._mmrExt       = false;            // $FD94 bit 7: extended MMR (8 banks; off = 4 banks)
        this._extRAM       = new Uint8Array(MMR_EXTENDED_RAM); // 192KB extended RAM
        // DMAC stub ($FD98-$FD99)
        this._dmacReg      = 0;               // DMAC register address
        this._dmacRegs     = new Uint8Array(32); // DMAC internal registers
        // RD512 stub ($FD40-$FD4F) — sector register for ext RAM window
        this._rd512Sector  = 0;               // 16-bit sector address

        // --- OPN (YM2203) / FM Sound Card ---
        this._fmCardEnabled = false; // FM sound card: off by default for FM-7
        this._opnAddrLatch = 0;      // selreg (latched register number)
        this._opnDataBus   = 0;      // seldat (data bus latch)
        this._opnPState    = 0;      // command pstate: 0=INACTIVE 1=READDAT 2=WRITEDAT 3=ADDRESS 4=READSTAT 9=JOYSTICK
        this._opnRegs      = new Uint8Array(256);
        this._opnRegs[0x0E] = 0xFF;     // Port A: all released (active low)
        this._opnRegs[0x0F] = 0xFF;     // Port B: no joystick selected
        this._gamepadState = new Uint8Array(2);
        this._gamepadState[0] = 0xFF;   // All buttons released (active low)
        this._gamepadState[1] = 0xFF;
        // Per FM-7 port → browser gamepad index (navigator.getGamepads()[idx]).
        // null = unassigned (No device). [port1, port2]
        this._joystickAssign = [null, null];

        // --- PTM (MC6840 Programmable Timer Module) at $FDE0-$FDE7 ---
        // FM77AV: used for periodic timer IRQ and mouse timing.
        // Routes IRQ to main CPU via $FD17 bit 2.
        // Reference: Motorola MC6840 datasheet, FM77AV Technical Manual.
        // Register map (addr = addr - 0xFDE0):
        //   0 W: CR1 if CR2[0]=1 else CR3;  R: no-op ($FF)
        //   1 W: CR2;                       R: status register
        //   2 W: MSB write buffer (shared); R: T1 counter MSB (latches LSB to buffer)
        //   3 W: T1 LSB (loads latch = {msbBuf, val}, resets T1); R: T1 LSB buffered
        //   4/5: T2 same pattern
        //   6/7: T3 same pattern
        this._ptmCR      = new Uint8Array(3);  // CR1, CR2, CR3
        this._ptmLatch   = new Uint16Array(3); // T1-T3 reload latches
        this._ptmCounter = new Uint16Array(3); // T1-T3 current counter
        this._ptmLsbBuf  = new Uint8Array(3);  // T1-T3 LSB read buffer (captured at MSB read)
        this._ptmMsbWBuf = 0;                  // Shared MSB write buffer
        this._ptmStatus  = 0;                  // bit0-2: timer IRQ flags; bit7 = any IRQ & enabled
        this._ptmCycleAcc = 0;                 // Fractional cycle accumulator (PTM clock = 1MHz ≈ main/2)

        // IRQ / FIRQ flags for main CPU
        this._timerIRQ    = false;  // Timer IRQ pending (cleared by reading $FD03)
        this._opnIrqLatch = false;  // OPN timer IRQ latch (edge-triggered, cleared by $FD03 read)
        this._opnIrqPrev  = false;  // Previous OPN IRQ state for edge detection
        this._fdcIrqLatch = false;  // FDC IRQ latch (edge-triggered, cleared by reading $FD18)
        this._fdcIrqPrev  = false;  // Previous FDC IRQ state for edge detection
        this._fdcDrqPrev  = false;
        this._irqMaskReg  = 0;      // $FD02 keyboard IRQ mask (bit 0)

        // Emulation loop state
        this._running     = false;
        this._animFrameId = null;
        this._canvas      = null;
        this._fpsCounter  = 0;
        this._fpsTime     = 0;
        this._currentFPS  = 0;
        this._lastFrameTime = 0;

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
        // The upper 512 bytes of the 8KB ROM ($1E00-$1FFF) are also mirrored
        // at $FE00-$FFFF so the reset vector resolves to the initiator entry.
        if (this.isFM77AV && this._initiatorActive && this.romLoaded.initiate) {
            if (addr >= 0x6000 && addr < 0x8000) {
                return this.initiateROM[addr - 0x6000];
            }
            if (addr >= 0xFE00 && addr <= 0xFFFF) {
                return this.initiateROM[(addr - 0xFE00) + 0x1E00];
            }
        }

        // FM77AV TWR: $7C00-$7FFF window — priority over MMR
        if (this._twrFlag && addr >= 0x7C00 && addr <= 0x7FFF) {
            return this._twrRead(addr);
        }

        // FM77AV MMR: remap through segment table
        // MMR applies to $0000-$FBFF only; $FC00+ (RAM/shared/I/O) bypasses MMR
        if (this._mmrEnabled && addr < 0xFC00) {
            const seg = addr >> 12;  // 4KB segment number (0-15)
            const bankIdx = this._mmrExt ? this._mmrBankReg : (this._mmrBankReg & 3);
            const bankOff = bankIdx * MMR_NUM_SEGMENTS;
            const rawPage = this._mmrRegs[bankOff + seg];
            const physPage = this._mmrExt ? rawPage : (rawPage & 0x3F);
            // FM77AV MMR physical page mapping:
            //   Pages 0x00-0x0F: extended RAM bank 0 (64KB)
            //   Pages 0x10-0x1F: sub CPU address space (VRAM/IO/ROM) — accessible only when sub CPU halted
            //   Pages 0x20-0x2F: extended RAM bank 2 (64KB)
            //   Pages 0x30-0x3F: main RAM (same physical memory as CPU direct access)
            if ((physPage & 0x30) === 0x30) {
                const mainPage = physPage & 0x0F;
                if (mainPage !== seg) {
                    return this.mainRAM[(mainPage << 12) | (addr & 0x0FFF)];
                }
                // Identity mapping: fall through to normal map
            } else if ((physPage & 0xF0) === 0x10) {
                // Pages $10-$1F: sub CPU address space
                // Only accessible when sub CPU is halted (returns 0xFF otherwise)
                if (this._subHalted) {
                    const subAddr = ((physPage & 0x0F) << 12) | (addr & 0x0FFF);
                    const v = this._subRead(subAddr);
                    if (this._dbgTraceMMR && subAddr >= 0xD400) {
                        const pc = this.mainCPU.pc || 0;
                        console.log(`[MMR-R] sub $${subAddr.toString(16).padStart(4,'0')}=$${v.toString(16).padStart(2,'0')} page=$${physPage.toString(16)} PC=$${pc.toString(16).padStart(4,'0')}`);
                    }
                    return v;
                }
                return 0xFF;
            } else if ((physPage & 0xF0) === 0x20) {
                // Pages $20-$2F: dictionary card space (日本語カード)
                const offset = addr & 0x0FFF;

                // $28000-$29FFF: Learning RAM (8KB, enabled by $FD2E bit 7)
                if ((physPage === 0x28 || physPage === 0x29) && this._dicramEn) {
                    const ramOff = ((physPage & 0x01) << 12) | offset;
                    return this.dicramRAM[ramOff];
                }

                // $2E000-$2EFFF: Dictionary ROM / EXTSUB.ROM window
                if ((physPage & 0x0F) === 0x0E && this._dicromEn) {
                    const bankAddr = this._dicromBank << 12;
                    if (this._extromSel) {
                        if (this._dicromBank >= 32) {
                            // EXTSUB.ROM: banks 32+ → extsubROM offset
                            const extOff = (bankAddr - 0x20000) | offset;
                            if (extOff < this._extsubROMSize) {
                                return this.extsubROM[extOff];
                            }
                        }
                        // extrom_sel + bank 0-31: KANJIN.ROM (not implemented, fall through)
                        return 0xFF;
                    }
                    // DICROM.ROM: bank 0-63
                    return this.dicromROM[(bankAddr | offset) & 0x3FFFF];
                }
                // Other $2x pages: extended RAM bank B (if exists)
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < this._extRAM.length) {
                    return this._extRAM[physAddr];
                }
                return 0xFF;
            } else {
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < this._extRAM.length) {
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

        // $8000-$FBFF: BASIC ROM (if enabled) or RAM
        if (addr >= 0x8000 && addr < 0xFC00) {
            if (this._basicRomEnabled) {
                if (this.romLoaded.fbasic) {
                    return this.fbasicROM[addr - 0x8000];
                }
                // ROM enabled but not loaded - warn once
                if (!this._fbasicWarnShown) {
                    this._fbasicWarnShown = true;
                    console.error(`[ROM MISSING] BASIC ROM read at $${addr.toString(16).toUpperCase()} but not loaded! PC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
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

        // $FE00-$FFFF: Boot ROM area
        // With boot ROM bypass, this area is plain RAM (vectors written by reset()).
        // Initiator ROM overlay is no longer active (bypassed in reset).
        if (addr >= BOOT_ROM_BASE) {
            // $FFE0-$FFFF: Interrupt vectors in RAM
            if (addr >= 0xFFE0) {
                return this.mainRAM[addr];
            }
            // $FE00-$FFDF: After bypass, this is RAM.
            // FM77AV: Initiator ROM is bypassed, _initiatorActive stays false.
            // FM-7: Boot ROM code is bypassed.
            if (this.isFM77AV) {
                return this.mainRAM[addr];
            }
            // FM-7: boot ROM if loaded, otherwise RAM
            if (this.romLoaded.boot) {
                return this.bootROM[addr - BOOT_ROM_BASE];
            }
            return this.mainRAM[addr];
        }

        return 0xFF;
    }

    // =========================================================================
    // Main CPU Memory Write ($0000-$FFFF)
    // =========================================================================

    _mainWrite(addr, val) {
        addr &= 0xFFFF;
        val &= 0xFF;

        // Debug: RAM write watchpoint
        if (this._watchAddr && addr >= this._watchAddr && addr < this._watchAddr + this._watchLen) {
            const pc = this.mainCPU.pc || 0;
            console.log(`[WATCH] W $${addr.toString(16)}=$${val.toString(16)} PC=$${pc.toString(16)}`);
        }

        // FM77AV TWR: $7C00-$7FFF window — priority over MMR
        if (this._twrFlag && addr >= 0x7C00 && addr <= 0x7FFF) {
            this._twrWrite(addr, val);
            return;
        }

        // FM77AV MMR: remap writes through segment table
        // MMR applies to $0000-$FBFF only; $FC00+ (RAM/shared/I/O) bypasses MMR
        if (this._mmrEnabled && addr < 0xFC00) {
            const seg = addr >> 12;
            const bankIdx = this._mmrExt ? this._mmrBankReg : (this._mmrBankReg & 3);
            const bankOff = bankIdx * MMR_NUM_SEGMENTS;
            const rawPage = this._mmrRegs[bankOff + seg];
            const physPage = this._mmrExt ? rawPage : (rawPage & 0x3F);
            // Pages 0x30-0x3F: main RAM
            if ((physPage & 0x30) === 0x30) {
                const mainPage = physPage & 0x0F;
                if (mainPage !== seg) {
                    this.mainRAM[(mainPage << 12) | (addr & 0x0FFF)] = val;
                    return;
                }
                // Identity: fall through to normal write path
            } else if ((physPage & 0xF0) === 0x10) {
                // Pages $10-$1F: sub CPU address space
                // Only accessible when sub CPU is halted (writes ignored otherwise)
                if (this._subHalted) {
                    const subAddr = ((physPage & 0x0F) << 12) | (addr & 0x0FFF);
                    if (this._dbgTraceMMR) {
                        const pc = this.mainCPU.pc || 0;
                        if (subAddr >= 0xD400) {
                            // I/O and ROM/RAM area — always log
                            console.log(`[MMR-W] sub $${subAddr.toString(16).padStart(4,'0')}=$${val.toString(16).padStart(2,'0')} page=$${physPage.toString(16)} PC=$${pc.toString(16).padStart(4,'0')}`);
                        } else {
                            // VRAM/work RAM — count only
                            this._dbgMmrWCount = (this._dbgMmrWCount || 0) + 1;
                            if (this._dbgMmrWCount <= 4 || (this._dbgMmrWCount & 0xFFF) === 0) {
                                console.log(`[MMR-W] sub $${subAddr.toString(16).padStart(4,'0')}=$${val.toString(16).padStart(2,'0')} (count=${this._dbgMmrWCount}) PC=$${pc.toString(16).padStart(4,'0')}`);
                            }
                        }
                    }
                    this._subWrite(subAddr, val, true);
                }
                return;
            } else if ((physPage & 0xF0) === 0x20) {
                // Pages $20-$2F: dictionary card space
                // $28000-$29FFF: Learning RAM write
                if ((physPage === 0x28 || physPage === 0x29) && this._dicramEn) {
                    const ramOff = ((physPage & 0x01) << 12) | (addr & 0x0FFF);
                    this.dicramRAM[ramOff] = val;
                    return;
                }
                // Other $2x pages: extended RAM
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < this._extRAM.length) {
                    this._extRAM[physAddr] = val;
                }
                return;
            } else {
                // Pages 0x00-0x0F: extended RAM
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < this._extRAM.length) {
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
            // bit 3: extended interrupt (OPN timer A/B overflow).
            // Reference ($FD03 read) only reports the flag; it does NOT
            // clear the OPN IRQ source. The IRQ is acknowledged by writing
            // OPN register $27 with reset bits ($10/$20), which clears the
            // OPN status — our auto-clear path then drops the latch.
            if (this._opnIrqLatch) status &= ~0x08;
            return status;
        }

        // $FD17: Extended IRQ status (active low, FM77AV)
        // bit 3 (0x08): OPN timer A or B IRQ pending
        // bit 2 (0x04): PTM (mouse) IRQ pending
        if (addr === 0xFD17) {
            let val = 0xFF;
            if (this._opnIrqLatch) val &= ~0x08;
            // PTM IRQ source: active low when any enabled timer has pending IRQ
            if (this._ptmStatus & 0x80) val &= ~0x04;
            return val;
        }

        // $FD04: Sub CPU status (BUSY, attention, break key)
        if (addr === FD04_IRQ_MASK) {
            // When sub CPU is halted, report BUSY=false regardless of
            // the _subBusy latch.  The sub CPU is stopped and not
            // processing — the main CPU should be free to write shared
            // RAM.  _subHaltAck sets _subBusy=true on HALT for
            // compatibility (some code may briefly read $FD04 right
            // after writing $FD05 HALT in the same instruction flow),
            // but the authoritative answer when halted is "not busy".
            const busy = this._subHalted ? false : this._subBusy;
            let ret = busy ? 0xFF : 0x7F;  // bit 7 = BUSY only
            if (this._subAttn) {
                ret &= ~0x01;  // bit 0 = attention (active low)
                this._subAttn = false;  // Clear attention on read
            }
            // bit 1 = break key (active low: 0=pressed, 1=not pressed)
            if (this._breakKey) ret &= ~0x02;
            return ret;
        }

        // Sub CPU status ($FD05 read)
        // bit 7 = BUSY. bit 0 = EXTDET.
        // On real hardware both CPUs run in parallel, so the sub CPU's
        // $D40A read (BUSY clear) is immediately visible to the main CPU.
        // In our interleaved scheduler, the sub CPU clears BUSY during
        // catch-up which happens AFTER the main CPU's instruction.
        // This can cause the main CPU to permanently miss BUSY=0 windows
        // when an IRQ handler rapidly re-asserts HALT (re-setting BUSY).
        // Compensate: if the sub CPU cleared BUSY via $D40A read but a
        // subsequent HALT re-set it before the main CPU could observe it,
        // report BUSY=0 once. The one-shot flag is consumed on read.
        if (addr === FD05_SUB_CTRL) {
            // Returns $FF (busy) / $7F (not busy) on FM77AV (bit 0=1,
            // no EXTDET). On FM-7 with FDC, bit 0 is cleared → $FE/$7E.
            // However, bit 0=1 on FM77AV causes INITIATE ROM NEW BOOT to
            // take the BASIC ROM BIOS path ($5082) which requires complete
            // BIOS vector setup. Until that path is fully supported, keep
            // bit 0=0 for all models (matches FM-7 EXTDET=detected).
            if (this._subBusy && !this._subHalted && this._subBusyWasCleared) {
                this._subBusyWasCleared = false;
                return 0x7E; // BUSY=false (sub CPU recently cleared it)
            }
            this._subBusyWasCleared = false;
            return this._subBusy ? 0xFE : 0x7E;
        }

        // $FD0B: Boot status register (FM77AV+)
        // bit 0: 0=BASIC boot, 1=DOS boot
        // Returns $FE (BASIC) or $FF (DOS)
        if (addr === 0xFD0B) {
            if (this.isFM77AV) {
                return (this._bootMode === 'basic') ? 0xFE : 0xFF;
            }
            return 0xFF;
        }

        // $FD0F: Reading enables BASIC ROM overlay at $8000-$FBFF
        if (addr === FD0F_ROM_SELECT) {
            if (this._loadTraceEnabled && !this._basicRomEnabled) {
                this._loadTrace.push({ t: 'ROM_ON', pc: this.mainCPU.pc });
            }
            this._basicRomEnabled = true;
            return 0xFF;
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
                case 0xFD32: return entry & 0x0F;          // Blue (bits 0-3)
                case 0xFD33: return (entry >> 4) & 0x0F;  // Red  (bits 4-7)
                case 0xFD34: return (entry >> 8) & 0x0F;  // Green (bits 8-11)
            }
        }

        // FDC registers ($FD18-$FD1F)
        if (addr >= FDC_IO_BASE && addr <= FDC_IO_END) {
            // Reading $FD18 (status) clears the FDC IRQ latch
            if (addr === FDC_IO_BASE) this._fdcIrqLatch = false;
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

        // $FD0D / $FD0E:
        //   FM-7  : standalone PSG (separate AY-3-8910 chip).
        //   FM77AV: mirror of OPN $FD15/$FD16.
        if (addr === 0xFD0D) {
            return this.isFM77AV ? 0xFF : this.psg.readCmd();
        }
        if (addr === 0xFD0E) {
            return this.isFM77AV ? this._opnReadData() : this.psg.readData();
        }

        // $FD15: OPN command register — write-only (BDIR/BC1/status-read mode).
        // Reads return open bus ($FF); OPN status is surfaced on $FD16 data bus
        // via bit2 "status read" mode.
        if (addr === 0xFD15) {
            return 0xFF;
        }

        // $FD16: OPN data bus read — dispatch on pstate
        if (addr === 0xFD16) {
            if (!this._fmCardEnabled) return 0xFF;
            return this._opnReadData();
        }

        // $FD06/$FD07: RS-232C USART (not installed: return open bus)
        if (addr === 0xFD06 || addr === 0xFD07) return 0xFF;

        // $FD20/$FD21: Kanji ROM address register (write-only, read returns 0xFF)
        // $FD22/$FD23: Kanji ROM data (level 1)
        // $FD2C/$FD2D: Kanji ROM address (aliases $FD20/$FD21, AV40EX/jcard)
        // $FD2E/$FD2F: Kanji ROM data (level 2, AV40EX/jcard)
        if (addr === 0xFD22 || addr === 0xFD23) {
            // When kanji ROM is connected to sub CPU, main reads return 0xFF
            if (this._subKanjiFlag) return 0xFF;
            const offset = (this._kanjiAddr << 1) + (addr & 1);
            return this.kanjiROM[offset & 0x1FFFF];
        }
        if ((addr === 0xFD2E || addr === 0xFD2F) && this.isAV40EX) {
            if (this._subKanjiFlag) return 0xFF;
            const offset = (this._kanjiAddr << 1) + (addr & 1);
            return this.kanjiROM2[offset & 0x1FFFF];
        }
        if (addr >= 0xFD20 && addr <= 0xFD2F) return 0xFF;

        // $FD08-$FD0C: Printer/timer I/O (stub)
        if (addr >= 0xFD08 && addr <= 0xFD0C) return 0xFF;

        // $FD11: Extended sub interface (stub)
        if (addr === 0xFD11) return 0xFF;

        // $FD13: Sub ROM bank read (write-only register, return last written value)
        if (addr === FD13_SUB_BANK && this.isFM77AV) {
            return this._subMonitorType >= 4 ? 0x04 : (this._subMonitorType & 0x03);
        }

        // $FD14: Extended register (stub)
        if (addr === 0xFD14) return 0xFF;

        // $FDFD-$FDFF: Boot mode / extended registers (stub)
        if (addr >= 0xFDFD) return 0xFF;

        // PTM (MC6840) $FDE0-$FDE7
        if (addr >= 0xFDE0 && addr <= 0xFDE7) {
            return this._ptmRead(addr - 0xFDE0);
        }

        // FM77AV40: RD512 registers ($FD40-$FD4F)
        // $FD40-$FD41: sector register (write-only), $FD48-$FD4F: data window
        if (this.isAV40 && addr >= 0xFD40 && addr <= 0xFD4F) {
            return 0xFF; // No ext RAM installed
        }

        // FM77AV40: CRTC MB89321 ($FD96-$FD97) — NOP on AV40
        if (this.isAV40 && (addr === 0xFD96 || addr === 0xFD97)) {
            return 0xFF;
        }

        // FM77AV40: DMAC ($FD98-$FD99) — read returns $FF
        // (software probes this range to detect AV40; returning
        //  actual DMAC state would cause AV software to misdetect)
        if (this.isAV40 && (addr === 0xFD98 || addr === 0xFD99)) return 0xFF;

        // FM77AV: MMR/TWR registers ($FD80-$FD9F)
        // $FD80-$FD8F: Segment registers for current bank (selected by $FD90)
        // $FD90: Bank select, $FD92: TWR offset (write-only), $FD93: MMR/TWR control
        // $FD94: Extended MMR/CPU speed, $FD95: Mode select 2
        if (this.isFM77AV && addr >= 0xFD80 && addr <= 0xFD9F) {
            if (addr === FD93_MMR_CTRL) {
                // Returns $FF with bit7 cleared if !mmr, bit6 cleared if !twr, bit0 cleared if !bootramRW
                return 0xFF & (this._mmrEnabled ? 0xFF : ~0x80) & (this._twrFlag ? 0xFF : ~0x40) & (this._bootramRW ? 0xFF : ~0x01);
            }
            if (addr === 0xFD90) {
                return this._mmrBankReg;
            }
            if (addr <= 0xFD8F) {
                // $FD80-$FD8F: read segment registers for bank selected by $FD90
                const bankIdx = this._mmrExt ? this._mmrBankReg : (this._mmrBankReg & 3);
                return this._mmrRegs[bankIdx * MMR_NUM_SEGMENTS + (addr - 0xFD80)];
            }
            // $FD92: TWR offset register (write-only, returns $FF on read)
            if (addr === FD92_TWR_OFFSET) {
                return 0xFF;
            }
            // $FD94: Extended MMR/CPU speed — read returns $FF
            // $FD95: Mode select 2 — read returns $FF on AV40 (non-EX)
            // $FD9A-$FD9F: extended RAM probe / MR2 — no hardware = $FF
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
        // Bit 0: key IRQ enable (1=enable), Bit 2: timer IRQ enable (1=enable)
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
        // Like real hardware, HALT/RUN is a REQUEST that takes
        // effect after the sub CPU completes its current instruction.
        // _subHaltAck() applies the request at the instruction boundary.
        if (addr === FD05_SUB_CTRL) {
            this._subHaltRequest = (val & 0x80) !== 0;
            if (val & 0x40) {
                // Cancel IRQ request: deferred to instruction boundary via _subHaltAck().
                // _subHaltAck() sets _subCancel = true but does NOT assert IRQ.
                this._subCancelRequest = true;
            }
            // Level-triggered Cancel IRQ: assert/deassert based on _subCancel flag.
            // _subCancel is promoted from _subCancelRequest by _subHaltAck(),
            // so Cancel written NOW takes effect on the NEXT $FD05 write (RUN command).
            if (this._subCancel) {
                this.subCPU.intr |= 0x04; // INTR_IRQ
            } else {
                this.subCPU.intr &= ~0x04;
            }
            return;
        }

        // $FD0F: Writing disables BASIC ROM overlay
        if (addr === FD0F_ROM_SELECT) {
            if (this._loadTraceEnabled && this._basicRomEnabled) {
                this._loadTrace.push({ t: 'ROM_OFF', pc: this.mainCPU.pc });
            }
            this._basicRomEnabled = false;
            return;
        }

        // FM77AV40: $FD0B write - RS-232C clock/baud rate (stub)
        if (addr === 0xFD0B && this.isAV40) {
            this._fd0bReg = val & 0xFF;
            return;
        }

        // FM77AV40: $FD0C write - RS-232C extended DTR (stub)
        if (addr === 0xFD0C && this.isAV40) {
            this._fd0cReg = val & 0xFF;
            return;
        }

        // FM77AV: $FD10 write - Mode control / Initiator ROM overlay toggle
        // bit 1 controls the Initiator ROM overlay:
        //   bit 1 = 0: Initiator ROM overlay active at $6000-$7FFF / $FE00-$FFFF
        //   bit 1 = 1: Initiator disabled, underlying RAM/ROM visible
        // The overlay can be toggled both ways (Disk BASIC machine detection
        // temporarily re-enables it to probe the reset vector).
        if (addr === 0xFD10 && this.isFM77AV) {
            this._fd10Reg = val;
            const wantDisable = (val & 0x02) !== 0;
            if (this._initiatorActive && wantDisable) {
                this._initiatorActive = false;
                // Handoff side effects (sub monitor Type-C switch for BASIC
                // boot) happen only the first time the initiator is disabled.
                if (!this._initiatorHandoffDone) {
                    this._initiatorHandoffDone = true;
                    if (this._bootMode === 'basic') {
                        this._mainIOWrite(FD13_SUB_BANK, SUB_MONITOR_C);
                        this.keyboard._enableBreakCodes = false;
                        this.keyboard._useScanCodes = false;
                    }
                    console.log('FM77AV: Initiator overlay handoff complete');
                }
            } else if (!this._initiatorActive && !wantDisable && this.romLoaded.initiate) {
                this._initiatorActive = true;
            }
            return;
        }

        // FM77AV: $FD12 write - 320/640 mode select
        // bit 6: 1=320x200 mode, 0=640x200 mode
        if (addr === FD12_SUB_MONITOR && this.isFM77AV) {
            const mode320 = (val & 0x40) !== 0;
            this.display._mode320Flag = mode320;
            // Don't override 262K / 400-line mode — $D404 controls those
            if (this.display.displayMode !== 2 && this.display.displayMode !== 3) {
                this.display._setDisplayMode(mode320 ? 1 : 0);
            }
            return;
        }

        // FM77AV: $FD13 write - Sub ROM bank switch + Sub CPU reset
        // bit 1-0: subrom_bank (0=Type-C, 1=Type-A, 2=Type-B)
        // AV40/AV40EX: bit 2: Type-D/E (sub RAM mode, bits 1-0 ignored)
        // Writing triggers sub CPU reset
        if (addr === FD13_SUB_BANK && this.isFM77AV) {
            let bank = val & 0x03;
            if (this.isAV40 && (val & 0x04)) {
                bank = 4; // Type-D/E: RAM mode, bits 1-0 ignored
            }
            const oldType = this._subMonitorType;
            this._subMonitorType = bank;
            this._subBusy = true;
            this._subBusyWasCleared = false;
            this._subResetFlag = true;

            // Deferred reset pattern:
            // If sub CPU is halted ($FD05 bit7=1), defer the actual reset
            // until HALT is released.  The HALT line is NOT cleared by
            // $FD13 — it persists until $FD05 bit7=0.  Games that HALT
            // the sub CPU, switch sub ROM banks, then write VRAM via MMR
            // expect the HALT to hold throughout.
            if (this._subHalted) {
                // Defer reset: update bank, reset display state, but do
                // NOT reset sub CPU or clear halt.
                this._subResetDeferred = true;
                this._applyFD13DisplayReset();
                if (oldType !== bank) {
                    console.log('FM77AV: Sub ROM bank → Type-' +
                        (['C', 'A', 'B', 'CG', 'D/E(RAM)'][bank] || bank) + ' (deferred, sub halted)');
                }
                return;
            }

            // Sub CPU is running — immediate reset
            this._subResetDeferred = false;
            this._applyFD13DisplayReset();

            this.subCPU.reset();
            this.scheduler.setSubHalted(false);
            if (oldType !== bank) {
                console.log('FM77AV: Sub ROM bank → Type-' +
                    (['C', 'A', 'B', 'CG', 'D/E(RAM)'][bank] || bank) + ', sub CPU reset');
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
            // Analog palette internal storage format:
            //   bits 0-3:  B level
            //   bits 4-7:  R level
            //   bits 8-11: G level
            // The renderer's pixel index is built with the same layout
            // (G in high bits, R in middle, B in low bits) so that pixel
            // sub-plane bits map directly into palette lookup keys.
            if (addr === FD32_APAL_BLUE) {
                // Blue data for current palette entry → bits 0-3
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0xFF0) | (val & 0x0F);
                this.display._pushScrollTrace('PAL_B', { idx, val: val & 0x0F });
                return;
            }
            if (addr === FD33_APAL_RED) {
                // Red data for current palette entry → bits 4-7
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0xF0F) | ((val & 0x0F) << 4);
                this.display._pushScrollTrace('PAL_R', { idx, val: val & 0x0F });
                return;
            }
            // $FD34: Green data for current palette entry → bits 8-11
            if (addr === 0xFD34) {
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0x0FF) | ((val & 0x0F) << 8);
                this.display._pushScrollTrace('PAL_G', { idx, val: val & 0x0F });
                return;
            }
        }

        // $FD37: Multi-page register (main CPU side access)
        // Controls which color planes are visible (bit=1 → plane disabled)
        if (addr === 0xFD37) {
            if (this.display.multiPage !== val) {
                this.display.multiPage = val;
                this.display._fullDirty = true;
                this.display._pushScrollTrace('FD37', { val });
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

        // $FD0D / $FD0E:
        //   FM-7  : standalone built-in PSG (AY-3-8910), separate from OPN.
        //   FM77AV: physical mirror of OPN command/data ($FD15/$FD16).
        //           Real hardware has no separate PSG chip — the YM2203 SSG
        //           section answers both address pairs.
        if (addr === 0xFD0D) {
            if (this.isFM77AV) {
                this._opnWriteCmd(val);
            } else {
                this.psg.writeCmd(val);
            }
            return;
        }
        if (addr === 0xFD0E) {
            if (this.isFM77AV) {
                this._opnWriteData(val);
            } else {
                this.psg.writeData(val);
            }
            return;
        }

        // $FD15: OPN command register — 4-bit enum decode (FM card / FM77AV).
        if (addr === 0xFD15) {
            if (this._fmCardEnabled) this._opnWriteCmd(val);
            return;
        }

        // $FD16: OPN data bus write
        if (addr === 0xFD16) {
            if (this._fmCardEnabled) this._opnWriteData(val);
            return;
        }

        // $FD00: Keyboard port write (no-op, read-only register)
        if (addr === 0xFD00) return;

        // $FD04: Main CPU side — AV40 display mode control
        // bit 2: sub-RAM write protect (0=protect, 1=unprotect)
        // bit 3: 400-line mode (0=enable, 1=disable)
        // bit 4: 262,144-color mode (1=enable, only when bit3=1)
        if (addr === 0xFD04) {
            if (this.isAV40) {
                this._subramProtect = !(val & 0x04);
                this._subKanjiFlag = !(val & 0x20); // bit 5: kanji ROM → sub (0=connect)
                const mode400l = !(val & 0x08);
                const mode256k = ((val & 0x10) !== 0) && !mode400l;

                let newMode;
                if (mode400l) {
                    newMode = 3; // DISPLAY_MODE_400
                } else if (mode256k) {
                    newMode = 2; // DISPLAY_MODE_262K
                } else if (this.display.displayMode === 2 || this.display.displayMode === 3) {
                    newMode = this.display._mode320Flag ? 1 : 0;
                } else {
                    newMode = this.display.displayMode;
                }
                if (newMode !== this.display.displayMode) {
                    this.display._setDisplayMode(newMode);
                }
            }
            return;
        }

        // $FD06/$FD07: RS-232C USART write (stub: no device)
        if (addr === 0xFD06 || addr === 0xFD07) return;

        // $FD20/$FD2C: Kanji ROM address high byte write (shared register)
        // $FD21/$FD2D: Kanji ROM address low byte write (shared register)
        // $FD22/$FD23: level 1 data (read-only), $FD2E/$FD2F: level 2 data (read-only)
        // $FD2E write: Dictionary card bank select (AV40EX built-in)
        if (addr === 0xFD20 || (addr === 0xFD2C && this.isAV40EX)) {
            this._kanjiAddr = (this._kanjiAddr & 0x00FF) | (val << 8);
            return;
        }
        if (addr === 0xFD21 || (addr === 0xFD2D && this.isAV40EX)) {
            this._kanjiAddr = (this._kanjiAddr & 0xFF00) | val;
            return;
        }
        if (addr === 0xFD2E && this.isAV40EX) {
            this._dicramEn = !!(val & 0x80);
            this._dicromEn = !!(val & 0x40);
            this._dicromBank = val & 0x3F;
            return;
        }
        if (addr >= 0xFD20 && addr <= 0xFD2F) return;

        // $FDFD-$FDFF: Boot mode / extended registers (stub)
        if (addr >= 0xFDFD) return;

        // PTM (MC6840) $FDE0-$FDE7
        if (addr >= 0xFDE0 && addr <= 0xFDE7) {
            this._ptmWrite(addr - 0xFDE0, val);
            return;
        }

        // FM77AV40: RD512 ($FD40-$FD4F) — ext RAM sector/data window
        if (this.isAV40 && addr >= 0xFD40 && addr <= 0xFD4F) {
            if (addr === 0xFD40) { this._rd512Sector = (this._rd512Sector & 0x00FF) | (val << 8); }
            else if (addr === 0xFD41) { this._rd512Sector = (this._rd512Sector & 0xFF00) | val; }
            // $FD48-$FD4F: data write (NOP — no ext RAM)
            return;
        }

        // FM77AV40: CRTC MB89321 ($FD96-$FD97) — NOP
        if (this.isAV40 && (addr === 0xFD96 || addr === 0xFD97)) return;

        // FM77AV40: DMAC ($FD98-$FD99)
        if (this.isAV40 && addr === 0xFD98) { this._dmacReg = val & 0x1F; return; }
        if (this.isAV40 && addr === 0xFD99) { this._dmacRegs[this._dmacReg] = val; return; }

        // FM77AV: MMR registers ($FD80-$FD9F)
        if (this.isFM77AV && addr >= 0xFD80 && addr <= 0xFD9F) {
            // $FD93: MMR/TWR control register
            // bit 7: MMR enable, bit 6: TWR enable
            if (addr === FD93_MMR_CTRL) {
                this._mmrEnabled = (val & 0x80) !== 0;
                this._twrFlag = (val & 0x40) !== 0;
                this._bootramRW = (val & 0x01) !== 0;
                return;
            }
            // $FD90: MMR bank select register (selects which bank for $FD80-$FD8F AND address translation)
            if (addr === 0xFD90) {
                this._mmrBankReg = val & 0x07;
                return;
            }
            if (addr <= 0xFD8F) {
                // $FD80-$FD8F: write to segment registers for bank selected by $FD90
                const bk = this._mmrExt ? this._mmrBankReg : (this._mmrBankReg & 3);
                this._mmrRegs[bk * MMR_NUM_SEGMENTS + (addr - 0xFD80)] = val;
                return;
            }
            // $FD92: TWR offset register write
            if (addr === FD92_TWR_OFFSET) {
                this._twrReg = val & 0xFF;
                return;
            }
            // $FD94: Extended MMR / CPU speed
            if (addr === 0xFD94) {
                this._mmrExt = (val & 0x80) !== 0;
                // bit2: refresh speed, bit0: window speed — no effect in emulator
                return;
            }
            // $FD95: Mode select 2 (AV40EX: bit7=extrom_sel)
            if (addr === 0xFD95) {
                if (this.isAV40EX) {
                    this._extromSel = !!(val & 0x80);
                    if (this._dbgTraceMMR) {
                        console.log(`[FD95] val=$${val.toString(16).padStart(2,'0')} extromSel=${this._extromSel}`);
                    }
                }
                return;
            }
            // $FD9A-$FD9F: extended RAM probe / MR2 — NOP (no hardware)
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
    // TWR (Text Window RAM) Address Translation
    // physAddr = (twr_reg * 256 + addr) & 0xFFFF
    // FM77AV: wbr_reg=0, result is always in $0xxxx (extended RAM bank 0)
    // =========================================================================

    _twrTranslate(addr) {
        return ((this._twrReg << 8) + addr) & 0xFFFF;
    }

    _twrRead(addr) {
        const physAddr = this._twrTranslate(addr);
        if (physAddr < this._extRAM.length) {
            return this._extRAM[physAddr];
        }
        return 0xFF;
    }

    _twrWrite(addr, val) {
        const physAddr = this._twrTranslate(addr);
        if (physAddr < this._extRAM.length) {
            this._extRAM[physAddr] = val;
        }
    }

    // =========================================================================
    // Sub CPU Memory Read ($0000-$FFFF)
    // =========================================================================

    _subRead(addr) {
        addr &= 0xFFFF;

        // AV40 Console RAM: $C000-$CFFF when Type-D/E + consram_bank >= 1
        if (addr >= 0xC000 && addr < 0xD000 &&
            this._subMonitorType >= 4 && this._consramBank >= 1) {
            return this.subRAM_CN[(this._consramBank - 1) * 0x1000 + (addr - 0xC000)];
        }

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

            // $D406/$D407: Sub-side kanji ROM read (AV40/AV40EX only)
            if ((ioAddr === 0xD406 || ioAddr === 0xD407) && this.isAV40) {
                if (!this._subKanjiFlag) return 0xFF; // not connected to sub
                const offset = (this._kanjiAddr << 1) + (ioAddr & 1);
                if (this._subKanjiBank) {
                    return this.kanjiROM2[offset & 0x1FFFF];
                }
                return this.kanjiROM[offset & 0x1FFFF];
            }

            // Display/control I/O ($D402-$D40F)
            const result = this.display.readIO(ioAddr);

            // Handle side effects that need fm7-level state
            if (result.sideEffect === 'cancelAck') {
                // $D402: Cancel IRQ ACK — clear both flag and request, deassert IRQ
                this._subCancel = false;
                this._subCancelRequest = false;
                // De-assert IRQ on sub CPU (subcpu_irq level-trigger)
                this.subCPU.intr &= ~0x04;  // INTR_IRQ = 0x04
            } else if (result.sideEffect === 'attention') {
                // $D404: Set attention flag, trigger main CPU FIRQ
                this._subAttn = true;
                this.mainCPU.firq();
            } else if (result.sideEffect === 'beep') {
                // $D403: Sub CPU BEEP trigger (single 205ms tone)
                this._beepStart(205);
            } else if (result.sideEffect === 'busyOff') {
                // $D40A read: Clear BUSY flag, return cancel status
                // bit 7: cancel flag (1=cancel active, 0=no cancel)
                const wasBusy = this._subBusy;
                this._subBusy = false;
                this._subBusyWasCleared = true;
                // Return cancel flag in bit 7, other bits=1
                const cancelBit = this._subCancel ? 0x80 : 0x00;
                return 0x7F | cancelBit;
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
                const result = this.display.readIO(addr);
                return result.value;
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

        // $D800-$DFFF: CG ROM/RAM (FM77AV) or Sub ROM (FM-7)
        if (addr < SUB_ROM_AV_BASE) {
            if (this.isFM77AV) {
                // Type-C: use sub ROM (FM-7 compatible)
                if (this._subMonitorType === SUB_MONITOR_C) {
                    return this.subROM[addr - SUB_ROM_BASE];
                }
                // Type-D/E: CG RAM (banked, writable)
                if (this._subMonitorType >= 4) {
                    return this.subRAM_CG[this._cgramBank * 0x0800 + (addr - 0xD800)];
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
            // Type-D/E: sub RAM (writable, loaded by F-BASIC from disk)
            if (this._subMonitorType >= 4) {
                return this.subRAM_DE[addr - SUB_ROM_AV_BASE];
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

    _subWrite(addr, val, fromMain = false) {
        addr &= 0xFFFF;
        val &= 0xFF;

        // AV40 Console RAM: $C000-$CFFF when Type-D/E + consram_bank >= 1
        if (addr >= 0xC000 && addr < 0xD000 &&
            this._subMonitorType >= 4 && this._consramBank >= 1) {
            this.subRAM_CN[(this._consramBank - 1) * 0x1000 + (addr - 0xC000)] = val;
            return;
        }

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

            // Trace all sub I/O writes when Type-D/E active
            if (this._subMonitorType >= 4 && this._dbgTraceMMR) {
                console.log(`[SUB-IOW] $${ioAddr.toString(16)}=$${val.toString(16).padStart(2,'0')} PC=$${this.subCPU.pc.toString(16).padStart(4,'0')}`);
            }

            // Keyboard ($D400-$D401) - writes ignored
            if (ioAddr <= 0xD401) return;

            // $D404: AV40 sub-interface extension (write)
            // bit 2: sub monitor protect (1=unprotect, 0=protect)
            // bit 3: 400-line mode (0=enable, 1=disable)
            // bit 4: 262,144-color mode (1=enable if !mode400l)
            // bit 5: kanji ROM connection (0=connect, 1=disconnect)
            if (ioAddr === 0xD404 && this.isAV40) {
                this._subramProtect = !(val & 0x04);
                const mode400l = !(val & 0x08);
                const mode256k = ((val & 0x10) !== 0) && !mode400l;
                const kanjiConnect = !(val & 0x20);
                this._subKanjiConnect = kanjiConnect;

                // Determine display mode from mode flags
                let newMode;
                if (mode400l) {
                    newMode = 3; // DISPLAY_MODE_400
                } else if (mode256k) {
                    newMode = 2; // DISPLAY_MODE_262K
                } else if (this.display.displayMode === 2 || this.display.displayMode === 3) {
                    // Leaving 262K/400-line — restore based on $FD12 setting
                    newMode = this.display._mode320Flag ? 1 : 0;
                } else {
                    newMode = this.display.displayMode;
                }
                if (newMode !== this.display.displayMode) {
                    this.display._setDisplayMode(newMode);
                }
                return;
            }

            // $D406/$D407: Sub-side kanji ROM address write (AV40/AV40EX only)
            // $D406 write: kanji_addr high byte, $D407 write: kanji_addr low byte
            if ((ioAddr === 0xD406 || ioAddr === 0xD407) && this.isAV40) {
                if (ioAddr & 1) {
                    this._kanjiAddr = (this._kanjiAddr & 0xFF00) | val;
                } else {
                    this._kanjiAddr = (this._kanjiAddr & 0x00FF) | (val << 8);
                }
                return;
            }

            // Display/control I/O
            const result = this.display.writeIO(ioAddr, val);

            // Handle side effects
            if (result && result.sideEffect === 'busyOn') {
                // $D40A write: Set BUSY
                this._subBusy = true;
                this._subBusyWasCleared = false;
            }
            return;
        }

        // FM77AV: $D410-$D4FF I/O area
        if (this.isFM77AV && addr >= 0xD410 && addr < 0xD500) {
            // Trace all AV I/O writes when Type-D/E active
            if (this._subMonitorType >= 4 && this._dbgTraceMMR) {
                console.log(`[SUB-IOW] $${addr.toString(16)}=$${val.toString(16).padStart(2,'0')} PC=$${this.subCPU.pc.toString(16).padStart(4,'0')}`);
            }
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
                // $D42E: AV40 sub RAM bank select / sub kanji ROM select
                if (addr === 0xD42E && this.isAV40) {
                    this._cgramBank = val & 0x07;       // bits 0-2: CG RAM bank
                    this._consramBank = (val >> 3) & 0x03; // bits 3-4: console RAM bank
                    if (this._consramBank >= 3) this._consramBank = 0;
                    this._subKanjiBank = !!(val & 0x80); // bit 7: level 1/2 select
                    return;
                }
                this.display.writeIO(addr, val);
                return;
            }
            // $D430: MISC register write
            // bit 7: NMI mask (1=masked)
            // bit 6: display page select
            // bit 5: active page select
            // bit 2: extended VRAM offset flag
            // bit 1-0: CG ROM bank
            if (addr === 0xD430) {
                // Trace raw $D430 write before applying side-effects
                this.display._pushScrollTrace('D430', { val });

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
            // $D431: Key encoder MCU command interface (multi-protocol)
            if (addr === 0xD431) {
                this._keyEncProcessByte(val);
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

        // $D800-$FFFF: ROM area (writes ignored) or Type-D/E sub RAM (writable)
        if (this._subMonitorType >= 4) {
            // subramProtect blocks sub CPU writes only; main CPU MMR bypasses protect
            if (this._subramProtect && !fromMain) {
                if (this._dbgTraceMMR) {
                    console.log(`[PROTECT] sub $${addr.toString(16).padStart(4,'0')}=$${val.toString(16).padStart(2,'0')} BLOCKED by subramProtect`);
                }
                return; // protected
            }
            if (addr < SUB_ROM_AV_BASE) {
                // $D800-$DFFF: CG RAM (banked)
                this.subRAM_CG[this._cgramBank * 0x0800 + (addr - 0xD800)] = val;
            } else {
                // $E000-$FFFF: sub RAM
                this.subRAM_DE[addr - SUB_ROM_AV_BASE] = val;
            }
        }
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

                // Line drawing BUSY timer
                if (this.display.lineBusy && this.display._lineBusyMicros > 0) {
                    this.display._lineBusyMicros -= cyclesToUs(mainElapsed);
                    if (this.display._lineBusyMicros <= 0) {
                        this.display.lineBusy = false;
                        this.display._lineBusyMicros = 0;
                    }
                }

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

                // PTM timer tick (FM77AV only)
                if (this.isFM77AV) this._ptmTick(mainElapsed);

                // Check and assert IRQ/FIRQ on main CPU (level-triggered)
                this._checkAndAssertInterrupts();

                // Apply deferred HALT/RUN at instruction boundary
                // (real hardware applies halt at instruction boundary)
                this._subHaltAck();

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
                        // Also check after each sub CPU instruction for responsive halt
                        this._subHaltAck();
                        if (this.scheduler.subHalted) break;
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
            // VBlank: 238 total lines - 200 visible = 38 lines × 63.5μs ≈ 2413μs
            // (Previously 510μs was only the VSYNC pulse width, not the full blanking interval)
            this._vblankCycles = usToCycles(2413);
        });

        // Sub CPU NMI timer (50 Hz = 20ms, independent of VSync per §4.2)
        this.scheduler.addEvent('subnmi', 20000, () => {
            if (!this._subHalted && !(this.isFM77AV && this._nmiMaskSub)) {
                if (!(this.subCPU.intr & 0x01)) {
                    this.subCPU.nmi();
                }
            }
        });
    }

    // =========================================================================
    // PTM (MC6840 Programmable Timer Module)
    // =========================================================================

    _ptmUpdateStatusTop() {
        // Bit 7 of status = any enabled timer has pending IRQ
        let any = false;
        for (let i = 0; i < 3; i++) {
            if ((this._ptmStatus & (1 << i)) && (this._ptmCR[i] & 0x40)) { any = true; break; }
        }
        if (any) this._ptmStatus |= 0x80;
        else this._ptmStatus &= ~0x80;
    }

    _ptmReload(idx) {
        this._ptmCounter[idx] = this._ptmLatch[idx];
    }

    _ptmRead(r) {
        // r = 0..7 (addr - 0xFDE0)
        if (r === 0) return 0xFF; // no-op read
        if (r === 1) {
            // Status register read; status is cleared by reading status *and then* the counter
            // of the pending timer (MC6840 datasheet). For simplicity, clear status on read when
            // all pending timers have also had their status-read bit set. We use a simpler model:
            // reading status does NOT clear; reading the timer's MSB clears that timer's flag.
            const s = this._ptmStatus;
            return s;
        }
        // r = 2,4,6: timer MSB read (captures LSB into buffer, clears IRQ flag)
        if ((r & 1) === 0) {
            const t = (r >> 1) - 1; // 2→0, 4→1, 6→2
            const cnt = this._ptmCounter[t];
            this._ptmLsbBuf[t] = cnt & 0xFF;
            // Clear timer's IRQ flag on counter read
            this._ptmStatus &= ~(1 << t);
            this._ptmUpdateStatusTop();
            return (cnt >> 8) & 0xFF;
        }
        // r = 3,5,7: buffered LSB read
        const t = ((r - 1) >> 1) - 1;
        return this._ptmLsbBuf[t];
    }

    _ptmWrite(r, val) {
        val &= 0xFF;
        if (r === 0) {
            // CR1 if CR2[0]=1, else CR3
            if (this._ptmCR[1] & 0x01) {
                const prev = this._ptmCR[0];
                this._ptmCR[0] = val;
                // CR1[0] MR bit (CR1 bit 0 per some docs — actually CR1[7] "master reset" when in CR1 mode is non-standard)
                // MC6840: internal reset is via CR1 bit 0? No — in MC6840, bit 0 of CR1 = clock source.
                // Master reset is asserted when CR2[0]=0 style reset; but simpler: many references state
                // CR1 bit 0 is "internal clock" not reset. The "reset" mechanism: writes to CR with address
                // 0 when CR2[0]=1 resets timer 1? No. We follow the common approximation: when CR1 is
                // written and a timer is in a state needing reload, reload happens via explicit LSB write.
                // For this impl, just store CR1. If CR[7] of CR1 = 1 we treat as master reset.
                if ((val & 0x01) && !(prev & 0x01)) {
                    // Transition out of internal clock disabled: nothing special here.
                }
            } else {
                this._ptmCR[2] = val;
            }
            return;
        }
        if (r === 1) {
            this._ptmCR[1] = val;
            return;
        }
        // r = 2,4,6: write MSB buffer (shared)
        if ((r & 1) === 0) {
            this._ptmMsbWBuf = val;
            return;
        }
        // r = 3,5,7: write LSB, commit latch, reload counter for that timer
        const t = ((r - 1) >> 1) - 1;
        this._ptmLatch[t] = ((this._ptmMsbWBuf & 0xFF) << 8) | val;
        this._ptmReload(t);
        // Clear pending IRQ flag on reload
        this._ptmStatus &= ~(1 << t);
        this._ptmUpdateStatusTop();
    }

    /**
     * Tick the PTM by `mainCycles` main CPU cycles.
     * PTM internal clock ≈ 1MHz (main CPU / 2). Counters decrement each PTM tick.
     * Underflow: counter wraps to reload latch value and sets IRQ flag (mode: continuous).
     */
    _ptmTick(mainCycles) {
        // Accumulate at PTM clock rate (main/2). We scale by 2 to avoid fractions.
        this._ptmCycleAcc += mainCycles;
        const ticks = this._ptmCycleAcc >> 1;
        this._ptmCycleAcc &= 1;
        if (ticks <= 0) return;
        for (let i = 0; i < 3; i++) {
            // Timer enabled when CR[0] = 1 (internal clock source)
            // NOTE: CR bit layout (MC6840): [0] clock src, [1] 16/8-bit, [2..4] mode, [5] prescale(T3), [6] IRQ en, [7] out en
            const cr = this._ptmCR[i];
            if (!(cr & 0x01)) continue; // external clock — ignore
            // T3 prescale divide-by-8 when CR3[0]=1 (CR[1] in the [1] position? datasheet: CR3 bit 0 controls /8 prescaler)
            let n = ticks;
            if (i === 2 && (this._ptmCR[2] & 0x01)) {
                // Use a second accumulator for /8 divider
                this._ptmT3Div = (this._ptmT3Div || 0) + ticks;
                n = this._ptmT3Div >> 3;
                this._ptmT3Div &= 7;
                if (n <= 0) continue;
            }
            let c = this._ptmCounter[i] - n;
            while (c < 0) {
                c += (this._ptmLatch[i] + 1);
                // Underflow: set IRQ flag
                this._ptmStatus |= (1 << i);
            }
            this._ptmCounter[i] = c & 0xFFFF;
        }
        this._ptmUpdateStatusTop();
    }

    /** Check all IRQ/FIRQ sources and assert on CPUs */
    _checkAndAssertInterrupts() {
        // Main CPU IRQ: timer, keyboard, FDC, OPN timers
        // 6809 IRQ is level-triggered: asserted while source is active,
        // de-asserted when all sources go inactive.
        let mainIrq = false;

        // Timer IRQ: $FD02 bit2 (1=enable, 0=mask)
        if (this._timerIRQ && (this._irqMaskReg & 0x04)) mainIrq = true;

        // Keyboard IRQ: use keyboard module's actual state (handles its own mask)
        if (this.keyboard.isIRQActive()) mainIrq = true;

        // FDC: INTRQ is NOT routed to CPU IRQ on FM-7/FM77AV.
        // FDC completion is detected by polling $FD18 (status register).
        // Do NOT include fdc.irqFlag in mainIrq.


        // OPN Timer IRQ: routed through $FD03 bit3 "extended interrupt"
        // (FM7 Programmers Guide §3.1). The IRQ source is the OPN status
        // bits 0/1 (Timer A/B overflow). The game's IRQ handler clears
        // these by writing OPN register $27 with reset bits ($10/$20).
        // Edge-triggered latch: set on new OPN timer overflow, auto-clears
        // when the underlying OPN status bits clear. The latch is also
        // cleared by reading $FD03. (Either path is sufficient.)
        if (this._fmCardEnabled) {
            const opnActive = (this.opn.timerAFlag && this.opn._timerAIRQ) ||
                              (this.opn.timerBFlag && this.opn._timerBIRQ);
            if (opnActive && !this._opnIrqPrev) this._opnIrqLatch = true;
            // Auto-clear when the OPN side has dropped both flags. Without
            // this, a game whose IRQ handler resets timers via OPN reg $27
            // (without ever reading $FD03) would experience an IRQ storm.
            if (!opnActive) this._opnIrqLatch = false;
            this._opnIrqPrev = opnActive;
            if (this._opnIrqLatch) mainIrq = true;
        }

        // PTM IRQ (FM77AV $FDE0-$FDE7, routed via $FD17 bit 2)
        if (this.isFM77AV && (this._ptmStatus & 0x80)) mainIrq = true;

        // Level-triggered: assert or de-assert IRQ based on current sources
        if (mainIrq) this.mainCPU.irq();
        else this.mainCPU.intr &= ~0x04;  // INTR_IRQ

        // Sub CPU FIRQ: keyboard-driven, gated by $FD02 bit 0.
        // $FD02 bit 0 controls keyboard routing:
        //   bit 0 = 0 → keyboard._irqMask = 1 → keyboard routed to sub CPU via FIRQ
        //   bit 0 = 1 → keyboard._irqMask = 0 → keyboard routed to main CPU via IRQ
        // When keyboard is routed to main CPU, sub CPU FIRQ must be cleared.
        // Use _irqFlag (edge, cleared on $FD01 read) rather than
        // _keyAvailable (level, stays latched on the data register)
        // so sub FIRQ tracks new events only.
        if (this.keyboard._irqFlag && this.keyboard._irqMask !== 0) {
            this.subCPU.intr |= 0x02; // INTR_FIRQ
        } else {
            this.subCPU.intr &= ~0x02;
        }

        // Main CPU FIRQ is edge-triggered: asserted once when sub CPU
        // reads $D404 (in _subRead). Do NOT re-assert here every cycle,
        // or the main CPU gets stuck in infinite FIRQ.
    }

    // =========================================================================
    // Sub CPU HALT acknowledge (deferred application)
    // =========================================================================

    /**
     * Apply pending HALT/RUN/CANCEL requests at sub CPU instruction boundary.
     * Called after each sub CPU instruction completes.
     * Real hardware applies halt at instruction boundaries.
     */
    /** Display-side reset performed on $FD13 write (extracted for deferred path) */
    _applyFD13DisplayReset() {
        this.display.resetALU();
        this.display.resetPalette();
        this.display.multiPage = 0;
        // Un-rotate VRAM before zeroing offsets
        const savedActive = this.display.activeVramPage;
        for (let p = 0; p < 2; p++) {
            if (this.display.crtcOffset[p] !== 0) {
                this.display.activeVramPage = p;
                this.display._vramScroll((-this.display.crtcOffset[p]) & 0xFFFF);
            }
        }
        this.display.activeVramPage = savedActive;
        this.display.vramOffset[0] = 0;
        this.display.vramOffset[1] = 0;
        this.display.crtcOffset[0] = 0;
        this.display.crtcOffset[1] = 0;
        this.display._vramOffsetCount[0] = 0;
        this.display._vramOffsetCount[1] = 0;
        this.display.vramOffsetFlag = false;
        this.display.crtOn = false;
        this.display.vramaFlag = false;
        this.display.activeVramPage = 0;
        this.display.displayVramPage = 0;
        // Reset display mode: 400-line / 262K → restore to 200-line mode
        // But NOT when entering Type-D/E — $FD04 sets 400-line before $FD13
        if (this.display.displayMode >= 2 && this._subMonitorType < 4) {
            const newMode = this.display._mode320Flag ? 1 : 0;
            this.display._setDisplayMode(newMode);
        }
        this.display.subramVramBank = 0;
        this._nmiMaskSub = false;
        this._vsyncFlag = false;
        this._blankFlag = true;
        this._subCancelRequest = false;
        this.display._fullDirty = true;
    }

    _subHaltAck() {
        // Apply HALT/RUN request
        if (this._subHaltRequest) {
            if (!this._subHalted) {
                this._subHalted = true;
                this._subBusy = true;
                this._subBusyWasCleared = false;
                this.scheduler.setSubHalted(true);
                if (this._dbgTraceMMR) {
                    console.log(`[HALT] Sub CPU halted, PC=$${(this.subCPU.pc||0).toString(16).padStart(4,'0')} monType=${this._subMonitorType}`);
                }
                // Save sub CPU's view of $D430 state at halt time.
                // Main CPU MMR writes to $D430 during halt may otherwise
                // change apg from under the sub CPU's feet, causing it to
                // write scroll registers to the wrong page on resume.
                // Toggle: fm7.haltSaveApg = false to disable (BUG03 test)
                if (this.haltSaveApg !== false) {
                    this._haltSavedActivePage = this.display.activeVramPage;
                    this._haltSavedDisplayPage = this.display.displayVramPage;
                }
                this.display._pushScrollTrace('HALT', { val: this.subCPU.pc });
            }
        } else {
            if (this._subHalted) {
                this._subHalted = false;
                this.scheduler.setSubHalted(false);
                // Restore sub CPU's view of $D430 state.
                if (this.haltSaveApg !== false && this._haltSavedActivePage !== undefined) {
                    this.display._setActiveVramPage(this._haltSavedActivePage);
                    this.display._setDisplayVramPage(this._haltSavedDisplayPage);
                    this._haltSavedActivePage = undefined;
                }
                if (this._dbgTraceMMR) {
                    console.log(`[UNHALT] Sub CPU released, monType=${this._subMonitorType} protect=${this._subramProtect} deferred=${this._subResetDeferred}`);
                }
                // Apply deferred $FD13 reset on HALT release
                if (this._subResetDeferred) {
                    this._subResetDeferred = false;
                    this.subCPU.reset();
                    console.log('FM77AV: Deferred sub CPU reset applied on HALT release');
                }
                this.display._pushScrollTrace('RUN', { val: this.subCPU.pc });
            }
        }
        // Apply CANCEL request: promote request to flag.
        // Do NOT assert IRQ here — IRQ is only asserted when $FD05 is written
        // (level-trigger check), typically on the RUN command after halt.
        if (this._subCancelRequest) {
            this._subCancel = true;
            this._subCancelRequest = false;
        }
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
            this.fddSound.init(this.psg._audioCtx);

            if (this._breakKeyCodes.includes(e.code)) {
                e.preventDefault();
                this._breakKey = true;
                this.mainRAM[0x0313] = 0xFF;
                // BREAK press asserts main CPU FIRQ (shared line with
                // sub→main attention). Level-triggered in hardware, but
                // edge on press is sufficient: FIRQ handler reads $FD04
                // bit1 to identify BREAK and acts accordingly.
                this.mainCPU.firq();
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

    /**
     * Simulate BREAK key press (for virtual keyboard).
     * Asserts main CPU FIRQ, same as physical BREAK key.
     */
    pressBreak() {
        this._breakKey = true;
        this.mainRAM[0x0313] = 0xFF;
        this.mainCPU.firq();
    }

    /**
     * Simulate BREAK key release (for virtual keyboard).
     */
    releaseBreak() {
        this._breakKey = false;
    }

    // =========================================================================
    // FDC Wiring
    // =========================================================================

    _wireFDC() {
        // FDC IRQ uses an edge-triggered latch in _checkAndAssertInterrupts.
        // The latch is set when fdc.irqFlag transitions 0→1, and cleared
        // when the CPU reads $FD18 (status register) via _mainIORead.
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
     * Load BASIC ROM ($8000-$FBFF, 31KB)
     * @param {ArrayBuffer} data
     */
    loadFBasicROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, FBASIC_ROM_SIZE);
        this.fbasicROM.set(src.subarray(0, len));
        this.romLoaded.fbasic = true;
        console.log(`BASIC ROM loaded: ${len} bytes`);
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

    /**
     * Load Kanji ROM (JIS level 1, 128KB).
     * Accessed via $FD20/$FD21 (address) and $FD22/$FD23 (data).
     * @param {ArrayBuffer} data
     */
    loadKanjiROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.kanjiROM.length);
        // Reset to 0xFF before loading (in case data is smaller than 128KB)
        this.kanjiROM.fill(0xFF);
        this.kanjiROM.set(src.subarray(0, len));
        this._kanjiSize = len;
        this.romLoaded.kanji = true;
        console.log(`Kanji ROM loaded: ${len} bytes`);
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

        this.romLoaded.initiate = true;
        console.log(`Initiator ROM loaded: ${len} bytes`);
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

    /**
     * Load EXTSUB.ROM (FM77AV40EX/SX, 48KB — extended sub ROM banks Type-D/E)
     * @param {ArrayBuffer} data
     */
    loadKanji2ROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.kanjiROM2.length);
        this.kanjiROM2.fill(0xFF);
        this.kanjiROM2.set(src.subarray(0, len));
        this.romLoaded.kanji2 = true;
        console.log(`Kanji2 ROM loaded: ${len} bytes`);
    }

    loadDicromROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.dicromROM.length);
        this.dicromROM.fill(0xFF);
        this.dicromROM.set(src.subarray(0, len));
        this.romLoaded.dicrom = true;
        console.log(`DICROM loaded: ${len} bytes (${Math.floor(len / 0x1000)} banks)`);
    }

    loadExtSubROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.extsubROM.length);
        this.extsubROM.set(src.subarray(0, len));
        this._extsubROMSize = src.length;
        this.romLoaded.extsub = true;
        console.log(`EXTSUB.ROM loaded: ${src.length} bytes (${Math.ceil(src.length / 0x2000)} banks)`);
    }

    // =========================================================================
    // Machine Type
    // =========================================================================

    /**
     * Set the machine type. Must be called before reset().
     * @param {string} type - 'fm7' or 'fm77av'
     */
    setMachineType(type) {
        if (type !== MACHINE_FM7 && type !== MACHINE_FM77AV && type !== MACHINE_FM77AV40 && type !== MACHINE_FM77AV40EX) {
            console.warn(`Unknown machine type: ${type}, defaulting to fm7`);
            type = MACHINE_FM7;
        }
        this._machineType = type;
        const isAV = type !== MACHINE_FM7;
        const isAV40 = type === MACHINE_FM77AV40 || type === MACHINE_FM77AV40EX;
        const cpuHz = isAV ? 2000000 : 1794000;
        setCPUClock(cpuHz);
        FDC.setCPUClock(cpuHz);
        this.opn.setAVMode(isAV);
        this.opn.setCPUClock(cpuHz);
        this.psg.setCPUClock(cpuHz);
        // FM77AV has OPN built-in; always enable FM sound
        if (isAV) this._fmCardEnabled = true;
        // AV40/AV40EX: expand extended RAM to 448KB
        if (isAV40) {
            this._extRAM = new Uint8Array(0x70000); // 448KB
        } else {
            this._extRAM = new Uint8Array(0x30000); // 192KB
        }
        this.display.isAV40 = isAV40;
        console.log(`Machine type set to: ${type} (CPU ${cpuHz/1000}kHz)`);
    }

    /** @returns {boolean} true if FM77AV series */
    get isFM77AV() {
        return this._machineType !== MACHINE_FM7;
    }

    /** @returns {boolean} true if FM77AV40 or FM77AV40EX */
    get isAV40() {
        return this._machineType === MACHINE_FM77AV40 || this._machineType === MACHINE_FM77AV40EX;
    }

    /** @returns {boolean} true if FM77AV40EX (EXTSUB.ROM搭載機) */
    get isAV40EX() {
        return this._machineType === MACHINE_FM77AV40EX;
    }

    /**
     * Enable/disable FM sound card (OPN + joystick port).
     * FM77AV always has OPN built-in; this only affects FM-7 mode.
     */
    setFMCard(enabled) {
        this._fmCardEnabled = enabled || this.isFM77AV;
    }

    // =========================================================================
    // OPN bus helpers
    //
    // The YM2203 talks to the CPU through a 4-bit BDIR/BC1/etc. enum on its
    // command port. fm7.js owns the protocol latches (selreg / seldat /
    // pstate) and forwards register transactions to the OPN object. These
    // helpers exist so both $FD15/$FD16 (FM-7 card / FM77AV) and $FD0D/$FD0E
    // (FM77AV mirror) can dispatch through the same logic without duplicating
    // the case table.
    // =========================================================================

    /** OPN command port write — dispatches the 4-bit BDIR/BC1 enum. */
    _opnWriteCmd(val) {
        const cmd = val & 0x0F;
        switch (cmd) {
            case 0x00: // INACTIVE
                this._opnPState = 0x00;
                break;
            case 0x01: // READDAT: seldat ← regs[selreg]
                this._opnPState = 0x01;
                this._opnDataBus = this._opnRegs[this._opnAddrLatch] & 0xFF;
                break;
            case 0x02: { // WRITEDAT: writereg(selreg, seldat)
                this._opnPState = 0x02;
                const reg = this._opnAddrLatch;
                const dat = this._opnDataBus & 0xFF;
                this.opn.writeReg(reg, dat);
                this._opnRegs[reg] = dat;
                break;
            }
            case 0x03: { // ADDRESS: selreg ← seldat; prescaler regs self-trigger
                this._opnPState = 0x03;
                this._opnAddrLatch = this._opnDataBus & 0xFF;
                const r = this._opnAddrLatch;
                if (r >= 0x2D && r <= 0x2F) {
                    this._opnDataBus = 0;
                    this.opn.writeReg(r, 0);
                    this._opnRegs[r] = 0;
                }
                break;
            }
            case 0x04: // READSTAT
                this._opnPState = 0x04;
                break;
            case 0x09: // JOYSTICK
                this._opnPState = 0x09;
                break;
            // other codes: ignored (pstate unchanged)
        }
    }

    /** OPN data port write — latches into seldat for the next WRITEDAT. */
    _opnWriteData(val) {
        this._opnDataBus = val & 0xFF;
    }

    /** OPN data port read — dispatches on pstate (status / joystick / data). */
    _opnReadData() {
        switch (this._opnPState) {
            case 0x04: // READSTAT: live status each read
                return this.opn.readStatus();
            case 0x09: { // JOYSTICK: only selreg==14 yields joystick data
                if (this._opnAddrLatch === 14) {
                    const portB = this._opnRegs[0x0F] & 0xF0;
                    if (portB === 0x20) return this._gamepadState[0];
                    if (portB === 0x50) return this._gamepadState[1];
                    return 0xFF;
                }
                return 0x00;
            }
            default: // INACTIVE / READDAT / WRITEDAT / ADDRESS → seldat
                return this._opnDataBus;
        }
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
     * Enable FDC logging from browser console.
     * Usage: fm7.fdcLogOn() → operate → fm7.fdcLogDump()
     */
    fdcLogOn() {
        this.fdc.logEnabled = true;
        this.fdc.log = [];
        console.log('[FDC] Logging enabled');
    }

    /**
     * Dump FDC log (command entries only, no status polls).
     * Usage: fm7.fdcLogDump()
     */
    fdcLogDump() {
        const cmds = this.fdc.log.filter(e => e.t !== 'R' && e.t !== 'W');
        console.log(`[FDC] ${cmds.length} command entries (${this.fdc.log.length} total):`);
        for (const e of cmds) {
            console.log(JSON.stringify(e));
        }
        return cmds;
    }

    /**
     * Disable FDC logging.
     */
    fdcLogOff() {
        this.fdc.logEnabled = false;
        console.log('[FDC] Logging disabled');
    }

    /** Find and dump BASIC program in memory after LOAD.
     *  Usage: fm7.findBasic()  — searches RAM for BASIC lines, dumps program area */

    /** Set write watchpoint on RAM range. Usage: fm7.watchOn(0x7CBB, 3) */
    watchOn(addr, len) { this._watchAddr = addr; this._watchLen = len || 1; console.log(`[WATCH] ON $${addr.toString(16)} len=${len||1}`); }
    watchOff() { this._watchAddr = 0; this._watchLen = 0; console.log('[WATCH] OFF'); }

    /** Start capturing FDC read bytes. Call before LOAD. */
    fdcCaptureOn() { this.fdc._captureEnabled = true; this.fdc._captureData = []; console.log('[FDC] capture ON'); }
    /** Stop capturing. */
    fdcCaptureOff() { this.fdc._captureEnabled = false; console.log(`[FDC] capture OFF, ${this.fdc._captureData.length} bytes`); }
    /** Compare FDC captured bytes with main RAM at given address.
     *  Usage: fm7.fdcCompare(0x7C02)  — after LOAD completes */
    fdcCompare(ramBase) {
        const cap = this.fdc._captureData;
        if (!cap || cap.length === 0) { console.log('No capture data'); return; }
        console.log(`Comparing ${cap.length} FDC bytes vs RAM at $${ramBase.toString(16)}`);
        let mismatches = 0;
        for (let i = 0; i < cap.length && i < 0x2000; i++) {
            const ram = this._mainRead(ramBase + i);
            if (cap[i] !== ram) {
                if (mismatches < 40) {
                    console.log(`  DIFF @${i} ($${(ramBase+i).toString(16)}): FDC=0x${cap[i].toString(16).padStart(2,'0')} RAM=0x${ram.toString(16).padStart(2,'0')}`);
                }
                mismatches++;
            }
        }
        console.log(`Total: ${cap.length} bytes, ${mismatches} mismatches`);
        // Also dump first 512 bytes of capture as hex
        console.log('FDC capture first 288 bytes:');
        for (let i = 0; i < Math.min(288, cap.length); i += 16) {
            const hex = cap.slice(i, i+16).map(b=>b.toString(16).padStart(2,'0')).join(' ');
            const ascii = cap.slice(i, i+16).map(b=>(b>=0x20&&b<0x7f)?String.fromCharCode(b):'.').join('');
            console.log(`  ${i.toString(16).padStart(4,'0')}: ${hex}  ${ascii}`);
        }
    }

    findBasic() {
        // Search for line 1000 pattern: [nextPtr:2][03 E8][3A 8D 2A]
        let found = -1;
        for (let addr = 0x100; addr < 0x8000; addr++) {
            if (this._mainRead(addr) === 0x03 && this._mainRead(addr+1) === 0xE8 &&
                this._mainRead(addr+2) === 0x3A && this._mainRead(addr+3) === 0x8D) {
                found = addr - 2; // nextPtr is 2 bytes before lineNum
                break;
            }
        }
        if (found < 0) {
            console.log('[BASIC] Line 1000 not found in RAM');
            return;
        }
        console.log(`[BASIC] Line 1000 found at $${found.toString(16).padStart(4,'0')}`);

        // Sequential scan (how LIST works — scan for 0x00 line terminators)
        console.log('[BASIC] === Sequential scan ===');
        let ptr = found;
        let lineCount = 0;
        while (ptr < 0x8000 && lineCount < 200) {
            const hi = this._mainRead(ptr);
            const lo = this._mainRead(ptr + 1);
            const nextPtr = (hi << 8) | lo;
            const lineNum = (this._mainRead(ptr+2) << 8) | this._mainRead(ptr+3);
            if (nextPtr === 0x0000) {
                console.log(`[BASIC] End marker at $${ptr.toString(16)} after ${lineCount} lines`);
                break;
            }
            lineCount++;
            // Show first 5 and last lines
            if (lineCount <= 5) {
                console.log(`  Line ${lineNum} at $${ptr.toString(16)} nextPtr=$${nextPtr.toString(16)} offset=${ptr-found}`);
            }
            // Scan forward for 0x00 line terminator (sequential, like LIST)
            let scan = ptr + 4;
            while (scan < ptr + 300 && this._mainRead(scan) !== 0x00) scan++;
            const nextLine = scan + 1;
            if (lineCount <= 5) {
                console.log(`    terminator at $${scan.toString(16)}, next line at $${nextLine.toString(16)}`);
            }
            ptr = nextLine; // move to next line (sequential)
        }

        // Dump memory around where it stopped
        console.log(`[BASIC] Dump around break point ($${(ptr-32).toString(16)}):`);
        this.dumpMem(ptr > 32 ? ptr - 32 : found, 96);

        // Also dump the first 288 bytes (more than 1 sector) of program area
        console.log('[BASIC] First 288 bytes of program:');
        this.dumpMem(found, 288);
    }

    /** Dump main RAM as hex. Usage: fm7.dumpMem(0x0600, 256) */
    dumpMem(addr, len = 256) {
        const lines = [];
        for (let i = 0; i < len; i += 16) {
            const a = (addr + i) & 0xFFFF;
            const hex = [];
            const ascii = [];
            for (let j = 0; j < 16 && (i + j) < len; j++) {
                const b = this._mainRead((a + j) & 0xFFFF);
                hex.push(b.toString(16).padStart(2, '0'));
                ascii.push(b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.');
            }
            lines.push(`$${a.toString(16).padStart(4, '0')}: ${hex.join(' ')}  ${ascii.join('')}`);
        }
        console.log(lines.join('\n'));
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
     * Boot mode is auto-detected: disk in drive 0 → DOS, else → BASIC.
     */
    reset() {
        // =====================================================================
        // Auto boot mode: disk in drive 0 → DOS, otherwise → BASIC
        // =====================================================================
        const hasDisk = this.fdc.disks[0] && this.fdc.disks[0].loaded;
        let bootMode;
        if (this._bootModeOverride === 'dos') bootMode = 'dos';
        else if (this._bootModeOverride === 'basic') bootMode = 'basic';
        else bootMode = hasDisk ? 'dos' : 'basic';
        this._bootMode = bootMode;

        // Clear main RAM; shared RAM to 0xFF (FM-7 hardware default)
        this.mainRAM.fill(0x00);
        this.sharedRAM.fill(0xFF);

        // Reset I/O state
        this._subHalted   = false;  // Sub CPU runs after reset
        this._subHaltRequest = false;
        this._subCancelRequest = false;
        this._subBusy     = true;   // BUSY set on reset (sub CPU clears via $D40A read during init)
        this._subBusyWasCleared = false;
        this._subCancel   = false;
        this._subAttn     = false;
        this._breakKey    = false;
        this._timerIRQ    = false;
        this._irqMaskReg  = 0;

        // Reset PTM state
        this._ptmCR.fill(0);
        this._ptmLatch.fill(0xFFFF);
        this._ptmCounter.fill(0xFFFF);
        this._ptmLsbBuf.fill(0);
        this._ptmMsbWBuf = 0;
        this._ptmStatus = 0;
        this._ptmCycleAcc = 0;
        this._ptmT3Div = 0;
        // BASIC ROM: always enabled at reset (real hardware default).
        // IPL/game code disables it via write to $FD0F when needed.
        this._basicRomEnabled = true;
        this._fbasicWarnShown = false;

        // Reset OPN state
        this._opnAddrLatch = 0;
        this._opnDataBus = 0;
        this._opnPState = 0;
        this._opnRegs.fill(0);
        this._gamepadState[0] = 0xFF;
        this._gamepadState[1] = 0xFF;

        // FM77AV specific reset
        if (this.isFM77AV) {
            this._initiatorActive = false; // Set before boot path logic overrides it
            this._initiatorHandoffDone = false;
            // Sub monitor type after reset is always Type-C (subrom_bank=0).
            // The IPL/game then switches via $FD13 if it needs Type-A/B.
            this._subMonitorType = SUB_MONITOR_C;
            this._cgRomBank = 0;
            this._nmiMaskSub = false;
            this._subResetFlag = false;
            this._subResetDeferred = false;
            this._vsyncFlag = true;
            this._blankFlag = true;   // Blanking active at power-on
            this._vblankCycles = 0;
            this._analogPaletteAddr = 0;
            this._analogPalette.fill(0);
            // MMR reset
            this._mmrEnabled = false;
            this._mmrExt = false;
            this._mmrBankReg = 0;
            this._twrFlag = false;
            this._twrReg = 0;
            this._mmrRegs.fill(0);
            this._bootramRW = false;
            // AV40 sub-interface extension
            this._subramProtect = true;    // Sub RAM protected at reset
            this._subKanjiConnect = false; // Kanji ROM disconnected at reset
            this._cgramBank = 0;
            this._consramBank = 0;
            this.subRAM_DE.fill(0);
            this.subRAM_CG.fill(0);
            this.subRAM_CN.fill(0);
            this._dicromBank = 0;
            this._dicromEn = false;
            this._dicramEn = false;
            this._extromSel = false;
            this._subKanjiBank = false;
            this._subKanjiFlag = false;
            // AV40 peripheral stubs
            this._dmacReg = 0;
            this._dmacRegs.fill(0);
            this._rd512Sector = 0;
            // MMR registers stay at $00 after fill(0) above.
            // INITIATE.ROM sets the segments it needs; unwritten ones remain
            // $00 (pointing to extRAM page 0), which is critical for F-BASIC
            // V3.4's machine-type detection reading $078D via seg0.
            // Share analog palette reference with display
            this.display.analogPalette = this._analogPalette;
            // Enable FM77AV features in display (ALU, line drawing)
            this.display.isAV = true;
            this.display.isAV40 = this.isAV40;
            // Keyboard MCU power-on default = KEY_FORMAT_9BIT (FM-7
            // compatible ASCII, no break codes). Native FM77AV games
            // that need scan codes explicitly switch by writing cmd
            // $00 with data $02 to the MCU at $D431. The sub ROM bank
            // handler may also adjust the mode when the game switches
            // to Type-C (see $FD13 write handler).
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
            this._keyEncFormat = 0;
            this._keyEncFormatExplicit = false;
        } else {
            this._initiatorActive = false;
            this._initiatorHandoffDone = false;
            this._subMonitorType = SUB_MONITOR_C;
            this._cgRomBank = 0;
            // Clear FM77AV state that may linger from a previous AV session
            this._nmiMaskSub = false;
            this._subResetFlag = false;
            this._subResetDeferred = false;
            this._vsyncFlag = true;
            this._blankFlag = true;
            this._vblankCycles = 0;
            this._analogPaletteAddr = 0;
            this._analogPalette.fill(0);
            this._mmrEnabled = false;
            this._mmrExt = false;
            this._mmrBankReg = 0;
            this._twrFlag = false;
            this._twrReg = 0;
            this._mmrRegs.fill(0);
            this._bootramRW = false;
            this._dmacReg = 0;
            this._dmacRegs.fill(0);
            this._rd512Sector = 0;
            this.display.analogPalette = null;
            this.display.isAV = false;
            this.display.isAV40 = false;
            // FM-7: ASCII character codes, no break codes
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
        }

        // _basicBootStub is no longer used — boot ROM code is bypassed entirely
        this._basicBootStub = null;

        // Reset all components
        this.display.reset();
        this.fdc.reset();
        this.cmt.reset();
        this.keyboard.reset();
        this.psg.reset();
        this.opn.reset();
        this.scheduler.reset();

        // Re-apply keyboard mode after component reset (components may clear it)
        // Default = KEY_FORMAT_9BIT (FM-7 ASCII). Games switch via $D431.
        if (this.isFM77AV) {
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
            this._keyEncFormat = 0;
            this._keyEncFormatExplicit = false;
        }

        // =====================================================================
        // Boot ROM bypass: perform boot sequence directly in JS
        // Instead of running INITIATE.ROM / BOOT_BAS / BOOT_DOS 6809 code,
        // we initialize hardware state and set the main CPU PC directly.
        // =====================================================================

        // Set up interrupt vectors in RAM ($FFE0-$FFFF).
        // Use boot_dos.rom vectors if available (they contain SWI/IRQ/NMI handlers).
        // These point to low-RAM stubs that BASIC ROM will overwrite during init.
        if (this.romLoaded.boot) {
            for (let i = 0xFFE0; i <= 0xFFFF; i++) {
                const romByte = this.bootROM[i - BOOT_ROM_BASE];
                if (romByte !== 0xFF) {
                    this.mainRAM[i] = romByte;
                }
            }
        }

        // For BASIC boot, perform FDC port initialization (Boot ROM's $FFC0).
        // For DOS boot, BOOT_DOS.ROM handles FDC init itself.
        if (bootMode === 'basic') {
            this._initFDCPorts();
        }

        // Reset sub CPU — it reads its own reset vector from sub ROM
        this.subCPU.reset();
        // NMI is masked via _nmiMaskSub (set earlier); sub ROM unmasks via $D430
        this.scheduler.setSubHalted(false);

        // Determine main CPU start address based on boot mode and machine type
        let mainPC;
        let initiatorPath = false;
        if (this.isFM77AV) {
            // FM77AV: INITIATE.ROM is mandatory. Run it as 6809 code so all
            // side effects (BIOS workspace init, $FBxx vectors, OPN/palette
            // init, sub CPU data transfer) take effect — some 1985-era
            // FM77AV games depend on these and break under any bypass path.
            if (!this.romLoaded.initiate) {
                console.error('[BOOT] FM77AV requires INITIATE.ROM. Falling back to bypass for compatibility.');
                mainPC = (bootMode === 'dos') ? this._dosBootDirect() : this._basicBootBypass();
            } else {
                this._patchInitiateROM();
                this._initiatorActive = true;
                mainPC = 0x6000; // INITIATE.ROM entry (mirrored at $FFFE-$FFFF)
                initiatorPath = true;
                console.log('[BOOT] FM77AV: running INITIATE.ROM as 6809 code (PC=$6000)');
            }
        } else if (bootMode === 'dos') {
            // FM-7 DOS boot: run BOOT_DOS.ROM code at $FE00 on the 6809.
            mainPC = this._dosBootDirect();
        } else {
            // FM-7 BASIC boot: jump directly to BASIC ROM cold start (bypass).
            mainPC = this._basicBootBypass();
        }

        // Set main CPU initial state (DP=0, interrupts masked, PC=target)
        this.mainCPU.reset();
        this.mainCPU.pc = mainPC;
        // Apply deferred register setup from NEW BOOT bypass
        if (this._bootRegs) {
            if (this._bootRegs.a !== undefined) this.mainCPU.a = this._bootRegs.a;
            if (this._bootRegs.x !== undefined) this.mainCPU.x = this._bootRegs.x;
            this._bootRegs = null;
        }
        // Set reset vector in RAM to match (for consistency)
        this.mainRAM[0xFFFE] = (mainPC >> 8) & 0xFF;
        this.mainRAM[0xFFFF] = mainPC & 0xFF;

        // Log boot info
        console.log(`${this._machineType.toUpperCase()} reset (boot: ${bootMode}, ${initiatorPath ? 'INITIATE.ROM' : 'bypass'})`);
        console.log(`  Main CPU PC: $${mainPC.toString(16).toUpperCase().padStart(4, '0')}`);
        console.log(`  Initiator: ${initiatorPath ? 'ACTIVE (executing)' : 'BYPASSED'}, ROM loaded: ${this.romLoaded.initiate}`);
        console.log(`  Sub monitor: Type-${['C','A','B','CG','D/E'][this._subMonitorType]}, ROM loaded: A=${this.romLoaded.subA} B=${this.romLoaded.subB} C=${this.romLoaded.sub}`);
        console.log(`  Disk in drive 0: ${hasDisk ? 'YES' : 'NO'}, BASIC ROM: ${this.romLoaded.fbasic ? 'YES' : 'NO'}`);
        const srvHi = this._subRead(0xFFFE);
        const srvLo = this._subRead(0xFFFF);
        console.log(`  Sub CPU reset vector: $${((srvHi << 8) | srvLo).toString(16).toUpperCase().padStart(4, '0')}`);
    }

    /**
     * FDC port initialization — equivalent to Boot ROM's $FFC0 routine.
     * Clears FDC command registers and issues Force Interrupt to each port.
     */
    _initFDCPorts() {
        // The Boot ROM writes to $FD06/$FD07 (FDC aux) and $FD24-$FD2A
        // (4 FDC sub-ports), issuing CLR + Force Interrupt ($40) to each.
        // Our FDC.reset() already handles this, but we also clear the
        // main CPU side I/O state for completeness.
        this.fdc.reset();
    }

    /**
     * BASIC boot bypass: determine BASIC ROM cold start address.
     * Reads the cold start vector from BASIC ROM at $FBFE-$FBFF.
     * @returns {number} Start address for main CPU
     */
    _basicBootBypass() {
        if (!this.romLoaded.fbasic) {
            console.error('[BOOT] BASIC ROM not loaded — cannot BASIC boot');
            return 0xFE00; // Fallback: try boot ROM if available
        }
        // BASIC ROM cold start vector at $FBFE-$FBFF
        // (ROM mapped at $8000-$FBFF, so offset = $FBFE - $8000 = $7BFE)
        const hi = this.fbasicROM[0x7BFE];
        const lo = this.fbasicROM[0x7BFF];
        const coldStart = (hi << 8) | lo;
        console.log(`[BOOT] BASIC bypass: cold start = $${coldStart.toString(16).toUpperCase().padStart(4, '0')}`);
        return coldStart;
    }

    /**
     * Patch INITIATE.ROM for the current machine type.
     * Real hardware has model-specific INITIATE.ROM; emulators share one ROM
     * and patch the hardware version string + boot path branching.
     *
     * Offset $0B0E (6 bytes): hardware version string
     *   FM77AV   → $FF fill (original AV, no version string)
     *   AV40     → "400Ma."
     *   AV40EX   → "401Ma."
     *
     * Search-based patches (first $B00 bytes):
     *   BRA $D7 (bytes $20 $D7) → NEW BOOT copy branch
     *     FM77AV: $21 (BRN = skip) — AV has no NEW BOOT
     *     Others: $20 (BRA = copy NEW BOOT)
     *   JMP $5000 (bytes $7E $50 $00) → trampoline target
     *     FM77AV: JMP $FE00 (OLD BOOT entry)
     *     Others: JMP $5000 (NEW BOOT entry)
     */
    _patchInitiateROM() {
        const rom = this.initiateROM;
        if (!this.romLoaded.initiate || this._initiateROMSize < 0x0B14) return;

        // --- Version string at offset $0B0E ---
        switch (this._machineType) {
            case MACHINE_FM77AV:
                rom.fill(0xFF, 0x0B0E, 0x0B14);
                break;
            case MACHINE_FM77AV40:
                rom[0x0B0E] = 0x34; // '4'
                rom[0x0B0F] = 0x30; // '0'
                rom[0x0B10] = 0x30; // '0'
                rom[0x0B11] = 0x4D; // 'M'
                rom[0x0B12] = 0x61; // 'a'
                rom[0x0B13] = 0x2E; // '.'
                break;
            case MACHINE_FM77AV40EX:
                rom[0x0B0E] = 0x34; // '4'
                rom[0x0B0F] = 0x30; // '0'
                rom[0x0B10] = 0x31; // '1'
                rom[0x0B11] = 0x4D; // 'M'
                rom[0x0B12] = 0x61; // 'a'
                rom[0x0B13] = 0x2E; // '.'
                break;
        }

        // --- Search-based boot path patches (first $B00 bytes) ---
        // Search for BRA/BRN $D7 (either $20 or $21 with offset $D7)
        // and JMP $5000/$FE00 (either target, from previous patch)
        let foundBRA = false, foundJMP = false;
        for (let i = 0; i < 0xB00 && !(foundBRA && foundJMP); i++) {
            if (!foundBRA && (rom[i] === 0x20 || rom[i] === 0x21) && rom[i + 1] === 0xD7) {
                rom[i] = (this._machineType === MACHINE_FM77AV) ? 0x21 : 0x20;
                foundBRA = true;
            }
            if (!foundJMP && rom[i] === 0x7E &&
                ((rom[i + 1] === 0x50 && rom[i + 2] === 0x00) ||
                 (rom[i + 1] === 0xFE && rom[i + 2] === 0x00))) {
                if (this._machineType === MACHINE_FM77AV) {
                    rom[i + 1] = 0xFE; rom[i + 2] = 0x00;
                } else {
                    rom[i + 1] = 0x50; rom[i + 2] = 0x00;
                }
                foundJMP = true;
            }
        }

        const verStr = String.fromCharCode(...rom.slice(0x0B0E, 0x0B14));
        console.log(`[BOOT] INITIATE.ROM patched: ver="${verStr}" BRA=${foundBRA} JMP=${foundJMP} (${this._machineType})`);
    }

    /**
     * DOS boot direct: let BOOT_DOS.ROM run on the 6809.
     * BOOT_DOS handles FDC initialization, sector reading, and IPL loading.
     * This matches the real hardware boot sequence.
     *
     * For FM77AV: install boot_dos.rom code to RAM $FE00 (since $FE00 reads
     * from mainRAM after Initiator bypass). The sub CPU runs Type-A.
     * For FM-7: $FE00 reads from bootROM directly. No install needed.
     *
     * @returns {number} Start address for main CPU ($FE00)
     */
    _dosBootDirect() {
        const disk = this.fdc.disks[0];
        if (!disk || !disk.loaded) {
            console.error('[BOOT] No disk in drive 0 — falling back to BASIC');
            return this._basicBootBypass();
        }

        // FM-7 only: detect NEW BOOT layout (sec1 expected at $0100).
        // On FM77AV the INITIATE.ROM's NEW BOOT path already handles this,
        // but FM-7's boot_dos.rom only loads to $0300 (OLD BOOT).
        // Detect both formats:
        //   (a) Direct IPL: ORCC #$50 ($1A $50) + LDS #$01xx ($10 $CE $01)
        //   (b) FLEX format: BRA +$20 ($20 $20), then IPL at offset $22
        //       with ORCC #$50 + LDS #$01xx — same pattern, $22 bytes in.
        // Pre-load sectors at NEW BOOT positions and jump to $0100.
        if (!this.isFM77AV) {
            const sec1 = disk.getSector(0, 0, 1);
            if (sec1 && sec1.data && sec1.data.length >= 0x28) {
                const d = sec1.data;
                // Check Direct IPL at offset 0
                const directIPL = d[0] === 0x1A && d[1] === 0x50 &&
                                  d[2] === 0x10 && d[3] === 0xCE && d[4] === 0x01;
                // Check FLEX format: BRA +$20 at offset 0, IPL at offset $22
                const flexIPL = d[0] === 0x20 && d[1] === 0x20 &&
                                d[0x22] === 0x1A && d[0x23] === 0x50 &&
                                d[0x24] === 0x10 && d[0x25] === 0xCE && d[0x26] === 0x01;
                if (directIPL || flexIPL) {
                    // Pre-load T0/S0 sectors 1..16 to $0100-$10FF
                    for (let sec = 1; sec <= 16; sec++) {
                        const s = disk.getSector(0, 0, sec);
                        if (!s || !s.data) break;
                        const base = sec * 0x100;
                        for (let i = 0; i < s.data.length; i++) {
                            this.mainRAM[(base + i) & 0xFFFF] = s.data[i];
                        }
                    }

                    // Parse boot sector parameter tables and pre-load
                    // additional sectors that the IPL would read.
                    // The IPL modifies the sector counters in these tables,
                    // and BASIC ROM reuses them. If we enter at $0100, the
                    // modified tables cause reads of non-existent sectors.
                    // Instead, pre-load everything and skip the IPL.
                    const readParam = (off) => ({
                        type: d[off], bufHi: d[off+2], bufLo: d[off+3],
                        track: d[off+4], sector: d[off+5], side: d[off+6], drive: d[off+7],
                    });
                    const iplBase = flexIPL ? 0x22 : 0x00;
                    // Table offsets relative to sector start:
                    //   $02: Table A, $0A: Table B, $12: Table C (SIR)
                    const tabA = readParam(0x02);
                    const tabB = readParam(0x0A);
                    // Extract loop counts from IPL code.
                    // The IPL code after the SIR check has:
                    //   LDB #countA at iplBase+$17, LDB #countB at iplBase+$31
                    const countA = d[iplBase + 0x18] || 0;
                    const countB = d[iplBase + 0x32] || 0;

                    // Pre-load sectors for Table A
                    if (tabA.type === 0x0A && countA > 0) {
                        let buf = (tabA.bufHi << 8) | tabA.bufLo;
                        let sec = tabA.sector;
                        for (let i = 0; i < countA; i++) {
                            const s = disk.getSector(tabA.track, tabA.side, sec);
                            if (s && s.data) {
                                for (let j = 0; j < s.data.length; j++) {
                                    this.mainRAM[(buf + j) & 0xFFFF] = s.data[j];
                                }
                            }
                            buf += 0x100;
                            sec++;
                        }
                        console.log(`[BOOT]   Table A: ${countA} secs from T${tabA.track} S${tabA.sector} H${tabA.side} → $${((tabA.bufHi<<8)|tabA.bufLo).toString(16).toUpperCase()}`);
                    }
                    // Pre-load sectors for Table B
                    if (tabB.type === 0x0A && countB > 0) {
                        let buf = (tabB.bufHi << 8) | tabB.bufLo;
                        let sec = tabB.sector;
                        for (let i = 0; i < countB; i++) {
                            const s = disk.getSector(tabB.track, tabB.side, sec);
                            if (s && s.data) {
                                for (let j = 0; j < s.data.length; j++) {
                                    this.mainRAM[(buf + j) & 0xFFFF] = s.data[j];
                                }
                            }
                            buf += 0x100;
                            sec++;
                        }
                        console.log(`[BOOT]   Table B: ${countB} secs from T${tabB.track} S${tabB.sector} H${tabB.side} → $${((tabB.bufHi<<8)|tabB.bufLo).toString(16).toUpperCase()}`);
                    }

                    // Install boot_dos.rom code to $FE00 for FDC callbacks
                    // ($FE02 RESTORE, $FE08 read sector).
                    this._installBootROMtoRAM();
                    // Initialize FDC ports as boot_dos.rom would have done.
                    this._initFDCPorts();
                    // Enable timer IRQ ($FD02 bit 2).
                    this._irqMaskReg |= 0x04;

                    // Determine entry point based on IPL type.
                    // BASIC-ROM IPLs have parameter tables (type=$0A) at
                    // offsets $02/$0A. These modify the table counters
                    // during loading, so entering at $0100 would cause
                    // the BASIC ROM to reuse corrupted tables. Jump to
                    // the BASIC ROM cold start instead.
                    // Standalone IPLs (no parameter tables) run their own
                    // code from $0100 and never call into the BASIC ROM.
                    const hasFBasicTables = tabA.type === 0x0A || tabB.type === 0x0A;
                    if (this.romLoaded.fbasic && hasFBasicTables) {
                        const coldStart = (this.fbasicROM[0x7BFE] << 8) | this.fbasicROM[0x7BFF];
                        const dosBase = (tabA.bufHi << 8) | tabA.bufLo;
                        this._bootRegs = { a: 0xFF, x: dosBase };
                        console.log(`[BOOT] FM-7 NEW BOOT (${flexIPL ? 'FLEX' : 'Direct IPL'}): BASIC-ROM IPL, entry $${coldStart.toString(16).toUpperCase()} (X=$${dosBase.toString(16).toUpperCase()})`);
                        return coldStart;
                    }
                    console.log(`[BOOT] FM-7 NEW BOOT (${flexIPL ? 'FLEX' : 'Direct IPL'}): standalone IPL, entry $0100`);
                    return 0x0100;
                }
            }
        }

        // For FM77AV: install boot_dos.rom code into RAM at $FE00-$FFDF.
        // On real hardware, the Initiator ROM copies this from its embedded
        // DOS boot code. We use the standalone boot_dos.rom.
        if (this.isFM77AV) {
            this._installBootROMtoRAM();
        }

        // Some IPLs use absolute addresses designed for $0100 base
        // (sector 1→$0100, sector 2→$0200, ...) but boot_dos.rom loads
        // sector 1→$0300, sector 2→$0400 and JMPs to $0300.
        // Running from $0300 causes self-overwrite when BIOS reads sectors
        // back to $0200+. Detect these IPLs and pre-load at $0100 base,
        // running from $0100 instead of boot_dos.rom.
        if (this._needsIPLPreload(disk)) {
            // Pre-load T0/S0 sectors 1-16 to $0100-$10FF
            for (let sec = 1; sec <= 16; sec++) {
                const s = disk.getSector(0, 0, sec);
                if (!s || !s.data) break;
                const base = sec * 0x100;
                for (let i = 0; i < s.data.length; i++) {
                    this.mainRAM[(base + i) & 0xFFFF] = s.data[i];
                }
            }
            // Install boot_dos.rom to RAM for FDC callbacks ($FE02/$FE08)
            this._installBootROMtoRAM();
            this._initFDCPorts();
            console.log('[BOOT] IPL uses $0100-based addresses: pre-loaded, entry $0100');
            return 0x0100;
        }

        // BOOT_DOS.ROM will handle everything:
        //   1. Set DP=$FD, SP=$FC7F
        //   2. Check $FD05 for key status
        //   3. Read boot sectors from disk via FDC
        //   4. JMP $0300 (IPL entry point)
        //   5. IPL can call back to $FE02/$FE05/$FE08 for more FDC ops
        console.log(`[BOOT] DOS direct: running BOOT_DOS.ROM at $FE00`);
        return 0xFE00;
    }

    /**
     * Detect if boot sector IPL references addresses below $0300.
     * Such IPLs are designed for $0100 base (sector 1→$0100, etc.)
     * and cannot run correctly from boot_dos.rom's $0300 load address.
     * @returns {boolean} true if IPL needs $0100-base pre-loading
     */
    _needsIPLPreload(disk) {
        const sector1 = disk.getSector(0, 0, 1);
        if (!sector1 || !sector1.data) return false;
        const d = sector1.data;

        // Check if sector 1 IPL references addresses in $0020-$02FF.
        // These are absolute references that only work when sectors are
        // loaded at $0100 base (sector 1 at $0100, sector 2 at $0200).
        // Look for extended addressing: BD xx xx (JSR), 7E xx xx (JMP),
        // 8E xx xx (LDX#), FE xx xx (LDU), BE xx xx (LDX), CC xx xx (LDD#)
        for (let i = 0; i < Math.min(d.length, 64); i++) {
            const b = d[i];
            if ((b === 0xBD || b === 0x7E || b === 0x8E || b === 0xBE ||
                 b === 0xFE || b === 0xCC) && i + 2 < d.length) {
                const addr = (d[i + 1] << 8) | d[i + 2];
                if (addr >= 0x0020 && addr < 0x0300) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Install Boot ROM code into mainRAM at $FE00-$FFDF.
     * Required for FM77AV DOS boot: IPL code may call back into Boot ROM
     * FDC routines (e.g. JSR $FE08). Since FM77AV reads $FE00 from mainRAM
     * (Initiator ROM is disabled), the boot code must be present there.
     *
     * Source priority:
     *   1. boot_dos.rom (standalone, always the same code)
     *   2. INITIATE.ROM embedded DOS boot (offset $1A00, identical code)
     */
    _installBootROMtoRAM() {
        // Code area only: $FE00-$FFDF (480 bytes). Vectors at $FFE0+ are
        // already set up separately in reset().
        const codeSize = 0x01E0; // 480 bytes

        if (this.romLoaded.boot) {
            // Use standalone boot_dos.rom
            for (let i = 0; i < codeSize; i++) {
                this.mainRAM[BOOT_ROM_BASE + i] = this.bootROM[i];
            }
            console.log('[BOOT] Installed boot_dos.rom code to RAM $FE00-$FFDF');
        } else if (this.romLoaded.initiate && this._initiateROMSize >= 0x1BC4) {
            // Use INITIATE.ROM embedded DOS boot (offset $1A00)
            for (let i = 0; i < codeSize; i++) {
                this.mainRAM[BOOT_ROM_BASE + i] = this.initiateROM[0x1A00 + i];
            }
            console.log('[BOOT] Installed INITIATE.ROM embedded DOS boot to RAM $FE00-$FFDF');
        } else {
            console.warn('[BOOT] No boot ROM code available — IPL FDC callbacks will fail');
        }
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
        this.fddSound.init(this.psg._audioCtx);

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

        // Final UI update
        if (this._frameCallback) this._frameCallback();

        console.log('FM-7 emulation stopped');
    }

    /**
     * Execute a single emulation frame.
     * Called by requestAnimationFrame. Frame-limited to ~60fps
     * so high-refresh displays (120/360Hz) don't speed up emulation.
     */
    _frame() {
        if (!this._running) return;

        // Wall-clock based pacing: advance emulation by actual elapsed time
        // so that low-refresh-rate rAF environments (30 Hz) still run at real-time speed.
        const now = performance.now();
        const elapsed = now - this._lastFrameTime;
        if (elapsed < 15.5) {
            this._animFrameId = requestAnimationFrame(this._boundFrame);
            return;
        }
        // Clamp to avoid huge catch-up after tab suspension or pauses.
        const simMs = Math.min(elapsed, 50);
        this._lastFrameTime = now;

        // Poll gamepads for joystick input
        this._pollGamepads();

        // Run scheduler for the actual wall-clock interval just elapsed.
        // CMT turbo: run 50x faster only when actively reading a tape
        const cmtTurbo = (this.cmt.motor && this.cmt.loaded) ? 50 : 1;
        try {
            this.scheduler.exec(Math.round(simMs * 1000) * cmtTurbo);
        } catch (e) {
            console.error('Emulation error:', e);
            this.stop();
            return;
        }

        // Render display to canvas
        if (this._canvas) {
            this.display.render(this._canvas);
        }

        // FPS calculation (reuse 'now' from frame limiter above)
        this._fpsCounter++;
        if (now - this._fpsTime >= 1000) {
            this._currentFPS = this._fpsCounter;
            this._fpsCounter = 0;
            this._fpsTime = now;
        }

        // Per-frame callback (UI status update etc.)
        if (this._frameCallback) this._frameCallback();

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
        console.log(`  subMonitorType: ${['C','A','B','CG','D/E'][this._subMonitorType] || this._subMonitorType}`);
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
     * Assign a browser gamepad to an FM-7 joystick port independently.
     * @param {number} fmPort - 0 for Port 1, 1 for Port 2
     * @param {number|null} gamepadIndex - navigator.getGamepads() index, or null to unassign
     */
    setJoystickAssignment(fmPort, gamepadIndex) {
        const p = fmPort & 1;
        this._joystickAssign[p] = (gamepadIndex == null) ? null : (gamepadIndex | 0);
    }

    /** Read a single gamepad into an FM-7 joystick state byte (active low). */
    _readGamepadState(gp) {
        let state = 0xFF;
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
        return state;
    }

    /** Poll Gamepad API and update joystick state based on per-port assignments. */
    _pollGamepads() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        this._gamepadState[0] = 0xFF;
        this._gamepadState[1] = 0xFF;

        for (let fmPort = 0; fmPort < 2; fmPort++) {
            const idx = this._joystickAssign[fmPort];
            if (idx == null) continue;
            const gp = gamepads[idx];
            if (!gp || !gp.connected) continue;
            this._gamepadState[fmPort] = this._readGamepadState(gp);
        }
    }

    // =========================================================================
    // RTC (MS58321) via Key Encoder
    // =========================================================================

    /**
     * Process a byte written to the FM77AV key encoder MCU at sub address
     * $D431. The MCU exposes a multi-protocol command interface with a
     * 16-byte send FIFO. The first byte is the command, subsequent bytes
     * are arguments.
     *
     * Supported commands:
     *   $00 +1: code system switch (0=9BIT FM-7 ASCII, 1=FM16β, 2=SCAN)
     *   $01:    get current code system → 1 byte response
     *   $02 +1: LED set (stub)
     *   $03:    LED get (stub)
     *   $04 +1: key repeat enable (stub)
     *   $05 +2: key repeat time (stub)
     *   $80 +1: RTC sub-protocol
     *           sub=0: get RTC → 7-byte BCD response
     *           sub=1 +7: set RTC (we ignore set; host clock is read-only)
     *   $81-$84: digitize / screen mode / brightness (stubs)
     *
     * The reset/power-on default is KEY_FORMAT_9BIT (FM-7 compatible
     * ASCII with no break codes). Games that need scan codes (e.g. native
     * FM77AV titles) issue command $00 with data $02 to switch.
     */
    _keyEncProcessByte(val) {
        if (!this._keyEncSendBuf) this._keyEncSendBuf = [];
        const buf = this._keyEncSendBuf;
        if (buf.length >= 16) {
            buf.length = 0;
        }
        buf.push(val);

        const finishCmd = () => {
            this._keyEncSendBuf.length = 0;
            this._rtcAck = true; // ACK after command processed (5 us in real HW)
        };

        switch (buf[0]) {
            case 0x00: // Code system switch
                if (buf.length >= 2) {
                    const fmt = buf[1];
                    if (fmt === 0x02) { // SCAN
                        this.keyboard._useScanCodes = true;
                        this.keyboard._enableBreakCodes = true;
                    } else { // 0=9BIT FM-7, 1=FM16β both → ASCII-style
                        this.keyboard._useScanCodes = false;
                        this.keyboard._enableBreakCodes = false;
                    }
                    this._keyEncFormat = fmt;
                    this._keyEncFormatExplicit = true; // game has chosen
                    finishCmd();
                }
                return;
            case 0x01: // Get code system
                this._rtcRxBuf.push(this._keyEncFormat || 0);
                finishCmd();
                return;
            case 0x02: // LED set
            case 0x04: // Repeat enable
                if (buf.length >= 2) finishCmd();
                return;
            case 0x03: // LED get
                this._rtcRxBuf.push(0);
                finishCmd();
                return;
            case 0x05: // Repeat time
                if (buf.length >= 3) finishCmd();
                return;
            case 0x80: // RTC sub-protocol
                if (buf.length >= 2) {
                    if (buf[1] === 0x00) { // get
                        this._rtcEmitGet();
                        finishCmd();
                    } else if (buf[1] === 0x01) { // set (need 9 bytes total)
                        if (buf.length >= 9) finishCmd();
                    } else {
                        finishCmd();
                    }
                }
                return;
            case 0x81: // Digitize
            case 0x82: // Screen mode set
            case 0x84: // Screen brightness
                if (buf.length >= 2) finishCmd();
                return;
            case 0x83: // Screen mode get
                this._rtcRxBuf.push(0);
                finishCmd();
                return;
            default:
                finishCmd();
                return;
        }
    }

    /** Emit current host time as a 7-byte BCD response in _rtcRxBuf. */
    _rtcEmitGet() {
        const now = new Date();
        const bcd = (n) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xFF;
        // RTC response: sec, min, hour, weekday, day, month, year (7 bytes BCD)
        this._rtcRxBuf.push(bcd(now.getSeconds()));
        this._rtcRxBuf.push(bcd(now.getMinutes()));
        this._rtcRxBuf.push(bcd(now.getHours()));
        this._rtcRxBuf.push(now.getDay() & 0xFF);
        this._rtcRxBuf.push(bcd(now.getDate()));
        this._rtcRxBuf.push(bcd(now.getMonth() + 1));
        this._rtcRxBuf.push(bcd(now.getFullYear() % 100));
    }

    /**
     * Legacy stub kept for any code path that still calls it. The new
     * keyboard MCU command interface handles RTC via cmd $80.
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

    // =========================================================================
    // Debug: BASIC program area dump (bypasses ROM overlay)
    // =========================================================================

    /**
     * Dump the BASIC program lines from RAM (bypasses ROM overlay).
     * Call from browser console: fm7.dumpBasicProgram()
     */
    dumpBasicProgram() {
        // Use _mainRead() to go through MMR mapping (BASIC V3.3 uses MMR)
        const rd = (a) => this._mainRead(a);
        const txttab = (rd(0x19) << 8) | rd(0x1A);
        const vartab = (rd(0x1B) << 8) | rd(0x1C);
        console.log(`TXTTAB=$${txttab.toString(16)}, VARTAB=$${vartab.toString(16)}, ROM=${this._basicRomEnabled?'ON':'OFF'}, MMR=${this._mmrEnabled?'ON':'OFF'}`);
        if (this._mmrEnabled) {
            const seg0 = this._mmrReg[this._mmrSegment * 16];
            console.log(`MMR seg=${this._mmrSegment} bank0=page$${seg0.toString(16)}`);
        }
        console.log(`Trampoline $0260: ${[rd(0x260),rd(0x261),rd(0x262)].map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);

        let addr = txttab;
        let lineCount = 0;
        const maxLines = 200;
        while (addr > 0 && addr < 0xFFFF && lineCount < maxLines) {
            const nextHi = rd(addr), nextLo = rd(addr + 1);
            const next = (nextHi << 8) | nextLo;
            if (next === 0) { console.log(`  $${addr.toString(16)}: END (00 00)`); break; }
            const lineNum = (rd(addr + 2) << 8) | rd(addr + 3);
            const lineLen = next - addr;
            const crossesROM = addr < 0x8000 && next >= 0x8000;
            const inROM = addr >= 0x8000 && addr < 0xFC00;
            let flag = '';
            if (crossesROM) flag = ' ** CROSSES $8000 **';
            if (inROM) flag = ' [ROM AREA]';
            console.log(`  $${addr.toString(16)}: line ${lineNum}, next=$${next.toString(16)}, len=${lineLen}${flag}`);
            lineCount++;
            addr = next;
        }
        console.log(`Total: ${lineCount} lines`);
    }

    /**
     * Enable FDC + ROM toggle tracing.
     * Call before LOAD: fm7.enableLoadTrace()
     * After LOAD: fm7.showLoadTrace()
     */
    enableLoadTrace() {
        this._loadTrace = [];
        this._loadTraceEnabled = true;
        this._loadTraceRomState = this._basicRomEnabled;

        // Enable FDC built-in log
        this.fdc.logEnabled = true;
        this.fdc.log = [];
        this.fdc._logCycle = 0;

        // Patch FDC readIO to trace $FD1B reads and $FD18 status reads
        if (!this._origFdcReadIO) {
            this._origFdcReadIO = this.fdc.readIO.bind(this.fdc);
        }
        const origReadIO = this._origFdcReadIO;
        const self = this;
        this.fdc.readIO = function(addr) {
            const val = origReadIO(addr);
            if (self._loadTraceEnabled) {
                if (addr === 0xFD1B) {
                    self._loadTrace.push({ t: 'FDC_R', pc: self.mainCPU.pc, val });
                } else if (addr === 0xFD1F) {
                    const drq = val & 0x80 ? 1 : 0;
                    const irq = val & 0x40 ? 1 : 0;
                    if (drq || irq) {
                        self._loadTrace.push({ t: 'DRQ', pc: self.mainCPU.pc, drq, irq });
                    }
                } else if (addr === 0xFD18) {
                    self._loadTrace.push({ t: 'STA', pc: self.mainCPU.pc, val });
                }
            }
            return val;
        };

        // Also patch FDC writeIO to capture commands
        if (!this._origFdcWriteIO) {
            this._origFdcWriteIO = this.fdc.writeIO.bind(this.fdc);
        }
        const origWriteIO = this._origFdcWriteIO;
        this.fdc.writeIO = function(addr, val) {
            if (self._loadTraceEnabled) {
                if (addr === 0xFD18) {
                    self._loadTrace.push({ t: 'CMD', pc: self.mainCPU.pc, val,
                        desc: self._fdcCmdName(val) });
                } else if (addr === 0xFD1A) {
                    self._loadTrace.push({ t: 'SEC', pc: self.mainCPU.pc, val });
                } else if (addr === 0xFD19) {
                    self._loadTrace.push({ t: 'TRK', pc: self.mainCPU.pc, val });
                } else if (addr === 0xFD1B) {
                    self._loadTrace.push({ t: 'DAT', pc: self.mainCPU.pc, val });
                }
            }
            return origWriteIO(addr, val);
        };

        console.log('Load trace enabled. Type LOAD"README" then call fm7.showLoadTrace()');
    }

    _fdcCmdName(cmd) {
        const hi = cmd & 0xF0;
        if (hi === 0x00) return 'RESTORE';
        if (hi === 0x10) return 'SEEK';
        if (hi <= 0x30) return 'STEP';
        if (hi <= 0x50) return 'STEP-IN';
        if (hi <= 0x70) return 'STEP-OUT';
        if (hi === 0x80 || hi === 0x90) return `READ_SEC${cmd & 0x10 ? '(M)' : ''}`;
        if (hi === 0xA0 || hi === 0xB0) return `WRITE_SEC${cmd & 0x10 ? '(M)' : ''}`;
        if (hi === 0xC0) return 'READ_ADDR';
        if (hi === 0xD0) return 'FORCE_INT';
        if (hi === 0xE0) return 'READ_TRK';
        if (hi === 0xF0) return 'WRITE_TRK';
        return '???';
    }

    showLoadTrace() {
        this._loadTraceEnabled = false;
        this.fdc.logEnabled = false;
        const trace = this._loadTrace || [];
        const fdcLog = this.fdc.log || [];

        // Summary
        const fdcReads = trace.filter(e => e.t === 'FDC_R');
        const cmds = trace.filter(e => e.t === 'CMD');
        const romOn = trace.filter(e => e.t === 'ROM_ON');
        const romOff = trace.filter(e => e.t === 'ROM_OFF');
        console.log(`=== LOAD Trace Summary ===`);
        console.log(`FDC data reads ($FD1B): ${fdcReads.length}`);
        console.log(`FDC commands: ${cmds.length}`);
        console.log(`ROM ON events: ${romOn.length}, ROM OFF events: ${romOff.length}`);

        // Show FDC commands with context
        console.log(`\n=== FDC Commands ===`);
        for (const e of cmds) {
            console.log(`  PC=$${e.pc.toString(16)}: ${e.desc} ($${e.val.toString(16).padStart(2,'0')})`);
        }

        // Show FDC built-in log (CMD/DONE entries only for conciseness)
        console.log(`\n=== FDC Log (CMD/DONE/SEC_END) ===`);
        for (const e of fdcLog) {
            if (e.t === 'CMD') {
                console.log(`  [${e.cyc}] ${e.cmd} trk=${e.trk} sec=${e.sec} drv=${e.drv} side=${e.side} pos=${e.pos}`);
            } else if (e.t === 'DONE') {
                console.log(`  [${e.cyc}] DONE ${e.cmd} status=${e.status} ${e.flags} bytes=${e.bytes}${e.lostBytes ? ' LOST=' + e.lostBytes : ''}`);
            } else if (e.t === 'SEC_END') {
                console.log(`  [${e.cyc}] SEC_END bytes=${e.readBytes} next=${e.nextSec}${e.lostBytes ? ' LOST=' + e.lostBytes : ''}`);
            } else if (e.t === 'FIND_RNF') {
                console.log(`  [${e.cyc}] RNF! physTrk=${e.physTrk} side=${e.side} sec=${e.sec}`);
            }
        }

        // Show ROM toggle events
        console.log(`\n=== ROM Toggle Events (first 20) ===`);
        const romEvents = trace.filter(e => e.t === 'ROM_ON' || e.t === 'ROM_OFF');
        for (const e of romEvents.slice(0, 20)) {
            console.log(`  PC=$${e.pc.toString(16)}: ${e.t}`);
        }
        if (romEvents.length > 20) console.log(`  ... (${romEvents.length - 20} more)`);

        // Show first data bytes read
        console.log(`\n=== First 32 data bytes ===`);
        const bytes = fdcReads.slice(0, 32).map(e => e.val.toString(16).padStart(2, '0'));
        console.log(`  ${bytes.join(' ')}`);
        const ascii = fdcReads.slice(0, 32).map(e =>
            e.val >= 0x20 && e.val < 0x7F ? String.fromCharCode(e.val) : '.'
        ).join('');
        console.log(`  "${ascii}"`);

        // Show status reads with error bits
        const staReads = trace.filter(e => e.t === 'STA');
        if (staReads.length > 0) {
            console.log(`\n=== Status Register Reads ($FD18) ===`);
            for (const e of staReads.slice(0, 20)) {
                const flags = [];
                if (e.val & 0x80) flags.push('NOT_READY');
                if (e.val & 0x10) flags.push('RNF');
                if (e.val & 0x08) flags.push('CRC');
                if (e.val & 0x04) flags.push('LOST');
                if (e.val & 0x02) flags.push('DRQ');
                if (e.val & 0x01) flags.push('BUSY');
                if (e.val & 0x20) flags.push('RECORD_TYPE');
                console.log(`  PC=$${e.pc.toString(16)}: $${e.val.toString(16).padStart(2,'0')} ${flags.join('|') || 'OK'}`);
            }
        }

        // BASIC program state
        console.log(`\n=== Post-LOAD BASIC program ===`);
        this.dumpBasicProgram();
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
