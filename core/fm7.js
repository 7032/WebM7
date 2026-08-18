// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
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
import { usToCycles, cyclesToUs, setCPUClock, getSubCycleRatio } from './scheduler.js';
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
export const MACHINE_FM77AV20   = 'fm77av20';
export const MACHINE_FM77AV20EX = 'fm77av20ex';
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
        this._mmrFastMode = false;   // $FD95 bit 3: high-speed MMR (AV40EX only)
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

        // --- Real-hardware faithfulness ---
        // There is only one real FM-7/FM77AV, so faithful behaviour is the
        // default, not an opt-in mode.  These flags exist only as an internal
        // escape hatch / test seam; out of the box the emulator behaves like
        // the hardware.  When a faithful check catches an access that would be
        // dead on real hardware it calls onHwWarn(code, message).
        //
        // Verified ON (in-browser play across real titles shows no regression):
        //   romWriteProtect, keyEncHandshake  -> default ON.
        // NOTE: a "hide $FD04 bit1 BREAK status" idea was tried and removed.
        // Software reads BREAK by polling $FD04 bit1 (documented FM-7 keyboard
        // hardware behavior), so the status bit is ALWAYS exposed and is not
        // configurable.  See _mainIORead $FD04.
        // fdcSpinup is left OFF: as currently modelled it makes the FM77AV
        // INITIATE boot read before the spin-up window elapses and collapses
        // the boot.  Enabling it needs the boot-path timing reconciled first.
        this.hwStrict = {
            romWriteProtect: true,  // writes to $8000-$FBFF ignored while ROM overlay active
            keyEncHandshake: true,  // code-system switch needs the $D432 ENCSTA handshake
            fdcSpinup:       false, // cold motor spin-up — parked (breaks AV boot, see above)
        };
        this.onHwWarn = null;       // (code, message) => void
        this._bootMode    = 'basic'; // 'dos' or 'basic' (current active mode)
        this._bootModeOverride = 'basic'; // 'basic' | 'dos' — machine mode selection
        this._bootModeExplicit = false;   // true once the user picks a mode; FM77AV honors it then
        this.romAdjust = true;            // false: skip compatibility ROM adjustments / boot assists (set before reset())
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
        this._vsyncFlag       = false;   // TRUE only during the VSYNC pulse (510μs / 330μs) — $FD12 bit 0
        this._vsyncPhase      = 0;       // 0 = V-active, 1 = vfp, 2 = vsync pulse, 3 = vbp
        this._inVBlank        = false;   // TRUE during entire V-blank period (vfp + vsync + vbp) — $FD12 bit 1
        this._blankFlag       = false;   // TRUE=horizontal blanking active
        // FM-7 only: CRT scan steals VRAM cycles from sub CPU during active
        // display, dropping its effective rate from 2.0 MHz to ~0.75 MHz
        // (sub gets 384 of every 1024 VRAM bus cycles per scanline). FM77AV+
        // has separate VRAM bus and is not affected.
        // 1024/384 inflation = sub CPU cycle accounting grows ~2.667x faster.
        this._fm7SubCycleSteal = 1024 / 384; // ≈ 2.667
        this._fm7HBlankCounter = 0;          // FM-7 H-blank phase tracker
        // Last mainCyclesTotal already converted into the sub cycle budget
        // (see the exec override). Lets the budget include DMA bus-seizure
        // padding and error-skip cycles without double counting.
        this._subBudgetMainMark = 0;
        this._subNmiDelay     = 0;       // Cycles to delay NMI after sub CPU reset (INTR_SLOAD emulation)
        this._subNmiPending   = false;   // 20ms NMI edge latched while sub CPU was halted
        // FM77AV key encoder MCU at sub $D431/$D432 (see _keyEncProcessByte)
        this._rtcRxBuf = [];      // Sub-side response buffer (read via $D431)
        this._rtcAck = false;     // ACK flag (cleared on $D432 read)
        this._keyEncSendBuf = []; // MCU command FIFO (write via $D431)
        this._keyEncFormat = 0;   // 0=9BIT FM-7 ASCII, 1=alt-ASCII, 2=SCAN
        this._keyEncNeedsRead = false; // strict: ENCSTA ($D432) must be polled between command bytes

        // BEEP
        this._beepOsc = null;
        this._beepGain = null;
        this._beepTimer = null;
        this._beepContinuous = false;
        this._speakerFlag = false;     // $FD03 bit 0 — speaker enable latch

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
        // DMAC HD6844 ($FD98-$FD99) — FM77AV40/AV40EX only.
        // Channel 0 is the FDC DMA channel; ch1-3 are used for data chaining.
        this._dmaReg       = 0;                  // currently selected register number
        this._dmaAdr       = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];   // 16-bit address regs
        this._dmaBcr       = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];   // 16-bit byte-count regs
        this._dmaChcr      = [0, 0, 0, 0];       // 8-bit channel control regs
        this._dmaPcr       = 0;                  // priority control reg ($14)
        this._dmaIcr       = 0;                  // interrupt control reg ($15)
        this._dmaDcr       = 0;                  // data chain control reg ($16)
        this._dmaFlag      = false;              // active transfer
        this.dmaActivityLatch = false;           // UI: a DMA byte moved since last poll (consumer clears)
        this._dmaBurst     = false;              // burst mode active
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
        // FM77AV: used for periodic timer IRQ.
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
        // Timers explicitly started by the guest (mode-select START / counter load).
        // Only consulted for the mouse-timer path (see _ptmTick); leaves the
        // legacy internal-clock tick untouched when the mouse is disabled.
        this._ptmRunning = [false, false, false];
        this._ptmMouseClkAcc = 0;              // accumulator for the ~19.2 kHz C-clock feed

        // --- Mouse (all machines) ---
        // Two protocols share one browser-side movement accumulator:
        //
        //  1) Bus mouse ("mouse set") at $FDE8 — single register, available
        //     on every machine as an external mouse set. A write with
        //     the low two bits set latches the pending movement (sign-INVERTED
        //     int8) and resets the phase; each read returns the next nibble
        //     (4 reads = one sample) in the order X-lo, X-hi, Y-lo, Y-hi, with
        //     the buttons in bit 4-5 and bit 7 always high while connected.
        //     Its periodic polling interrupt is generated by the PTM, whose
        //     counters are fed a ~19.2 kHz clock while the mouse is connected.
        //
        //  2) Intelligent mouse via the OPN joystick port (FM sound card on
        //     the FM-7, on-board OPN on the FM77AV family) — a level change on
        //     OPN reg 15 bit 4 (port 1) / bit 5 (port 2) strobes the phase.
        //     Movement is latched at phase 0 (NOT sign-inverted); a port-A read
        //     with matching reg-15 direction bits returns the next nibble in the
        //     order X-hi, X-lo, Y-hi, Y-lo with trigger-masked buttons.
        //
        // Exactly one device is connected at a time (_mouseMode). The
        // protocol that is not selected answers as "not connected", the same
        // as an unplugged connector; the protocol handling itself is shared.
        this._mouseMode     = 'none';  // 'none' | 'bus' | 'intel1' | 'intel2'
        this._mouseEnabled  = false;   // derived: _mouseMode !== 'none'
        this._mouseBtn      = 0x30;    // bit4 left, bit5 right; active low (bit set = released)
        this._mouseAccDX    = 0;       // browser-side pending movement (X)
        this._mouseAccDY    = 0;       // browser-side pending movement (Y)
        // Bus mouse ($FDE8) state
        this._mouseBusPhase = 0;
        this._mouseBusDX    = 0;       // sign-inverted latched byte
        this._mouseBusDY    = 0;
        // Intelligent mouse (joystick port) state
        this._intelMousePort  = 1;     // 1 = OPN joystick port 1 (default), 2 = port 2
        this._mouseIntelPhase = 0;
        this._mouseIntelDX    = 0;     // raw latched byte (not sign-inverted)
        this._mouseIntelDY    = 0;
        this._mouseIntelStrobe = false;
        this._mouseIntelLastEdge = 0;  // mainCyclesTotal at the last strobe edge

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

        // $FC80-$FCFF: Shared RAM (dual-port) — main CPU side read is valid only
        // while the sub CPU is HALTed; otherwise reads 0xFF. On real hardware the
        // dual-port bus arbitration gates main-side access to the sub HALT state.
        if (addr >= SHARED_RAM_BASE && addr <= SHARED_RAM_END) {
            if (this._subHalted) {
                return this.sharedRAM[addr - SHARED_RAM_BASE];
            }
            return 0xFF;
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            return this._mainIORead(addr);
        }

        // $FE00-$FFFF: Boot ROM area
        // (The initiator ROM overlay, when active, is handled earlier.)
        if (addr >= BOOT_ROM_BASE) {
            // $FFE0-$FFFF: Interrupt vectors in RAM
            if (addr >= 0xFFE0) {
                return this.mainRAM[addr];
            }
            // $FE00-$FFDF
            // FM77AV: once the initiator overlay is off, this area is RAM.
            if (this.isFM77AV) {
                return this.mainRAM[addr];
            }
            // FM-7 $FE00-$FFDF: the boot ROM visible here is chosen by the boot
            // mode. BASIC mode shows the BASIC-mode boot ROM, DOS mode the
            // DOS-mode boot ROM. Vectors ($FFE0+) always come from RAM (above).
            if (this._bootMode === 'basic' && this.romLoaded.bootBas) {
                return this.bootBasROM[addr - BOOT_ROM_BASE];
            }
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
            // Strict: while the BASIC ROM overlay is active over $8000-$FBFF,
            // real hardware does NOT latch writes to that window — the byte is
            // lost until $FD0F selects the underlying RAM.  Lenient default
            // passes the write through, which hides a missing $FD0F.
            if (this.hwStrict.romWriteProtect &&
                addr >= 0x8000 && this._basicRomEnabled && this.romLoaded.fbasic) {
                this._hwWarn('rom-overlay-write',
                    `write $${val.toString(16).padStart(2,'0')} to $${addr.toString(16).toUpperCase()} ignored: BASIC ROM overlay active (set $FD0F to map RAM first)`);
                return;
            }
            this.mainRAM[addr] = val;
            return;
        }

        // $FC00-$FC7F: RAM
        if (addr < SHARED_RAM_BASE) {
            this.mainRAM[addr] = val;
            return;
        }

        // $FC80-$FCFF: Shared RAM (dual-port) — main CPU side write is valid only
        // while the sub CPU is HALTed; otherwise dropped. On real hardware the
        // dual-port bus arbitration gates main-side access to the sub HALT state.
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
            // Software uses this bit to determine the CPU speed
            val |= 0x01;  // FM-7 runs at 1.794MHz (normal speed)
            return val;
        }
        if (addr === FD01_KEY_DATA) {
            return this.keyboard.readIO(addr);
        }

        // $FD02 read: bit 7 = cassette data input, bit 1 = printer, bit 0 = printer ACK
        if (addr === FD02_KEY_IRQ_MASK) {
            let val = 0x7F; // bit 7 = 0 by default
            // bit 7: cassette data input (from tape)
            val = (val & ~0x80) | this.cmt.readDataBit();
            return val;
        }

        // IRQ status ($FD03 read) - active low: 0 = pending, read clears flags
        // bit 0: keyboard, bit 1: printer, bit 2: timer, bit 3: extended (OPN/DMA/PTM)
        //
        // Hardware behaviour: bit 0 is gated by the keyboard IRQ mask
        // ($FD02 bit 0).  When the mask is set (= IRQ disabled, the
        // power-on default), bit 0 reads 1 even when a key has arrived,
        // and software cannot detect keystrokes until it writes $FD02 #$01
        // to release the mask.  Earlier revisions ungated this bit and
        // accepted keystrokes regardless of the mask, which let software
        // run without ever initialising the mask register — a behaviour
        // that diverged from real hardware.
        if (addr === FD03_IRQ_STATUS) {
            let status = 0xFF;
            if (this.keyboard._irqFlag && this.keyboard._irqMask === 0) {
                status &= ~0x01;
            }
            if (this._timerIRQ) {
                status &= ~0x04;
                this._timerIRQ = false;
            }
            // bit 3: extended interrupt (OPN timer A/B overflow).
            // $FD03 read only reports the flag; it does NOT clear the OPN
            // IRQ source. The IRQ is acknowledged by writing OPN register
            // $27 with reset bits ($10/$20), which clears the OPN status —
            // our auto-clear path then drops the latch.
            if (this._opnIrqLatch) status &= ~0x08;
            return status;
        }

        // $FD17: Extended IRQ status (active low, FM77AV)
        // bit 3 (0x08): OPN timer A or B IRQ pending
        // bit 2 (0x04): PTM IRQ pending
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
            // bit 1 = break key (active low: 0=pressed, 1=not pressed).
            // Software detects BREAK by polling this bit (documented FM-7
            // hardware behavior), so it is always exposed — the FIRQ path
            // coexists with it, it does not replace it.
            if (this._breakKey) ret &= ~0x02;
            return ret;
        }

        // Sub CPU status ($FD05 read)
        // bit 7 = BUSY (1=busy / halted, 0=ready). bit 0 = EXTDET.
        // Hardware semantics: BUSY is asserted both when the sub CPU
        // sets the BUSY latch ($D40A write) AND while HALT is
        // acknowledged (main CPU has acquired the sub bus). The HALT
        // protocol — main writes $FD05=$80 then polls $FD05 until bit7=1
        // — relies on the latter, so the read must reflect _subHalted
        // directly rather than depend on _subHaltAck having already
        // re-set the _subBusy latch.
        if (addr === FD05_SUB_CTRL) {
            // Returns $FF (busy) / $7F (not busy) on FM77AV (bit 0=1,
            // no EXTDET). On FM-7 with FDC, bit 0 is cleared → $FE/$7E.
            // With bit 0=1 the FM77AV start-up sequence follows a path
            // this emulator does not support yet. Keep bit 0=0 for all
            // models (matches FM-7 EXTDET=detected) until that path is
            // fully supported.
            this._subBusyWasCleared = false;
            return (this._subHalted || this._subBusy) ? 0xFE : 0x7E;
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
        // bit 1: blank_flag (0 when V-blank OR H-blank active — negative logic)
        // bit 0: vsync_flag (1 during VSYNC pulse only)
        if (addr === FD12_SUB_MONITOR && this.isFM77AV) {
            let ret = 0xFF;
            if (this.display.displayMode === 1) ret |= 0x40; else ret &= ~0x40;
            // bit 1: clear when in V-blank (vfp+vsync+vbp) OR when in HBlank
            if (this._inVBlank || this._blankFlag) ret &= ~0x02;
            // bit 0: clear when NOT in VSYNC pulse
            if (!this._vsyncFlag) ret &= ~0x01;
            return ret;
        }

        // FM77AV: $FD30-$FD34 read — analog palette read-back
        // $FD30/$FD31 (address regs) are write-only → 0xFF.
        // $FD32-$FD34 (B/R/G nibbles) read only on AV20/AV40+; plain FM77AV → 0xFF.
        if (this.isFM77AV && addr >= 0xFD30 && addr <= 0xFD34) {
            if (addr === 0xFD30 || addr === 0xFD31) return 0xFF;
            if (!this.hasPaletteReadback) return 0xFF;
            const idx = this._analogPaletteAddr & 0xFFF;
            const entry = this._analogPalette[idx];
            switch (addr) {
                case 0xFD32: return 0xF0 | (entry & 0x0F);          // Blue
                case 0xFD33: return 0xF0 | ((entry >> 4) & 0x0F);   // Red
                case 0xFD34: return 0xF0 | ((entry >> 8) & 0x0F);   // Green
            }
        }

        // FDC registers ($FD18-$FD1F)
        if (addr >= FDC_IO_BASE && addr <= FDC_IO_END) {
            // Reading $FD18 (status) clears the FDC IRQ latch
            if (addr === FDC_IO_BASE) this._fdcIrqLatch = false;
            return this.fdc.readIO(addr);
        }

        // $FD37: Multi-page register — write-only on real hardware; reads as 0xFF.
        if (addr === 0xFD37) {
            return 0xFF;
        }

        // $FD38-$FD3F: TTL palette read — top nibble reads as 0xF (open bus).
        // AV40EX uses only lower 3 bits; FM-7/FM77AV (MB15021) uses lower 4 bits.
        if (addr >= 0xFD38 && addr <= 0xFD3F) {
            const p = this.display.readPalette(addr - 0xFD38);
            return this.isAV40EX ? (0xF0 | (p & 0x07)) : (0xF0 | (p & 0x0F));
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

        // Bus mouse ($FDE8) — mouse set available on all machines. When
        // disabled the read returns the "not connected" sentinel ($80,
        // bit 7 high).
        if (addr === 0xFDE8) {
            return this._mouseBusRead();
        }

        // MIDI USART stub at $FDE9-$FDEB (FM77AV+).
        // Status register $FDEB returns TX ready / RX empty. Data register
        // $FDEA returns 0xFF (no MIDI input source). Software that probes
        // the USART for device presence sees a "ready, no data" channel.
        if (this.isFM77AV && addr === 0xFDEA) return 0xFF;
        if (this.isFM77AV && addr === 0xFDEB) return 0x07;
        if (this.isFM77AV && addr === 0xFDE9) return 0xFF;

        // FM77AV40: RD512 registers ($FD40-$FD4F)
        // $FD40-$FD41: sector register (write-only), $FD48-$FD4F: data window
        if (this.isAV40 && addr >= 0xFD40 && addr <= 0xFD4F) {
            return 0xFF; // No ext RAM installed
        }

        // FM77AV40: CRTC MB89321 ($FD96-$FD97) — NOP on AV40
        if (this.isAV40 && (addr === 0xFD96 || addr === 0xFD97)) {
            return 0xFF;
        }

        // FM77AV40: DMAC HD6844 ($FD98 register select / $FD99 data)
        if (this.hasDMAC && addr === 0xFD98) return this._dmaReg & 0xFF;
        if (this.hasDMAC && addr === 0xFD99) return this._dmacReadReg(this._dmaReg);

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

        // $FD03 write: BEEP/speaker control
        // bit 7: continuous BEEP, bit 6: single BEEP (205ms), bit 0: speaker flag
        //
        // Hardware behaviour:
        // bit 0 latches the speaker flag.  bit 6 takes priority: when set,
        // a single 205ms BEEP fires and bit 7 is ignored.  Only when bit 6
        // is clear does bit 7 control continuous BEEP on/off.
        // An earlier revision ran bit 6 and bit 7 in parallel and only
        // stopped continuous BEEP if it was already running, which diverged
        // from the real hardware state machine.
        if (addr === FD03_IRQ_STATUS) {
            this._speakerFlag = (val & 0x01) !== 0;
            if (val & 0x40) {
                // Single BEEP: 205ms tone, bit 7 ignored.
                this._beepStart(205);
            } else if (val & 0x80) {
                // Continuous BEEP on.
                this._beepStart(-1);
            } else {
                // BEEP off (no-op if already off).
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
        // The overlay can be toggled both ways (software may temporarily
        // re-enable it), so both transitions are supported.
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
                    // DOS boot: leave the BASIC ROM overlay alone — the ROM
                    // start-up code switches it on its own. Forcing the overlay
                    // off here breaks IPLs that rely on the original memory
                    // state at handoff (some titles require $8000-$FBFF mapping).
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
                this.display._analogDirty = true;
                this.display._fullDirty = true;
                this.display._pushScrollTrace('PAL_B', { idx, val: val & 0x0F });
                return;
            }
            if (addr === FD33_APAL_RED) {
                // Red data for current palette entry → bits 4-7
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0xF0F) | ((val & 0x0F) << 4);
                this.display._analogDirty = true;
                this.display._fullDirty = true;
                this.display._pushScrollTrace('PAL_R', { idx, val: val & 0x0F });
                return;
            }
            // $FD34: Green data for current palette entry → bits 8-11
            if (addr === 0xFD34) {
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0x0FF) | ((val & 0x0F) << 8);
                this.display._analogDirty = true;
                this.display._fullDirty = true;
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
                // PSG-compat mirror of OPN command port — only lower 2 bits valid.
                this._opnWriteCmd(val & 0x03);
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

        // Bus mouse ($FDE8) — mouse set available on all machines. A write
        // latches the pending movement and resets the read phase.
        if (addr === 0xFDE8) {
            this._mouseBusWrite(val);
            return;
        }

        // MIDI USART stub: writes are accepted (TX byte simulated as sent).
        if (this.isFM77AV && (addr === 0xFDE9 || addr === 0xFDEA || addr === 0xFDEB)) {
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

        // FM77AV40: DMAC HD6844 ($FD98 register select / $FD99 data)
        if (this.hasDMAC && addr === 0xFD98) { this._dmaReg = val & 0xFF; return; }
        if (this.hasDMAC && addr === 0xFD99) { this._dmacWriteReg(this._dmaReg, val); return; }

        // FM77AV: MMR registers ($FD80-$FD9F)
        if (this.isFM77AV && addr >= 0xFD80 && addr <= 0xFD9F) {
            // $FD93: MMR/TWR control register
            // bit 7: MMR enable, bit 6: TWR enable
            if (addr === FD93_MMR_CTRL) {
                this._mmrEnabled = (val & 0x80) !== 0;
                this._twrFlag = (val & 0x40) !== 0;
                this._bootramRW = (val & 0x01) !== 0;
                this._updateMainCpuClock();
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
            // $FD95: Mode select 2
            //   bit7 = extrom_sel (EXTSUB.ROM bank select) — AV40EX only
            //   bit3 = high-speed MMR (suppresses MMR slowdown) — AV20EX/AV40EX
            if (addr === 0xFD95) {
                if (this.hasFastMMR) {
                    if (this.isAV40EX) {
                        this._extromSel = !!(val & 0x80);
                    }
                    this._mmrFastMode = !!(val & 0x08);
                    this._updateMainCpuClock();
                    if (this._dbgTraceMMR) {
                        console.log(`[FD95] val=$${val.toString(16).padStart(2,'0')} extromSel=${this._extromSel} fastMMR=${this._mmrFastMode}`);
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

            // $D400: Keyboard high byte (mirrors main CPU $FD00).
            // Returns 0xFF if last key has bit 8 set (PF/break-class), else 0x7F.
            // Cancel signaling is via $D402 (cancelAck) + main CPU $FD05 write.
            if (ioAddr === 0xD400) {
                return this.keyboard.readIO(0xFD00);
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
                // $D40A read: Clear BUSY flag side effect only; data bus reads as 0xFF.
                this._subBusy = false;
                this._subBusyWasCleared = true;
                return 0xFF;
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
            // bit 7: blank_flag (0 when V-blank or H-blank active)
            // bit 4: line_busy (0 when line drawing active)
            // bit 2: vsync_flag (0 when NOT in VSYNC pulse)
            // bit 0: subreset_flag (0 when sub CPU NOT reset)
            if (addr === 0xD430) {
                let ret = 0xFF;
                // bit 7: clear when in V-blank (vfp+vsync+vbp) OR H-blank
                if (this._inVBlank || this._blankFlag) {
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
                // ENCSTA was polled — satisfies the inter-byte handshake.
                this._keyEncNeedsRead = false;
                return val;
            }
            // $D433: AV40EX VRAM block select (write-only — reads return $FF)
            // $D434-$D43F: Other FM77AV registers
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
            // The $D000 busy/ready byte is maintained by sub CPU code.
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

            // $D404 (write): sub→main attention FIRQ trigger.
            // This register does NOT control display mode / 262K-color /
            // sub-RAM protect / kanji-ROM connection — those are owned
            // exclusively by the main-side $FD04. Writing here only raises
            // the sub-attention line, identical to the $D404 read path.
            if (ioAddr === 0xD404 && this.isAV40) {
                this._subAttn = true;
                this.mainCPU.firq();
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
                    this._subNmiPending = false;
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
            // $D433: AV40EX VRAM block select — selects front/back block for 2-page
            // 400-line / 262K / 4096-color modes.
            //   bit 0: active block (write target: 0=front, 1=back)
            //   bit 4: display block (renderer source: 0=front, 1=back)
            if (addr === 0xD433 && this.isAV40EX) {
                const newActive  = val & 0x01;
                const newDisplay = (val >> 4) & 0x01;
                if (this.display.blockDisplay !== newDisplay) {
                    this.display.blockDisplay = newDisplay;
                    this.display._fullDirty = true;
                }
                this.display.blockActive = newActive;
                return;
            }
            // $D438-$D43F: AV40EX hardware window (8-byte window-coord register file)
            // Inside the rectangle [x1,x2) × [y1,y2), renderer reads from the
            // *alternate* block (swapped w.r.t. blockDisplay). Used by programs
            // that split decoration (front) and dynamic content (back).
            //   $D438 X1 hi (bits 0-1 → X bit8-9)    $D439 X1 lo (bits 3-7 → X bit3-7, bit0-2 = 0)
            //   $D43A X2 hi                            $D43B X2 lo
            //   $D43C Y1 hi (bit 0 → Y bit8)          $D43D Y1 lo (bit 0-7)
            //   $D43E Y2 hi                            $D43F Y2 lo
            if (addr >= 0xD438 && addr <= 0xD43F && this.isAV40EX) {
                const d = this.display;
                switch (addr & 7) {
                    case 0: d.windowX1 = (d.windowX1 & 0x00F8) | ((val & 0x03) << 8); break;
                    case 1: d.windowX1 = (d.windowX1 & 0x0300) | (val & 0xF8);        break;
                    case 2: d.windowX2 = (d.windowX2 & 0x00F8) | ((val & 0x03) << 8); break;
                    case 3: d.windowX2 = (d.windowX2 & 0x0300) | (val & 0xF8);        break;
                    case 4: d.windowY1 = (d.windowY1 & 0x00FF) | ((val & 0x01) << 8); break;
                    case 5: d.windowY1 = (d.windowY1 & 0x0100) | val;                 break;
                    case 6: d.windowY2 = (d.windowY2 & 0x00FF) | ((val & 0x01) << 8); break;
                    case 7: d.windowY2 = (d.windowY2 & 0x0100) | val;                 break;
                }
                d.windowOpen = (d.windowX1 < d.windowX2) && (d.windowY1 < d.windowY2);
                d._fullDirty = true;
                return;
            }
            // $D434-$D437: Other FM77AV registers
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

                // DMAC HD6844: drains FDC DRQ to memory while a transfer is
                // active. Burst-mode bus seizure adds extra main CPU cycles.
                if (this.hasDMAC) {
                    const dmaCycles = this._dmacExec(mainElapsed);
                    if (dmaCycles > 0) this.scheduler.mainCyclesTotal += dmaCycles;
                }

                // VSYNC pulse timing is driven by scheduler event (2-phase).
                // HBlank timing: line period ≈63.5μs (127 cycles @2MHz)
                // HBlank = 24μs (48 cycles), display = 39-40μs (79 cycles)
                if (this.isFM77AV) {
                    this._hblankCounter = ((this._hblankCounter || 0) + mainElapsed) % 127;
                    this._blankFlag = this._hblankCounter >= 79;
                } else {
                    // FM-7: track HBlank phase too so cycle-steal slowdown
                    // applies only during the active 39-40μs / 79 cycles.
                    this._fm7HBlankCounter = (this._fm7HBlankCounter + mainElapsed) % 127;
                }

                // PSG audio synthesis (generates samples into ring buffer)
                this.psg.step(mainElapsed);
                if (this._fmCardEnabled) this.opn.step(mainElapsed);
                this.cmt.step(mainElapsed);

                // PTM timer tick. FM77AV family: always (on-board PTM).
                // Other machines: only while a mouse is connected (the
                // mouse set carries the PTM); without it the legacy
                // behaviour (no PTM tick) is preserved exactly.
                if (this.isFM77AV || this._mouseEnabled) this._ptmTick(mainElapsed);

                // Check and assert IRQ/FIRQ on main CPU (level-triggered)
                this._checkAndAssertInterrupts();

                // Accumulate the sub CPU cycle budget for the main cycles
                // just consumed (incl. DMA bus-seizure padding above).
                // The sub system runs on its own nominal 2.0 MHz clock,
                // independent of the main CPU's effective clock — MMR/TWR
                // slowdown (1.565 MHz) and the AV40EX fast-MMR mode
                // (2.016 MHz) must NOT propagate to the sub CPU (#229).
                // FM-7: same 2.0 MHz base; the CRT cycle steal below (#160)
                // then yields 750 kHz effective during active scan and the
                // full 2.0 MHz during HBlank (#231).
                {
                    const mainDelta = this.scheduler.mainCyclesTotal - this._subBudgetMainMark;
                    this._subBudgetMainMark = this.scheduler.mainCyclesTotal;
                    this.scheduler.subCyclesTarget += mainDelta * getSubCycleRatio();
                }

                // Apply deferred HALT/RUN at instruction boundary
                // (real hardware applies halt at instruction boundary)
                this._subHaltAck();

                // Sub CPU: catch up to its own cycle budget.
                // While halted, subCyclesTotal is fast-forwarded (without
                // executing sub instructions) so it doesn't fall behind.
                // This matches real HW: sub clock is frozen during HALT, so
                // the time that passes while halted does NOT translate into
                // extra sub work once halt is released.
                if (this.subCPU) {
                    if (this.scheduler.subHalted) {
                        this.scheduler.subCyclesTotal = this.scheduler.subCyclesTarget;
                    } else {
                        // FM-7 cycle steal (#160): during active scan (not in
                        // HBlank), CRT scanout grabs VRAM bus cycles from sub.
                        // Sub effectively runs at ~0.75 MHz vs nominal 2.0 MHz
                        // (sub gets 384 of every 1024 VRAM bus cycles per
                        // scanline). Implemented by inflating subCyclesTotal
                        // accumulation when in active scan, so fewer sub
                        // instructions run per main cycle. FM77AV+ has
                        // separate VRAM bus, no cycle steal.
                        const fm7Active = !this.isFM77AV && this._fm7HBlankCounter < 79;
                        const stealMul = fm7Active ? this._fm7SubCycleSteal : 1.0;
                        let subGuard = 1000;
                        while (this.scheduler.subCyclesTotal < this.scheduler.subCyclesTarget) {
                            const subElapsed = this.subCPU.exec();
                            if (subElapsed <= 0) {
                                console.error('[EXEC] subCPU.exec() returned 0 at PC=$' +
                                    this.subCPU.pc.toString(16));
                                this.scheduler.subCyclesTotal += 2;
                                break;
                            }
                            this.scheduler.subCyclesTotal += (stealMul === 1.0)
                                ? subElapsed
                                : Math.round(subElapsed * stealMul);
                            // Also check after each sub CPU instruction for responsive halt
                            this._subHaltAck();
                            if (this.scheduler.subHalted) {
                                // Once sub halts mid-catchup, skip remaining budget.
                                this.scheduler.subCyclesTotal = this.scheduler.subCyclesTarget;
                                break;
                            }
                            if (--subGuard <= 0) break;
                        }
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

        // Auto-type (TXT/BAS paste) pacing — driven by the emulation clock,
        // NOT the render loop.  Advancing on emulated time makes the input rate
        // independent of the host display refresh (60 vs 120/144 Hz) and of
        // whether frames are currently being rendered.  16667 µs = one 60 Hz
        // frame; the keyboard's gaps are also kept in emulated µs.
        this.scheduler.addEvent('autotype', 16667, () => {
            this.keyboard.autoTypeTick(16667);
        });

        // VSync event — 4-phase, mode-dependent timing values.
        //
        //   200-line (15kHz)  vdisp=12700 vfp=1520 vsync=510 vbp=1910 = 16640μs (60.1Hz)
        //   400-line (24kHz)  vdisp=16400 vfp= 340 vsync=330 vbp= 980 = 18050μs (55.4Hz)
        //
        // Phase 0: V-active        — vsync=0, V-blank=0 (HBlank still toggles within)
        // Phase 1: V-blank vfp     — vsync=0, V-blank=1
        // Phase 2: V-blank vsync   — vsync=1, V-blank=1   ($FD12 bit 0 high here)
        // Phase 3: V-blank vbp     — vsync=0, V-blank=1
        //
        // `_vsyncFlag` matches the short pulse (Phase 2). `_inVBlank` covers
        // the entire vertical retrace window (Phase 1+2+3) and feeds $FD12 bit 1.
        this.scheduler.addEvent('vsync', 12700, () => {
            const is400 = (this.display.displayMode === 3);
            const evt = this.scheduler.getEvent('vsync');
            const advance = (us) => {
                if (evt) {
                    evt.setIntervalUs(us);
                    evt.current = evt.reload;
                }
            };
            switch (this._vsyncPhase) {
                case 0:
                    // V-active ended → enter V-blank (vfp first)
                    this._inVBlank = true;
                    this._vsyncFlag = false;
                    this._vsyncPhase = 1;
                    this.display.frameCount++;
                    advance(is400 ? 340 : 1520);
                    break;
                case 1:
                    // vfp ended → start VSYNC pulse
                    this._vsyncFlag = true;
                    this._vsyncPhase = 2;
                    advance(is400 ? 330 : 510);
                    break;
                case 2:
                    // VSYNC pulse ended → enter vbp
                    this._vsyncFlag = false;
                    this._vsyncPhase = 3;
                    advance(is400 ? 980 : 1910);
                    break;
                default:
                    // vbp ended → V-active again
                    this._inVBlank = false;
                    this._vsyncPhase = 0;
                    advance(is400 ? 16400 : 12700);
                    break;
            }
        });

        // Sub CPU NMI timer (50 Hz = 20ms, independent of VSync)
        this.scheduler.addEvent('subnmi', 20000, () => {
            // FM77AV NMI mask ($D430 bit 7) gates the 20ms clock BEFORE the
            // CPU's edge latch — an edge occurring while masked is lost.
            if (this.isFM77AV && this._nmiMaskSub) return;
            // MC6809 /NMI is edge-detected and internally latched: an edge
            // arriving during HALT is serviced right after HALT release, NOT
            // dropped. Software that halts the sub at high frequency (e.g.
            // main polling a shared-RAM completion flag under HALT) would
            // otherwise lose most 20ms ticks and stall its frame pacing.
            if (this._subHalted) {
                this._subNmiPending = true;
                return;
            }
            if (!(this.subCPU.intr & 0x01)) {
                this.subCPU.nmi();
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
                // MC6840 CR1 bit 0 = internal reset: hold all timers stopped
                // (used only by the mouse-timer path; legacy feed is unchanged).
                if (val & 0x01) { this._ptmRunning[0] = this._ptmRunning[1] = this._ptmRunning[2] = false; }
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
        // Loading the counter arms the timer for the mouse-timer path (the
        // legacy feed still keys off CR bit 0 and is unaffected).
        this._ptmRunning[t] = true;
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
        // Legacy internal-clock feed: accumulate at the PTM clock rate (main/2).
        this._ptmCycleAcc += mainCycles;
        const ticks = this._ptmCycleAcc >> 1;
        this._ptmCycleAcc &= 1;

        // Mouse C-clock feed (~19.2 kHz), only present while a mouse is
        // connected. On real hardware the PTM is clocked by the mouse set, so
        // its polling timer only runs with the mouse attached; this mirrors that
        // without disturbing the legacy timer path. ~93 main cycles ≈ one
        // 19.2 kHz edge at the nominal main clock (approximation). The mouse
        // set attaches to any machine, so this is gated on the connection alone.
        const mouseActive = this._mouseEnabled;
        let cTicks = 0;
        if (mouseActive) {
            this._ptmMouseClkAcc += mainCycles;
            cTicks = (this._ptmMouseClkAcc / 93) | 0;
            this._ptmMouseClkAcc -= cTicks * 93;
        }

        if (ticks <= 0 && cTicks <= 0) return;

        for (let i = 0; i < 3; i++) {
            const cr = this._ptmCR[i];
            // Legacy behaviour: DevM7 has always driven a timer whose CR bit 0
            // is set off the main/2 feed. Preserved exactly.
            const legacy = (cr & 0x01) !== 0;
            // Mouse path: a guest-started timer the legacy path does not already
            // drive. Clocked by the C feed when CR bit 1 (clock source) = 0.
            const mouseRun = mouseActive && this._ptmRunning[i] && !legacy;
            if (!legacy && !mouseRun) continue;

            let n = (mouseRun && !(cr & 0x02)) ? cTicks : ticks;

            // T3 /8 prescaler (CR3 bit 0) — legacy feed only.
            if (i === 2 && legacy && (this._ptmCR[2] & 0x01)) {
                this._ptmT3Div = (this._ptmT3Div || 0) + n;
                n = this._ptmT3Div >> 3;
                this._ptmT3Div &= 7;
            }
            if (n <= 0) continue;

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

    // ==========================================================================
    // Mouse (all machines)
    // ==========================================================================
    // Button byte convention (`_mouseBtn`, active low): bit set = released,
    // bit clear = pressed. Bit 4 = left, bit 5 = right.

    // ---- Bus mouse ($FDE8) ----

    _mouseBusRead() {
        if (this._mouseMode !== 'bus') return 0x80;  // bit 7 = 1: not connected
        const phase = this._mouseBusPhase;
        this._mouseBusPhase = (phase + 1) & 0x03;
        let nibble;
        switch (phase) {
            case 0:  nibble = this._mouseBusDX & 0x0F; break;        // X-lo
            case 1:  nibble = (this._mouseBusDX >> 4) & 0x0F; break; // X-hi
            case 2:  nibble = this._mouseBusDY & 0x0F; break;        // Y-lo
            default: nibble = (this._mouseBusDY >> 4) & 0x0F; break; // Y-hi
        }
        // Buttons in bit 4-5 (pressed = 1 here), bit 7 always high while present.
        return nibble | ((~this._mouseBtn) & 0x30) | 0x80;
    }

    _mouseBusWrite(val) {
        if ((val & 0x03) === 0) return;  // low two bits clear: not a latch trigger
        this._mouseBusPhase = 0;
        if (this._mouseMode === 'bus') {
            // Snapshot pending movement (clamped int8), sign-inverted per the
            // bus-mouse convention, then clear the shared accumulator.
            let dx = this._mouseAccDX;
            let dy = this._mouseAccDY;
            if (dx > 127) dx = 127; else if (dx < -127) dx = -127;
            if (dy > 127) dy = 127; else if (dy < -127) dy = -127;
            this._mouseBusDX = (-dx) & 0xFF;
            this._mouseBusDY = (-dy) & 0xFF;
            this._mouseAccDX = 0;
            this._mouseAccDY = 0;
        } else {
            this._mouseBusDX = 0;
            this._mouseBusDY = 0;
        }
    }

    // ---- Intelligent mouse (OPN joystick port) ----

    /**
     * Strobe-edge handler, called from the OPN reg 15 write path. On a phase-0
     * edge the pending movement is latched (raw byte, NOT sign-inverted).
     */
    _mouseIntelStrobeUpdate(reg15) {
        if (this._mouseMode !== 'intel1' && this._mouseMode !== 'intel2') return;
        const mask = (this._intelMousePort === 1) ? 0x10 : 0x20;
        const newStrobe = (reg15 & mask) !== 0;
        if (newStrobe === this._mouseIntelStrobe) return;
        this._mouseIntelStrobe = newStrobe;
        // On real hardware the mouse resets its internal nibble sequencer when
        // the strobe stays idle for a while, so stray extra edges cannot leave
        // the phase permanently desynced. Model that with a 2 ms timeout,
        // evaluated lazily on the next edge (latched DX/DY are kept).
        const now = this.scheduler.mainCyclesTotal;
        if (now - this._mouseIntelLastEdge > usToCycles(2000)) {
            this._mouseIntelPhase = 0;
        }
        this._mouseIntelLastEdge = now;
        if (this._mouseIntelPhase === 0) {
            let dx = this._mouseAccDX;
            let dy = this._mouseAccDY;
            if (dx > 127) dx = 127; else if (dx < -127) dx = -127;
            if (dy > 127) dy = 127; else if (dy < -127) dy = -127;
            this._mouseIntelDX = dx & 0xFF;
            this._mouseIntelDY = dy & 0xFF;
            this._mouseAccDX = 0;
            this._mouseAccDY = 0;
        }
        this._mouseIntelPhase = (this._mouseIntelPhase + 1) & 0x03;
    }

    /**
     * Read the mouse data nibble for an OPN port-A read (selreg 14) when the
     * reg-15 direction bits select the mouse port. Returns the next nibble plus
     * trigger-masked button bits and bit 6-7 high, or null to fall through to
     * the gamepad path.
     */
    _mouseIntelRead() {
        if (this._mouseMode !== 'intel1' && this._mouseMode !== 'intel2') return null;
        const reg15 = this._opnRegs[0x0F];
        const expect = (this._intelMousePort === 1) ? 0x00 : 0x40;
        if ((reg15 & 0xC0) !== expect) return null;
        const trigger = (this._intelMousePort === 1)
            ? (reg15 & 0x03)
            : ((reg15 >> 2) & 0x03);
        let nibble;
        switch (this._mouseIntelPhase) {
            case 1:  nibble = (this._mouseIntelDX >> 4) & 0x0F; break; // X-hi
            case 2:  nibble = this._mouseIntelDX & 0x0F; break;        // X-lo
            case 3:  nibble = (this._mouseIntelDY >> 4) & 0x0F; break; // Y-hi
            default: nibble = this._mouseIntelDY & 0x0F; break;        // Y-lo (phase 0)
        }
        // Buttons (active low here), gated by the trigger-select bits.
        const btn = this._mouseBtn & ((trigger << 4) & 0x30);
        return nibble | btn | 0xC0;
    }

    // ---- Public API ----

    /**
     * Connect one mouse device: 'none' / 'bus' / 'intel1' / 'intel2'
     * (any other value is treated as 'none'). Switching modes is the
     * equivalent of reseating a connector: phase, latches and pending
     * movement are reset. Protocol handling itself is untouched.
     */
    setMouseMode(mode) {
        if (mode !== 'bus' && mode !== 'intel1' && mode !== 'intel2') mode = 'none';
        if (mode === this._mouseMode) return;
        this._mouseMode = mode;
        this._mouseEnabled = mode !== 'none';
        if (mode === 'intel1') this._intelMousePort = 1;
        else if (mode === 'intel2') this._intelMousePort = 2;
        this._mouseAccDX = 0;
        this._mouseAccDY = 0;
        this._mouseBtn = 0x30;
        this._mouseBusPhase = 0;
        this._mouseBusDX = 0;
        this._mouseBusDY = 0;
        this._mouseIntelPhase = 0;
        this._mouseIntelDX = 0;
        this._mouseIntelDY = 0;
        this._mouseIntelStrobe = false;
        this._mouseIntelLastEdge = 0;
    }

    /** Legacy toggle (UI/tests): connect or disconnect the bus mouse set. */
    setMouseEnabled(on) {
        this.setMouseMode(on ? 'bus' : 'none');
    }

    /** Select the OPN joystick port the intelligent mouse answers on (1 or 2). */
    setMousePort(port) {
        const p = (port === 2) ? 2 : 1;
        if (this._mouseMode === 'intel1' || this._mouseMode === 'intel2') {
            this.setMouseMode(p === 2 ? 'intel2' : 'intel1');
        } else {
            this._intelMousePort = p;
        }
    }

    /** Feed relative mouse motion (browser pixels); accumulates until the next latch. */
    addMouseDelta(dx, dy) {
        if (!this._mouseEnabled) return;
        this._mouseAccDX += dx | 0;
        this._mouseAccDY += dy | 0;
    }

    /**
     * Report mouse button state.
     * @param {boolean} left  - left button currently pressed
     * @param {boolean} right - right button currently pressed
     */
    setMouseButtons(left, right) {
        if (!this._mouseEnabled) return;
        let b = 0x30;              // active low: bit set = released
        if (left)  b &= ~0x10;
        if (right) b &= ~0x20;
        this._mouseBtn = b;
    }

    // ==========================================================================
    // DMAC HD6844 (FM77AV40 / AV40EX)
    // ==========================================================================
    // Channel 0 is wired to the FDC; ch1-3 are spare/data-chain channels.
    // Register map (selected via $FD98, accessed via $FD99):
    //   $00-$0F: per-channel address (hi/lo) and byte-count (hi/lo) regs
    //            ch0=$00-$03, ch1=$04-$07, ch2=$08-$0B, ch3=$0C-$0F
    //   $10-$13: per-channel control regs (chcr)
    //            bit0: 0=FDC→Mem (read), 1=Mem→FDC (write)
    //            bit1: burst mode
    //            bit3: 0=address up, 1=address down
    //            bit6: ACT (transfer active)
    //            bit7: DONE (transfer complete) — read clears
    //   $14: pcr (priority/TxRQ enable). bit0=ch0 TxRQ, etc.
    //   $15: icr (interrupt control). bit0-3=per-ch IRQ enable, bit7=IRQ pending
    //   $16: dcr (data chain control). bits0-2=chain mode, bit4=end flag

    _dmacReadReg(addr) {
        switch (addr & 0xFF) {
            // Address register (high byte) — ch0 always available, ch1-3 AV40 only
            case 0x00: case 0x04: case 0x08: case 0x0C:
                return (this._dmaAdr[addr >> 2] >> 8) & 0xFF;
            // Address register (low byte)
            case 0x01: case 0x05: case 0x09: case 0x0D:
                return this._dmaAdr[addr >> 2] & 0xFF;
            // Byte count register (high)
            case 0x02: case 0x06: case 0x0A: case 0x0E:
                return (this._dmaBcr[addr >> 2] >> 8) & 0xFF;
            // Byte count register (low)
            case 0x03: case 0x07: case 0x0B: case 0x0F:
                return this._dmaBcr[addr >> 2] & 0xFF;
            // Channel control register (read clears DONE bit7)
            case 0x10: case 0x11: case 0x12: case 0x13: {
                const ch = (addr - 0x10) & 3;
                const tmp = this._dmaChcr[ch];
                this._dmaChcr[ch] &= 0x7F;
                return tmp;
            }
            // Priority control
            case 0x14:
                return this._dmaPcr;
            // Interrupt control: returns ((dcr>>4)|0x80) & icr, then clears IRQ
            case 0x15: {
                const tmp = (((this._dmaDcr >> 4) | 0x80) & this._dmaIcr) & 0xFF;
                this._dmaDcr &= 0x0F;
                this._dmaIcr &= ~0x80;
                return tmp;
            }
            // Data chain control: returns dcr low 4 bits
            case 0x16:
                return this._dmaDcr & 0x0F;
        }
        return 0x00;
    }

    _dmacWriteReg(addr, val) {
        val &= 0xFF;
        switch (addr & 0xFF) {
            case 0x00: case 0x04: case 0x08: case 0x0C: {
                const ch = addr >> 2;
                this._dmaAdr[ch] = (this._dmaAdr[ch] & 0xFF) | (val << 8);
                return;
            }
            case 0x01: case 0x05: case 0x09: case 0x0D: {
                const ch = addr >> 2;
                this._dmaAdr[ch] = (this._dmaAdr[ch] & 0xFF00) | val;
                return;
            }
            case 0x02: case 0x06: case 0x0A: case 0x0E: {
                const ch = addr >> 2;
                this._dmaBcr[ch] = (this._dmaBcr[ch] & 0xFF) | (val << 8);
                return;
            }
            case 0x03: case 0x07: case 0x0B: case 0x0F: {
                const ch = addr >> 2;
                this._dmaBcr[ch] = (this._dmaBcr[ch] & 0xFF00) | val;
                return;
            }
            // chcr: high 4 bits (ACT/DONE/etc) preserved, low 4 bits writable
            case 0x10: case 0x11: case 0x12: case 0x13: {
                const ch = (addr - 0x10) & 3;
                this._dmaChcr[ch] = (this._dmaChcr[ch] & 0xC0) | (val & 0x0F);
                return;
            }
            case 0x14:
                this._dmaPcr = val & 0x8F;
                return;
            case 0x15:
                this._dmaIcr = (this._dmaIcr & 0x80) | (val & 0x0F);
                return;
            case 0x16:
                this._dmaDcr = (this._dmaDcr & 0xF0) | (val & 0x0F);
                return;
        }
    }

    /**
     * Per-instruction DMAC tick. Called from the main exec loop after FDC
     * step. Auto-activates ch0 when the FDC drives DRQ with TxRQ enabled,
     * then transfers one byte per DRQ. Burst mode keeps the bus seized
     * (and stalls the main CPU 2 cycles per poll) between DRQs.
     *
     * Returns the number of main CPU cycles consumed by the DMA bus seizure
     * (0 when no transfer happened).
     */
    _dmacExec(mainElapsed) {
        if (!this.hasDMAC) return 0;

        // Auto-activate when FDC raises DRQ with a pending transfer
        if (!this._dmaFlag &&
            this._dmaBcr[0] > 0 &&
            (this._dmaPcr & 0x01) &&
            this.fdc.drqFlag) {
            this._dmaFlag = true;
            this._dmaChcr[0] = (this._dmaChcr[0] & 0x0F) | 0x40;  // ACT
        }

        if (!this._dmaFlag) return 0;
        if (!(this._dmaPcr & 0x01)) return 0;   // TxRQ dropped

        const ch = 0;

        // BCR exhausted before transfer started
        if (this._dmaBcr[ch] === 0) {
            this._dmaFlag = false;
            this._dmaChcr[ch] = (this._dmaChcr[ch] & 0x0F) | 0x80; // DONE
            return 0;
        }

        // Wait for FDC DRQ
        if (!this.fdc.drqFlag) {
            // In burst mode the bus is held; advance scheduler 2 cycles per
            // poll so events still fire and we don't deadlock.
            return this._dmaBurst ? 2 : 0;
        }

        // Latch burst mode at first byte
        if ((this._dmaChcr[ch] & 0x02) && !this._dmaBurst) {
            this._dmaBurst = true;
        }

        let cycles = 3;  // bus seizure cost per byte
        this.dmaActivityLatch = true;   // for the status-bar DMA (green) LED
        // DMA bus master forces MMR segment to 0 for the duration of the
        // transfer (HD6844 spec). Without this, a program that selects a
        // non-zero MMR bank and then runs FDC DMA would read/write the wrong
        // physical RAM bank.
        const savedSeg = this._mmrBankReg;
        this._mmrBankReg = 0;
        if (this._dmaChcr[ch] & 0x01) {
            // Mem → FDC (write)
            const dat = this._mainRead(this._dmaAdr[ch]);
            this.fdc.writeIO(0xFD1B, dat);
        } else {
            // FDC → Mem (read)
            const dat = this.fdc.readIO(0xFD1B);
            this._mainWrite(this._dmaAdr[ch], dat);
        }
        this._mmrBankReg = savedSeg;

        // Address update (bit3: 0=up, 1=down)
        if (this._dmaChcr[ch] & 0x08) {
            this._dmaAdr[ch] = (this._dmaAdr[ch] - 1) & 0xFFFF;
        } else {
            this._dmaAdr[ch] = (this._dmaAdr[ch] + 1) & 0xFFFF;
        }

        this._dmaBcr[ch] = (this._dmaBcr[ch] - 1) & 0xFFFF;

        // Transfer complete
        if (this._dmaBcr[ch] === 0) {
            // Data chain (AV40 only): if dcr low3 == 1, refill ch0 from ch3
            if ((this._dmaDcr & 0x07) === 0x01) {
                this._dmaAdr[0] = this._dmaAdr[3];
                this._dmaBcr[0] = this._dmaBcr[3];
                this._dmaBcr[3] = 0;
            } else {
                this._dmaFlag = false;
                this._dmaBurst = false;
                this._dmaChcr[ch] = (this._dmaChcr[ch] & 0x0F) | 0x80; // DONE
                this._dmaDcr |= 0x10;  // end flag
                if (this._dmaIcr & 0x01) {
                    this._dmaIcr |= 0x80;  // IRQ pending
                }
            }
        }
        return cycles;
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


        // OPN Timer IRQ: routed through $FD03 bit3 "extended interrupt".
        // The IRQ source is the OPN status
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

        // PTM IRQ ($FDE0-$FDE7, routed via $FD17 bit 2). Present on the
        // FM77AV family (on-board) and on any machine while a mouse
        // (the mouse set carries the PTM) is connected.
        if ((this.isFM77AV || this._mouseEnabled) && (this._ptmStatus & 0x80)) mainIrq = true;

        // DMAC IRQ (FM77AV40+): icr bit7 set when transfer completes and any
        // channel TxRQ is enabled in icr low 4 bits.
        if (this.hasDMAC && (this._dmaIcr & 0x80)) mainIrq = true;

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
        this._subNmiPending = false;
        this._vsyncFlag = false;
        this._vsyncPhase = 0;
        this._inVBlank = false;
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
                // Toggle: fm7.haltSaveApg = false to disable (regression test)
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
                    this._subNmiPending = false;  // reset clears the latched NMI edge
                    console.log('FM77AV: Deferred sub CPU reset applied on HALT release');
                } else if (this._subNmiPending) {
                    // Deliver the 20ms NMI edge latched during HALT
                    // (MC6809 /NMI is edge-latched, not lost while halted)
                    this._subNmiPending = false;
                    if (!(this.subCPU.intr & 0x01)) {
                        this.subCPU.nmi();
                    }
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

        // キーボードエンコーダ隠しメッセージの各文字で鳴る単音BEEP(約25ms)。
        this.keyboard.onKeyEncBeep = () => this._beepStart(25);

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

        // When the window loses focus (Alt+Tab, minimize, tab switch) the
        // browser stops delivering keyup, so a held modifier — notably GRPH,
        // which is mapped to Alt and whose keyup Alt+Tab consumes — would stay
        // stuck on.  Release all held keys on focus-loss; toggle states
        // (CAPS / KANA / INS) are preserved.
        this._blurHandler = () => {
            this.keyboard.releaseAllHeld();
            this._breakKey = false;
        };
        this._visHandler = () => {
            if (document.hidden) this._blurHandler();
        };
        window.addEventListener('blur', this._blurHandler);
        document.addEventListener('visibilitychange', this._visHandler);
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

    /**
     * Enable/disable real-hardware strict-fidelity checks.  Accepts a partial
     * options object; unspecified keys keep their current value.  Passing
     * `true` enables every check, `false` disables every check.  FDC-side
     * checks (spin-up) are mirrored onto the FDC instance.
     */
    setHwStrict(opts) {
        if (opts === true || opts === false) {
            for (const k of Object.keys(this.hwStrict)) this.hwStrict[k] = opts;
        } else if (opts && typeof opts === 'object') {
            for (const k of Object.keys(opts)) {
                if (k in this.hwStrict) this.hwStrict[k] = !!opts[k];
            }
        }
        // Mirror FDC-side flags and warning sink onto the controller.
        this.fdc.strictSpinup = this.hwStrict.fdcSpinup;
        this.fdc.onHwWarn = (code, msg) => this._hwWarn(code, msg);
        return this.hwStrict;
    }

    /** Fire a strict-fidelity warning (real-machine pitfall caught). */
    _hwWarn(code, message) {
        if (typeof this.onHwWarn === 'function') this.onHwWarn(code, message);
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
        const KNOWN = [MACHINE_FM7, MACHINE_FM77AV, MACHINE_FM77AV20, MACHINE_FM77AV20EX,
                       MACHINE_FM77AV40, MACHINE_FM77AV40EX];
        if (!KNOWN.includes(type)) {
            console.warn(`Unknown machine type: ${type}, defaulting to fm7`);
            type = MACHINE_FM7;
        }
        this._machineType = type;
        const isAV = type !== MACHINE_FM7;
        const isAV40 = type === MACHINE_FM77AV40 || type === MACHINE_FM77AV40EX;
        // FDC $FD1E (drive-mode register) is wired on AV20/AV20EX/AV40/
        // AV40EX.  FM-7 and FM77AV(無印) leave the drive in 2D mode
        // permanently; the others boot in 2D mode and switch to 2DD only
        // when software writes $FD1E bit6=0.
        this.fdc.supportsDriveModeSwitch = this.has2DD;
        this.fdc.driveModeIs2dd = false;
        // FM-7 / FM77AV main CPU effective clock is 1.794 MHz (memory wait
        // cycles slow the nominal 2 MHz down).
        const cpuHz = 1794000;
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
        // キーボードエンコーダ隠しメッセージはFM77AV系の機能。
        this.keyboard._hiddenMsgEnabled = isAV;
        console.log(`Machine type set to: ${type} (CPU ${cpuHz/1000}kHz)`);
    }

    /**
     * Update the main CPU effective clock based on MMR/TWR state.
     *
     * Real hardware adds bus-cycle waits when MMR or TWR is enabled, dropping
     * the effective main CPU clock from 1.794 MHz to 1.565 MHz (≈12.8% slow).
     * AV40EX has an opt-in high-speed MMR mode (`$FD95` bit 3) that pushes
     * the clock above baseline to 2.016 MHz.
     *
     * Updates: scheduler clock + scheduler event reloads (so VSync/timer/etc.
     * keep firing on real-time periods), FDC clock-dependent constants, OPN
     * and PSG clock ratios.
     */
    _updateMainCpuClock() {
        if (!this.isFM77AV) return;  // FM-7 has no MMR/TWR
        let cpuHz;
        if (this.hasFastMMR && this._mmrFastMode) {
            cpuHz = 2016000;
        } else if (this._mmrEnabled || this._twrFlag) {
            cpuHz = 1565000;
        } else {
            cpuHz = 1794000;
        }
        setCPUClock(cpuHz);
        FDC.setCPUClock(cpuHz);
        this.opn.setCPUClock(cpuHz);
        this.psg.setCPUClock(cpuHz);
        // Re-derive scheduler event reloads from canonical µs periods
        this.scheduler.onClockChange();
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

    /** @returns {boolean} true if FM77AV20 or FM77AV20EX */
    get isAV20() {
        return this._machineType === MACHINE_FM77AV20 || this._machineType === MACHINE_FM77AV20EX;
    }

    // ---- Capability flags (machine → feature mapping in one place) ----
    // For the pre-existing four machines these reduce exactly to the old
    // isAV40 / isAV40EX gates, so their behaviour is unchanged by design.

    /** 2DD drive-mode switch ($FD1E) wired: AV20/AV20EX/AV40/AV40EX */
    get has2DD() {
        return this.isAV20 || this.isAV40;
    }

    /** DMAC HD6844 present: AV20EX/AV40/AV40EX */
    get hasDMAC() {
        return this._machineType === MACHINE_FM77AV20EX || this.isAV40;
    }

    /** High-speed MMR ($FD95 bit3, suppresses MMR slowdown): AV20EX/AV40EX */
    get hasFastMMR() {
        return this._machineType === MACHINE_FM77AV20EX || this.isAV40EX;
    }

    /** Analog palette read-back ($FD32-$FD34): AV20 and later */
    get hasPaletteReadback() {
        return this.isAV20 || this.isAV40;
    }

    /** Catalogue main RAM size in KB (base configuration). */
    get mainRamKB() {
        if (!this.isFM77AV) return 64;      // FM-7
        return this.isAV40 ? 192 : 128;     // AV/AV20/AV20EX = 128, AV40 family = 192
    }

    /** VRAM size in KB. */
    get vramKB() {
        if (!this.isFM77AV) return 48;      // FM-7 (16KB x 3 planes)
        if (this.isAV40EX) return 192;      // 2-block
        if (this.isAV40) return 144;        // 400-line / 262K banks
        return 96;                          // AV/AV20/AV20EX (48KB x 2 pages)
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
                // Intelligent mouse strobe rides on OPN reg 15 bit 4 (port 1)
                // or bit 5 (port 2); each level change advances the phase.
                if (reg === 0x0F) this._mouseIntelStrobeUpdate(dat);
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
                    // Intelligent mouse (when enabled) takes precedence over the
                    // gamepad when reg-15 direction bits select its port.
                    const mouseData = this._mouseIntelRead();
                    if (mouseData !== null) return mouseData;
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

    /**
     * Load a WAV file as cassette media (CAS:).
     * @param {ArrayBuffer} data - WAV file data
     * @returns {boolean} success
     */
    loadTapeWAV(data) {
        return this.cmt.loadWAV(data);
    }

    /**
     * Export captured cassette writes as a T77 tape image.
     * @returns {ArrayBuffer}
     */
    saveTapeT77() {
        return this.cmt.exportT77();
    }

    /**
     * Export captured cassette writes as a WAV file (CAS:).
     * @param {number} [sampleRate=48000]
     * @returns {ArrayBuffer}
     */
    saveTapeWAV(sampleRate = 48000) {
        return this.cmt.exportWAV(sampleRate);
    }

    /**
     * Re-serialize a drive's (written-to) disk image to a D77 ArrayBuffer.
     * @param {number} driveNum
     * @returns {ArrayBuffer|null}
     */
    saveDiskImage(driveNum) {
        return this.fdc.serializeDrive(driveNum);
    }

    /** @returns {boolean} true if the drive's disk has unsaved writes. */
    isDiskDirty(driveNum) {
        return this.fdc.isDriveDirty(driveNum);
    }

    /** Clear a drive's disk dirty flag (after persisting). */
    clearDiskDirty(driveNum) {
        this.fdc.clearDriveDirty(driveNum);
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
     * Boot mode is selected by the machine mode setting, not by disk presence:
     * the boot ROM shown at $FE00 is chosen by the mode ('basic' or 'dos').
     * BASIC mode boots from disk and gracefully falls back to F-BASIC when no
     * bootable disk is present; DOS mode requires a bootable disk.
     */
    reset() {
        // =====================================================================
        // Boot mode selection.
        //   FM-7 : the boot ROM shown at $FE00 is chosen by the machine mode
        //          setting (default BASIC), independent of disk presence.
        //   FM77AV+: boots via INITIATE.ROM regardless of mode. Its $FD0B
        //          boot-status register and the $FD10 initiator handoff follow
        //          the mode. Without an explicit user selection it keeps the
        //          historical disk-presence default (byte-identical boot
        //          timing); an explicit BASIC/DOS choice is honored.
        // =====================================================================
        const hasDisk = this.fdc.disks[0] && this.fdc.disks[0].loaded;
        const bootMode = (this.isFM77AV && !this._bootModeExplicit)
            ? (hasDisk ? 'dos' : 'basic')
            : ((this._bootModeOverride === 'dos') ? 'dos' : 'basic');
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
        this._ptmRunning[0] = this._ptmRunning[1] = this._ptmRunning[2] = false;
        this._ptmMouseClkAcc = 0;
        // Mouse — reset hardware phase/latch state but preserve the user's
        // connection mode and port selection.
        this._mouseAccDX = 0;
        this._mouseAccDY = 0;
        this._mouseBtn = 0x30;
        this._mouseBusPhase = 0;
        this._mouseBusDX = 0;
        this._mouseBusDY = 0;
        this._mouseIntelPhase = 0;
        this._mouseIntelDX = 0;
        this._mouseIntelDY = 0;
        this._mouseIntelStrobe = false;
        this._mouseIntelLastEdge = 0;
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
            this._vsyncFlag = false;
            this._vsyncPhase = 0;
            this._inVBlank = false;
            this._blankFlag = true;   // Blanking active at power-on
            this._analogPaletteAddr = 0;
            this._analogPalette.fill(0);
            // MMR reset
            this._mmrEnabled = false;
            this._mmrExt = false;
            this._mmrBankReg = 0;
            this._twrFlag = false;
            this._twrReg = 0;
            this._mmrRegs.fill(0);
            // DMAC HD6844 reset
            this._dmaReg = 0;
            for (let i = 0; i < 4; i++) {
                this._dmaAdr[i] = 0xFFFF;
                this._dmaBcr[i] = 0xFFFF;
                this._dmaChcr[i] = 0;
            }
            this._dmaPcr = 0;
            this._dmaIcr = 0;
            this._dmaDcr = 0;
            this._dmaFlag = false;
            this._dmaBurst = false;
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
            this._mmrFastMode = false;
            this._subKanjiBank = false;
            this._subKanjiFlag = false;
            // AV40 peripheral stubs
            this._rd512Sector = 0;
            // MMR registers stay at $00 after fill(0) above.
            // Unwritten segments remain $00 (pointing to extRAM page 0),
            // which software that reads low RAM through the MMR relies on.
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
            this._vsyncFlag = false;
            this._vsyncPhase = 0;
            this._blankFlag = true;
            this._analogPaletteAddr = 0;
            this._analogPalette.fill(0);
            this._mmrEnabled = false;
            this._mmrExt = false;
            this._mmrBankReg = 0;
            this._twrFlag = false;
            this._twrReg = 0;
            this._mmrRegs.fill(0);
            this._bootramRW = false;
            this._dmaReg = 0;
            for (let i = 0; i < 4; i++) {
                this._dmaAdr[i] = 0xFFFF;
                this._dmaBcr[i] = 0xFFFF;
                this._dmaChcr[i] = 0;
            }
            this._dmaPcr = 0;
            this._dmaIcr = 0;
            this._dmaDcr = 0;
            this._dmaFlag = false;
            this._dmaBurst = false;
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
        this._subBudgetMainMark = 0;

        // Re-apply keyboard mode after component reset (components may clear it)
        // Default = KEY_FORMAT_9BIT (FM-7 ASCII). Games switch via $D431.
        if (this.isFM77AV) {
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
            this._keyEncFormat = 0;
            this._keyEncFormatExplicit = false;
        }

        // =====================================================================
        // Boot preparation: initialize hardware state, then choose the main
        // CPU start address for the selected boot path.
        // =====================================================================

        // Reflect the vector area at the end of the boot ROM ($FFE0-$FFFF)
        // into the underlying RAM, as the hardware does.
        if (this.romLoaded.boot) {
            for (let i = 0xFFE0; i <= 0xFFFF; i++) {
                const romByte = this.bootROM[i - BOOT_ROM_BASE];
                if (romByte !== 0xFF) {
                    this.mainRAM[i] = romByte;
                }
            }
        }

        // For BASIC boot, put the FDC into its initial state before
        // BOOT_BAS.ROM runs. For DOS boot, BOOT_DOS.ROM handles FDC init itself.
        if (bootMode === 'basic') {
            this._initFDCPorts();
        }

        // Reset sub CPU — it reads its own reset vector from sub ROM
        this.subCPU.reset();
        this._subNmiPending = false;
        // NMI is masked via _nmiMaskSub (set earlier); sub ROM unmasks via $D430
        this.scheduler.setSubHalted(false);

        // Determine main CPU start address based on boot mode and machine type
        let mainPC;
        let initiatorPath = false;
        if (this.isFM77AV) {
            // FM77AV: INITIATE.ROM is mandatory. Run it as 6809 code so all
            // of its initialization side effects take effect — some 1985-era
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
        } else if (this.romLoaded.bootBas) {
            // FM-7 BASIC boot: run BOOT_BAS.ROM as 6809 code at $FE00. It reads
            // the drive-0 boot sector (T0/S1) to $0100 and jumps there, and
            // gracefully falls back to the F-BASIC cold start when no bootable
            // disk is present. FDC ports were initialized above (basic branch).
            mainPC = 0xFE00;
        } else {
            // BOOT_BAS.ROM は FM-7 起動必須 ROM（Power ゲートで担保）。以下 else は防御的フォールバックであり通常経路では到達しない。
            // No BASIC-mode boot ROM available: jump directly to the F-BASIC
            // cold start (legacy bypass).
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

        // Log boot info (single line to keep the console quiet)
        console.log(
            `${this._machineType.toUpperCase()} reset: PC=$${mainPC.toString(16).toUpperCase().padStart(4, '0')}, ` +
            `boot=${bootMode}, initiator=${initiatorPath ? 'ACTIVE' : 'BYPASSED'}(ROM ${this.romLoaded.initiate ? 'Y' : 'N'}), ` +
            `subMon=Type-${['C','A','B','CG','D/E'][this._subMonitorType]}(A=${this.romLoaded.subA} B=${this.romLoaded.subB} C=${this.romLoaded.sub}), ` +
            `disk0=${hasDisk ? 'Y' : 'N'}, basicROM=${this.romLoaded.fbasic ? 'Y' : 'N'}`
        );
        const srvHi = this._subRead(0xFFFE);
        const srvLo = this._subRead(0xFFFF);
        console.log(`  Sub CPU reset vector: $${((srvHi << 8) | srvLo).toString(16).toUpperCase().padStart(4, '0')}`);

        // Reset clears MMR/TWR — restore base clock (1.794 MHz)
        this._updateMainCpuClock();
    }

    /**
     * FDC initialization for BASIC boot: bring the FDC to its initial state.
     */
    _initFDCPorts() {
        this.fdc.reset();
    }

    /**
     * BASIC boot fallback: determine the BASIC ROM start address from the
     * entry information at the end of the BASIC ROM.
     * @returns {number} Start address for main CPU
     */
    _basicBootBypass() {
        if (!this.romLoaded.fbasic) {
            console.error('[BOOT] BASIC ROM not loaded — cannot BASIC boot');
            return 0xFE00; // Fallback: try boot ROM if available
        }
        // Entry information is stored at the end of the ROM image
        const hi = this.fbasicROM[0x7BFE];
        const lo = this.fbasicROM[0x7BFF];
        const coldStart = (hi << 8) | lo;
        console.log(`[BOOT] BASIC bypass: cold start = $${coldStart.toString(16).toUpperCase().padStart(4, '0')}`);
        return coldStart;
    }

    /**
     * Machine-identification abstraction (see README): adjust the
     * machine-identification byte sequence contained in the in-memory copy
     * of the initiator ROM to match the selected machine type. The original
     * ROM file is never modified. Skipped when romAdjust === false.
     */
    _patchInitiateROM() {
        if (!this.romAdjust) return;
        const rom = this.initiateROM;
        if (!this.romLoaded.initiate || this._initiateROMSize < 0x0B14) return;

        // Offset of the machine-identification byte sequence (6 bytes)
        // within the in-memory initiator image.
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

        // Nothing else is adjusted: the boot path code itself is left intact
        // for every FM77AV-family machine.

        const idStr = String.fromCharCode(...rom.slice(0x0B0E, 0x0B14));
        console.log(`[BOOT] Initiator machine id="${idStr}" (${this._machineType})`);
    }

    /**
     * DOS boot direct: let BOOT_DOS.ROM run on the 6809. The DOS boot ROM
     * performs the sector reads and starts the IPL itself, matching the
     * real hardware boot sequence.
     *
     * For FM77AV: place the boot ROM code in RAM at $FE00 (where the machine
     * reads it once the initiator overlay is off). The sub CPU runs Type-A.
     * For FM-7: $FE00 reads from bootROM directly. No install needed.
     *
     * Boot assists (sector pre-read + IPL skip) are applied only when
     * romAdjust is true.
     *
     * @returns {number} Start address for main CPU ($FE00)
     */
    _dosBootDirect() {
        const disk = this.fdc.disks[0];
        if (!disk || !disk.loaded) {
            console.error('[BOOT] No disk in drive 0 — falling back to BASIC');
            return this._basicBootBypass();
        }

        // FM-7 only (boot assist): detect a NEW BOOT layout disk (sector 1
        // expected at $0100). The FM-7 DOS boot ROM loads to $0300 (OLD BOOT),
        // so such disks are pre-read at NEW BOOT positions instead.
        // Detect both formats (patterns observed in boot sectors):
        //   (a) Direct IPL: ORCC #$50 ($1A $50) + LDS #$01xx ($10 $CE $01)
        //   (b) FLEX format: BRA +$20 ($20 $20), then IPL at offset $22
        //       with ORCC #$50 + LDS #$01xx — same pattern, $22 bytes in.
        // Pre-load sectors at NEW BOOT positions and jump to $0100.
        if (this.romAdjust && !this.isFM77AV) {
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
                    // additional sectors that the IPL would read. After the
                    // pre-read the IPL is not executed again.
                    const readParam = (off) => ({
                        type: d[off], bufHi: d[off+2], bufLo: d[off+3],
                        track: d[off+4], sector: d[off+5], side: d[off+6], drive: d[off+7],
                    });
                    const iplBase = flexIPL ? 0x22 : 0x00;
                    // Table offsets relative to sector start:
                    //   $02: Table A, $0A: Table B, $12: Table C (SIR)
                    const tabA = readParam(0x02);
                    const tabB = readParam(0x0A);
                    // Loop counts (immediate operands within the boot
                    // sector's IPL code, relative to iplBase).
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

                    // Place boot ROM code at $FE00 for FDC callbacks.
                    this._installBootROMtoRAM();
                    // Bring the FDC to its initial state.
                    this._initFDCPorts();
                    // Enable timer IRQ ($FD02 bit 2).
                    this._irqMaskReg |= 0x04;

                    // Determine entry point based on IPL type.
                    // Disk-BASIC style IPLs have parameter tables (type=$0A)
                    // at offsets $02/$0A; for these, start the BASIC ROM
                    // directly (the IPL is not re-run after the pre-read).
                    // Standalone IPLs (no parameter tables) run their own
                    // code from $0100.
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

        // For FM77AV: place the boot ROM code in RAM at $FE00-$FFDF, where
        // the machine reads it once the initiator overlay is off.
        if (this.isFM77AV) {
            this._installBootROMtoRAM();
        }

        // Boot assist: some IPLs use absolute addresses designed for a $0100
        // base (sector 1→$0100, sector 2→$0200, ...) but the DOS boot ROM
        // loads sector 1→$0300 and starts there. Running from $0300 makes
        // such IPLs overwrite themselves when they read sectors back to
        // $0200+. Detect these IPLs and pre-load at $0100 base, running
        // from $0100 instead of the boot ROM.
        if (this.romAdjust && this._needsIPLPreload(disk)) {
            // Pre-load T0/S0 sectors 1-16 to $0100-$10FF
            for (let sec = 1; sec <= 16; sec++) {
                const s = disk.getSector(0, 0, sec);
                if (!s || !s.data) break;
                const base = sec * 0x100;
                for (let i = 0; i < s.data.length; i++) {
                    this.mainRAM[(base + i) & 0xFFFF] = s.data[i];
                }
            }
            // Place boot ROM code at $FE00 for FDC callbacks
            this._installBootROMtoRAM();
            this._initFDCPorts();
            console.log('[BOOT] IPL uses $0100-based addresses: pre-loaded, entry $0100');
            return 0x0100;
        }

        // BOOT_DOS.ROM handles everything: it reads the boot sectors from
        // disk via the FDC and starts the IPL itself.
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
     * Required for FM77AV DOS boot: IPL code may call back into the boot ROM.
     * Since FM77AV reads $FE00 from mainRAM once the initiator overlay is
     * off, the boot code must be present there.
     *
     * Source priority:
     *   1. boot_dos.rom (standalone)
     *   2. the DOS boot code portion contained in the initiator ROM image
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
            // Use the DOS boot code portion of the initiator ROM image
            // (0x1A00 = offset of that portion within the image)
            for (let i = 0; i < codeSize; i++) {
                this.mainRAM[BOOT_ROM_BASE + i] = this.initiateROM[0x1A00 + i];
            }
            console.log('[BOOT] Installed initiator DOS boot code to RAM $FE00-$FFDF');
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
        // NOTE: auto-type (TXT/BAS paste) is advanced by the scheduler's
        // 'autotype' event (see _wireScheduler), not from this render loop, so
        // it stays on emulated time regardless of display refresh rate.

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

    /**
     * Set joystick button state programmatically (headless / scripted control).
     *
     * Works independently of the browser Gamepad polling loop, which only runs
     * inside _frame(). In headless mode _frame() never runs, so the value set
     * here persists and is read back through the OPN port ($FD15/$FD16).
     *
     * @param {number} fmPort - 0 for Joystick 1, 1 for Joystick 2
     * @param {object|number} buttons - Either an object with boolean fields
     *   {up, down, left, right, trigger1, trigger2}, or an active-low raw byte
     *   (0xFF = all released; bit0 up, bit1 down, bit2 left, bit3 right,
     *   bit4 trigger1, bit5 trigger2).
     */
    setJoystickState(fmPort, buttons) {
        if (fmPort !== 0 && fmPort !== 1) return;
        let b;
        if (typeof buttons === 'number') {
            b = buttons & 0xFF;
        } else {
            const o = buttons || {};
            b = 0xFF;
            if (o.up)       b &= ~0x01;
            if (o.down)     b &= ~0x02;
            if (o.left)     b &= ~0x04;
            if (o.right)    b &= ~0x08;
            if (o.trigger1) b &= ~0x10;
            if (o.trigger2) b &= ~0x20;
        }
        this._gamepadState[fmPort] = b & 0xFF;
    }

    /**
     * Release a joystick to the idle state (0xFF). With no argument, or an
     * out-of-range port, both ports are released.
     * @param {number} [fmPort] - 0 for Joystick 1, 1 for Joystick 2
     */
    clearJoystickState(fmPort) {
        if (fmPort === 0 || fmPort === 1) {
            this._gamepadState[fmPort] = 0xFF;
        } else {
            this._gamepadState[0] = 0xFF;
            this._gamepadState[1] = 0xFF;
        }
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
     *   $00 +1: code system switch (0=9BIT FM-7 ASCII, 1=alt-ASCII, 2=SCAN)
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

        // Strict: the MCU is a serial handshake device — after each byte the
        // host must read ENCSTA ($D432) and see the ready/ACK bit before
        // sending the next.  A continuation byte that arrives without that
        // poll is a protocol violation; on real hardware the byte is dropped
        // and the in-flight command never commits (e.g. the ASCII->SCAN
        // switch does not happen).  Lenient default accepts back-to-back bytes.
        if (this.hwStrict.keyEncHandshake && buf.length > 0 && this._keyEncNeedsRead) {
            this._hwWarn('keyenc-handshake',
                `key-encoder byte $${val.toString(16).padStart(2,'0')} sent without polling $D432 ENCSTA; command aborted`);
            buf.length = 0;
            this._keyEncNeedsRead = false;
            return;
        }

        buf.push(val);
        // Require an ENCSTA poll before the next byte is accepted.
        this._keyEncNeedsRead = true;

        const finishCmd = () => {
            this._keyEncSendBuf.length = 0;
            this._keyEncNeedsRead = false; // command done — next byte starts fresh
            this._rtcAck = true; // ACK after command processed (5 us in real HW)
        };

        switch (buf[0]) {
            case 0x00: // Code system switch
                if (buf.length >= 2) {
                    const fmt = buf[1];
                    if (fmt === 0x02) { // SCAN
                        this.keyboard._useScanCodes = true;
                        this.keyboard._enableBreakCodes = true;
                    } else { // 0=9BIT FM-7, 1=alt both → ASCII-style
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
            case 0x03: { // LED get: bit0 = CAPS, bit1 = KANA
                const led = (this.keyboard.capsLock ? 0x01 : 0x00)
                          | (this.keyboard.kanaMode ? 0x02 : 0x00);
                this._rtcRxBuf.push(led);
                finishCmd();
                return;
            }
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
     * Reads the program text area using the interpreter's pointer locations.
     * Call from browser console: fm7.dumpBasicProgram()
     * @param {number} startPtr - address of the text-area start pointer (2 bytes, big-endian)
     * @param {number} endPtr   - address of the text-area end pointer (2 bytes, big-endian)
     */
    dumpBasicProgram(startPtr = 0x19, endPtr = 0x1B) {
        // Use _mainRead() to go through MMR mapping
        const rd = (a) => this._mainRead(a);
        const txtStart = (rd(startPtr) << 8) | rd(startPtr + 1);
        const txtEnd = (rd(endPtr) << 8) | rd(endPtr + 1);
        console.log(`text start=$${txtStart.toString(16)}, end=$${txtEnd.toString(16)}, ROM=${this._basicRomEnabled?'ON':'OFF'}, MMR=${this._mmrEnabled?'ON':'OFF'}`);
        if (this._mmrEnabled) {
            const seg0 = this._mmrReg[this._mmrSegment * 16];
            console.log(`MMR seg=${this._mmrSegment} bank0=page$${seg0.toString(16)}`);
        }

        let addr = txtStart;
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
        if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
        if (this._visHandler) document.removeEventListener('visibilitychange', this._visHandler);
        if (this._gamepadHandler) {
            window.removeEventListener('gamepadconnected', this._gamepadHandler);
        }
    }
}
