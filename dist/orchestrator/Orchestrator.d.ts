import { IBotRepository } from '../domain/repositories/IBotRepository';
import { WorkerCommandAdapter } from '../worker/WorkerCommandAdapter';
import { StorageCache } from '../infrastructure/storage/StorageCache';
import { GlobalState, ColonyPhase } from './GlobalState';
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
export declare class Orchestrator {
    private readonly adapter;
    private readonly repository;
    private readonly storage;
    /** If false the Orchestrator only tracks state but never assigns tasks. */
    private autonomousMode;
    private readonly state;
    private ticker;
    private taskCounter;
    /** Bots whose autonomous assignment is suspended (manual override active). */
    private readonly paused;
    constructor(adapter: WorkerCommandAdapter, repository: IBotRepository, storage: StorageCache, 
    /** If false the Orchestrator only tracks state but never assigns tasks. */
    autonomousMode?: boolean);
    start(): void;
    stop(): void;
    enableAutonomous(): void;
    disableAutonomous(): void;
    setStoragePos(x: number, y: number, z: number): void;
    clearStoragePos(): void;
    setPhase(phase: ColonyPhase): void;
    /**
     * Temporarily suspend autonomous task assignment for a bot.
     * Called when the operator sends a manual command to that bot.
     * After `quietMs` the bot re-enters autonomous mode.
     */
    pauseBot(botId: string, quietMs?: number): void;
    resumeBot(botId: string): void;
    isPaused(botId: string): boolean;
    pausedBotIds(): string[];
    addThreat(username: string): void;
    removeThreat(username: string): void;
    getState(): Readonly<GlobalState>;
    private tick;
    private nextId;
    /**
     * Resolve the best chest position for a bot.
     * Prefers the nearest registered chest to the bot's current position.
     * Falls back to the manually set storagePos if no chests are registered.
     */
    private resolveChest;
    private ensureBasePos;
    private toBlockPos;
    private hasDepositableItems;
    private selectTask;
    private idle;
}
//# sourceMappingURL=Orchestrator.d.ts.map