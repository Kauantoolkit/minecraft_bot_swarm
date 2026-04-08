"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Orchestrator = void 0;
const GlobalState_1 = require("./GlobalState");
const RoleSystem_1 = require("./RoleSystem");
const TICK_MS = 2000; // how often the Orchestrator wakes up
const MAX_FAILS = 3; // pause autonomous assignment for a bot after N consecutive failures
/**
 * Central brain — runs in the main thread on a fixed tick interval.
 *
 * Responsibilities:
 *   1. Maintain GlobalState from worker STATE_UPDATE events
 *   2. Assign / rebalance roles
 *   3. Select and dispatch the next task for every idle bot
 *   4. Track failures and cool down thrashing bots
 *
 * The Orchestrator is *paused* whenever the operator manually issues a command
 * (WorkerCommandAdapter fires any operator cmd → Orchestrator.pause(botId)).
 * The bot re-enters autonomous mode after a configurable quiet period.
 */
class Orchestrator {
    constructor(adapter, repository, storage, 
    /** If false the Orchestrator only tracks state but never assigns tasks. */
    autonomousMode = true) {
        this.adapter = adapter;
        this.repository = repository;
        this.storage = storage;
        this.autonomousMode = autonomousMode;
        this.state = (0, GlobalState_1.createGlobalState)();
        this.ticker = null;
        this.taskCounter = 0;
        /** Bots whose autonomous assignment is suspended (manual override active). */
        this.paused = new Map();
        adapter.on('state_update', (botId, snap) => {
            const rec = this.state.bots.get(botId);
            if (rec) {
                (0, GlobalState_1.applySnapshot)(rec, snap);
            }
            else {
                this.state.bots.set(botId, {
                    ...snap,
                    role: 'unassigned',
                    failCount: 0,
                    lastTaskAt: 0,
                });
            }
        });
        adapter.on('task_complete', (botId, _taskId) => {
            const rec = this.state.bots.get(botId);
            if (rec) {
                rec.taskStatus = 'idle';
                rec.failCount = 0;
            }
        });
        adapter.on('task_failed', (botId, _taskId, error) => {
            console.warn(`[Orchestrator] ${botId} failed: ${error}`);
            const rec = this.state.bots.get(botId);
            if (rec) {
                rec.taskStatus = 'idle';
                rec.failCount++;
            }
        });
    }
    // ── Public API ────────────────────────────────────────────────────────────
    start() {
        if (this.ticker)
            return;
        console.log('[Orchestrator] Autonomous mode started');
        this.ticker = setInterval(() => this.tick(), TICK_MS);
    }
    stop() {
        if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = null;
        }
    }
    enableAutonomous() { this.autonomousMode = true; }
    disableAutonomous() { this.autonomousMode = false; }
    setStoragePos(x, y, z) {
        this.state.storagePos = { x, y, z };
    }
    setPhase(phase) {
        this.state.phase = phase;
        console.log(`[Orchestrator] Colony phase → ${phase}`);
    }
    /**
     * Temporarily suspend autonomous task assignment for a bot.
     * Called when the operator sends a manual command to that bot.
     * After `quietMs` the bot re-enters autonomous mode.
     */
    pauseBot(botId, quietMs = 30000) {
        const existing = this.paused.get(botId);
        if (existing)
            clearTimeout(existing);
        const t = setTimeout(() => this.paused.delete(botId), quietMs);
        this.paused.set(botId, t);
    }
    addThreat(username) { this.state.threats.add(username); }
    removeThreat(username) { this.state.threats.delete(username); }
    getState() { return this.state; }
    // ── Tick loop ─────────────────────────────────────────────────────────────
    tick() {
        if (!this.autonomousMode)
            return;
        const onlineBots = this.repository.findAll().filter(b => b.isOnline());
        if (onlineBots.length === 0)
            return;
        // Re-assign roles whenever needed
        const roles = (0, RoleSystem_1.assignRoles)(onlineBots.length);
        onlineBots.forEach((bot, i) => {
            const rec = this.state.bots.get(bot.id);
            if (rec && rec.role === 'unassigned') {
                rec.role = roles[i] ?? 'miner';
                console.log(`[Orchestrator] ${bot.username} → role: ${rec.role}`);
            }
        });
        // Assign tasks to idle bots
        for (const bot of onlineBots) {
            const rec = this.state.bots.get(bot.id);
            if (!rec)
                continue;
            if (rec.taskStatus === 'running')
                continue;
            if (this.paused.has(bot.id))
                continue;
            if (rec.failCount >= MAX_FAILS) {
                // Cool down: reset fail count and idle for one tick
                rec.failCount = 0;
                this.adapter.assignTask(bot.id, { id: this.nextId(), type: 'idle', params: { durationMs: 10000 } });
                continue;
            }
            const task = this.selectTask(rec);
            if (task) {
                rec.taskStatus = 'running';
                rec.lastTaskAt = Date.now();
                this.adapter.assignTask(bot.id, task);
            }
        }
    }
    nextId() {
        return `orch_${++this.taskCounter}_${Date.now()}`;
    }
    selectTask(rec) {
        const { storagePos, phase } = this.state;
        switch (rec.role) {
            case 'miner': {
                // Deposit first if carrying a lot
                if ((0, RoleSystem_1.isInventoryFull)(rec) && storagePos) {
                    return { id: this.nextId(), type: 'deposit', params: { chestPos: storagePos } };
                }
                if (phase === 'bootstrap') {
                    return { id: this.nextId(), type: 'collect_wood', params: { count: 32, chestPos: storagePos ?? undefined } };
                }
                const blockName = (0, RoleSystem_1.mineTargetForPhase)(phase);
                return { id: this.nextId(), type: 'mine', params: { blockName, count: 32, chestPos: storagePos ?? undefined } };
            }
            case 'hauler':
                if (!storagePos)
                    return this.idle(5000);
                return { id: this.nextId(), type: 'deposit', params: { chestPos: storagePos } };
            case 'farmer':
                return { id: this.nextId(), type: 'farm', params: { centerX: 0, centerZ: 0, radius: 16 } };
            case 'soldier':
                return { id: this.nextId(), type: 'guard', params: { x: 0, y: 64, z: 0, radius: 32 } };
            case 'builder':
                // Builders need materials first — send them to collect wood or deposit
                if ((0, RoleSystem_1.isInventoryFull)(rec) && storagePos) {
                    return { id: this.nextId(), type: 'deposit', params: { chestPos: storagePos } };
                }
                return { id: this.nextId(), type: 'collect_wood', params: { count: 16, chestPos: storagePos ?? undefined } };
            default:
                return this.idle(10000);
        }
    }
    idle(ms) {
        return { id: this.nextId(), type: 'idle', params: { durationMs: ms } };
    }
}
exports.Orchestrator = Orchestrator;
//# sourceMappingURL=Orchestrator.js.map