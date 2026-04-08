"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskRunner = void 0;
const vec3_1 = require("vec3");
const WOOD_TYPES = [
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
    'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
];
/**
 * Per-worker task executor.
 *
 * Runs inside the bot's worker thread. Receives serialisable TaskDescriptors
 * from the Orchestrator and executes them via the local MineflayerAdapter.
 * Supports cancellation: calling cancel() stops the adapter and causes the
 * running promise to reject with 'cancelled'.
 */
class TaskRunner {
    constructor(adapter, bot) {
        this.adapter = adapter;
        this.bot = bot;
        this._currentTaskId = null;
        this._status = 'idle';
        this._cancelled = false;
        this._cancelResolve = null;
    }
    get currentTaskId() { return this._currentTaskId; }
    get status() { return this._status; }
    /**
     * Cancel the currently running task. The active execute() promise will
     * reject with Error('cancelled').
     */
    cancel() {
        this._cancelled = true;
        this.adapter.stop(this.bot);
        this._cancelResolve?.();
    }
    async run(descriptor) {
        this._cancelled = false;
        this._currentTaskId = descriptor.id;
        this._status = 'running';
        try {
            await this.execute(descriptor);
            this._status = 'complete';
        }
        catch (err) {
            this._status = 'failed';
            throw err;
        }
        finally {
            this._currentTaskId = null;
        }
    }
    checkCancelled() {
        if (this._cancelled)
            throw new Error('cancelled');
    }
    /** Returns a promise that resolves when cancel() is called. */
    cancellationToken() {
        return new Promise((_, reject) => {
            this._cancelResolve = () => reject(new Error('cancelled'));
        });
    }
    async execute(d) {
        switch (d.type) {
            // ── Idle ───────────────────────────────────────────────────────────────
            case 'idle': {
                const ms = d.params.durationMs ?? 5000;
                await Promise.race([sleep(ms), this.cancellationToken()]);
                break;
            }
            // ── Mine ───────────────────────────────────────────────────────────────
            case 'mine': {
                this.checkCancelled();
                const { blockName, count, chestPos } = d.params;
                const onFull = chestPos ? this.depositCallback(chestPos) : undefined;
                await this.adapter.collect(this.bot, blockName, count, onFull);
                break;
            }
            // ── Collect wood ───────────────────────────────────────────────────────
            case 'collect_wood': {
                this.checkCancelled();
                const { count, chestPos } = d.params;
                const onFull = chestPos ? this.depositCallback(chestPos) : undefined;
                for (const wood of WOOD_TYPES) {
                    this.checkCancelled();
                    try {
                        await this.adapter.collect(this.bot, wood, count, onFull);
                        return; // success
                    }
                    catch {
                        // try next wood type
                    }
                }
                throw new Error('No wood found nearby');
            }
            // ── Deposit all ────────────────────────────────────────────────────────
            case 'deposit': {
                this.checkCancelled();
                const pos = toVec3(d.params.chestPos);
                await this.adapter.depositAll(this.bot, pos);
                break;
            }
            // ── Guard (runs until cancelled) ───────────────────────────────────────
            case 'guard': {
                this.checkCancelled();
                const { x, y, z, radius } = d.params;
                this.adapter.guard(this.bot, x, y, z, radius, []);
                await this.cancellationToken();
                break;
            }
            // ── Farm ───────────────────────────────────────────────────────────────
            case 'farm': {
                this.checkCancelled();
                const { centerX, centerZ, radius } = d.params;
                await Promise.race([
                    this.adapter.farm(this.bot, centerX, centerZ, radius),
                    this.cancellationToken(),
                ]);
                break;
            }
            // ── Explore ────────────────────────────────────────────────────────────
            case 'explore': {
                this.checkCancelled();
                await Promise.race([
                    this.adapter.explore(this.bot, d.params.direction),
                    this.cancellationToken(),
                ]);
                break;
            }
            // ── Craft (stub) ───────────────────────────────────────────────────────
            case 'craft': {
                console.warn(`[TaskRunner] craft task not yet implemented`);
                await sleep(1000);
                break;
            }
        }
    }
    depositCallback(chestPos) {
        return async () => {
            if (!this._cancelled) {
                await this.adapter.depositAll(this.bot, toVec3(chestPos));
            }
        };
    }
}
exports.TaskRunner = TaskRunner;
function toVec3(v) {
    return new vec3_1.Vec3(v.x, v.y, v.z);
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
//# sourceMappingURL=TaskRunner.js.map