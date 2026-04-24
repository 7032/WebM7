/**
 * FM-7 Event Scheduler
 *
 * Cycle-accurate dual-CPU event scheduler for FM-7.
 *
 * FM-7 main CPU: 6809 @ 1.794 MHz
 * FM77AV main CPU: 6809 @ 2.0 MHz
 * Sub CPU runs at same speed as main (1:1 ratio)
 *
 * Key periodic events:
 *   Timer IRQ  - fires every ~2034.5 us (alternating 2034/2035)
 *   VSync      - fires every 16667 us (60 Hz NTSC)
 */

// Main and sub CPU clocks can differ. On FM-7 / FM77AV hardware:
//   Main CPU effective  = 1.794 MHz (nominal 2 MHz minus memory wait states)
//   Sub  CPU            = 2.000 MHz
// Scheduler advances sub by `mainCycles × (SUB_CLOCK / MAIN_CLOCK)` each step.
let CPU_CLOCK_HZ = 1794000;         // Main CPU effective clock
let SUB_CLOCK_HZ = 2000000;         // Sub CPU clock (independent)
let CYCLES_PER_MICROSECOND = CPU_CLOCK_HZ / 1000000;
let SUB_CYCLE_RATIO = SUB_CLOCK_HZ / CPU_CLOCK_HZ;

/**
 * Set main CPU clock speed. Called when machine type changes.
 * Sub CPU stays at its own fixed rate (see setSubCPUClock).
 */
function setCPUClock(hz) {
    CPU_CLOCK_HZ = hz;
    CYCLES_PER_MICROSECOND = hz / 1000000;
    SUB_CYCLE_RATIO = SUB_CLOCK_HZ / CPU_CLOCK_HZ;
}

function setSubCPUClock(hz) {
    SUB_CLOCK_HZ = hz;
    SUB_CYCLE_RATIO = SUB_CLOCK_HZ / CPU_CLOCK_HZ;
}

/**
 * Convert microseconds to CPU cycles.
 */
function usToCycles(us) {
    return Math.round(us * CYCLES_PER_MICROSECOND);
}

/**
 * Convert CPU cycles to microseconds.
 */
function cyclesToUs(cycles) {
    return cycles / CYCLES_PER_MICROSECOND;
}

/**
 * A single scheduled event that fires periodically.
 */
class SchedulerEvent {
    /**
     * @param {string}   id        - unique identifier
     * @param {number}   interval  - reload interval in CPU cycles
     * @param {function} callback  - called when event fires
     */
    constructor(id, interval, callback) {
        this.id = id;
        this.reload = interval;       // interval in cycles (constant)
        this.current = interval;      // countdown in cycles (mutable)
        this.callback = callback;
        this.enabled = true;
    }

    /**
     * Subtract elapsed cycles; return true if the event fired.
     */
    tick(elapsed) {
        if (!this.enabled) return false;

        this.current -= elapsed;
        if (this.current <= 0) {
            // Reload, carrying over any overshoot so long-term timing stays accurate
            this.current += this.reload;
            // Guard against pathological case where elapsed >> reload
            if (this.current <= 0) {
                this.current = this.reload;
            }
            this.callback();
            return true;
        }
        return false;
    }

    reset() {
        this.current = this.reload;
    }
}

export class Scheduler {
    constructor() {
        /** @type {SchedulerEvent[]} */
        this.events = [];

        /** Main 6809 CPU instance (must implement exec() returning cycles used) */
        this.mainCPU = null;
        /** Sub 6809 CPU instance */
        this.subCPU = null;

        /**
         * When true the sub CPU is halted (e.g. main CPU wrote to $FD05)
         * and we skip its execution.
         */
        this.subHalted = false;

        // Book-keeping for dual-CPU sync
        this.mainCyclesTotal = 0;
        this.subCyclesTotal = 0;

        // Timer IRQ alternation state (2034 / 2035 us)
        this._timerAlternate = false;
    }

    // ------------------------------------------------------------------
    // CPU wiring
    // ------------------------------------------------------------------

    /**
     * Attach the main 6809 CPU.
     * The CPU object must expose:
     *   exec()  - execute one instruction, return cycles consumed
     *   irq()   - assert IRQ line  (optional, used by timer event)
     */
    setMainCPU(cpu) {
        this.mainCPU = cpu;
    }

    /**
     * Attach the sub 6809 CPU.
     * Same interface as main CPU.
     */
    setSubCPU(cpu) {
        this.subCPU = cpu;
    }

    /**
     * Control whether the sub CPU is halted.
     */
    setSubHalted(halted) {
        this.subHalted = halted;
        // Always sync cycle counters on HALT and RUN transitions.
        // Without this, un-halting creates a phantom cycle deficit:
        // the sub CPU tries to "catch up" cycles that passed while halted,
        // causing a burst of thousands of sub CPU instructions that
        // destroys timing (drawing appears ~0.2fps, BGM races ahead).
        this.subCyclesTotal = this.mainCyclesTotal;
    }

    // ------------------------------------------------------------------
    // Event management
    // ------------------------------------------------------------------

    /**
     * Register a repeating event.
     *
     * @param {string}   id            - unique name (e.g. "timer", "vsync")
     * @param {number}   microseconds  - interval in microseconds
     * @param {function} callback      - fired each time the event expires
     * @returns {SchedulerEvent}
     */
    addEvent(id, microseconds, callback) {
        // Remove any existing event with same id
        this.removeEvent(id);

        const cycles = usToCycles(microseconds);
        const evt = new SchedulerEvent(id, cycles, callback);
        this.events.push(evt);
        return evt;
    }

    /**
     * Disable and remove event by id.
     */
    removeEvent(id) {
        const idx = this.events.findIndex(e => e.id === id);
        if (idx !== -1) {
            this.events.splice(idx, 1);
        }
    }

    /**
     * Return event by id or null.
     */
    getEvent(id) {
        return this.events.find(e => e.id === id) || null;
    }

    // ------------------------------------------------------------------
    // Timer helpers (convenience for the most common FM-7 events)
    // ------------------------------------------------------------------

    /**
     * Install the standard FM-7 timer IRQ event (~2034.5 us period,
     * alternating between 2034 and 2035 us to approximate 2034.5).
     *
     * @param {function} callback - called on each timer tick
     */
    addTimerEvent(callback) {
        // Start with 2034 us; the wrapper alternates each firing
        const self = this;
        self._timerAlternate = false;

        const wrapper = () => {
            callback();
            // Alternate the reload value for next period
            const evt = self.getEvent('timer');
            if (evt) {
                self._timerAlternate = !self._timerAlternate;
                evt.reload = usToCycles(self._timerAlternate ? 2035 : 2034);
            }
        };

        return this.addEvent('timer', 2034, wrapper);
    }

    /**
     * Install the standard 60 Hz VSync event.
     *
     * @param {function} callback - called on each VSync
     */
    addVSyncEvent(callback) {
        return this.addEvent('vsync', 16667, callback);
    }

    // ------------------------------------------------------------------
    // Execution
    // ------------------------------------------------------------------

    /**
     * Run both CPUs for approximately the given number of microseconds.
     *
     * Execution proceeds instruction-by-instruction on the main CPU.
     * After each main CPU instruction the sub CPU is run until it has
     * consumed at least as many total cycles (1:1 ratio), unless it is
     * halted.  After each main instruction, all scheduler events are
     * ticked by the number of cycles just consumed.
     *
     * @param {number} microseconds - target wall-time to simulate
     * @returns {number} actual microseconds executed
     */
    exec(microseconds) {
        if (!this.mainCPU) {
            throw new Error('Scheduler: main CPU not attached');
        }

        const targetCycles = usToCycles(microseconds);
        const startMain = this.mainCyclesTotal;

        while (this.mainCyclesTotal - startMain < targetCycles) {
            // --- Main CPU: execute one instruction ---
            const mainElapsed = this.mainCPU.exec();
            this.mainCyclesTotal += mainElapsed;

            // --- Sub CPU: catch up to main CPU, scaled by SUB/MAIN clock ratio ---
            // Real HW: sub runs at 2.0 MHz while main effective is 1.794 MHz,
            // so sub does ~11.5% more cycles per wall-time unit than main.
            if (!this.subHalted && this.subCPU) {
                const subTarget = this.mainCyclesTotal * SUB_CYCLE_RATIO;
                while (this.subCyclesTotal < subTarget) {
                    const subElapsed = this.subCPU.exec();
                    this.subCyclesTotal += subElapsed;
                }
            }

            // --- Tick all scheduler events ---
            for (let i = 0; i < this.events.length; i++) {
                this.events[i].tick(mainElapsed);
            }
        }

        const actualCycles = this.mainCyclesTotal - startMain;
        return cyclesToUs(actualCycles);
    }

    /**
     * Execute a single main CPU instruction, sync sub CPU, tick events.
     * Returns the number of main CPU cycles consumed.
     * Useful for step-by-step debugging.
     */
    step() {
        if (!this.mainCPU) {
            throw new Error('Scheduler: main CPU not attached');
        }

        const mainElapsed = this.mainCPU.exec();
        this.mainCyclesTotal += mainElapsed;

        if (!this.subHalted && this.subCPU) {
            const subTarget = this.mainCyclesTotal * SUB_CYCLE_RATIO;
            while (this.subCyclesTotal < subTarget) {
                const subElapsed = this.subCPU.exec();
                this.subCyclesTotal += subElapsed;
            }
        }

        for (let i = 0; i < this.events.length; i++) {
            this.events[i].tick(mainElapsed);
        }

        return mainElapsed;
    }

    // ------------------------------------------------------------------
    // Reset
    // ------------------------------------------------------------------

    /**
     * Reset all scheduler state.  Does NOT reset the CPU instances
     * themselves - call their own reset() for that.
     */
    reset() {
        this.mainCyclesTotal = 0;
        this.subCyclesTotal = 0;
        this.subHalted = false;
        this._timerAlternate = false;

        for (const evt of this.events) {
            evt.reset();
        }
    }
}

// Export constants for external use
export { CPU_CLOCK_HZ, CYCLES_PER_MICROSECOND, usToCycles, cyclesToUs, setCPUClock, setSubCPUClock };
