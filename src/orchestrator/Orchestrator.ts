import { IBotRepository } from '../domain/repositories/IBotRepository';
import { WorkerCommandAdapter } from '../worker/WorkerCommandAdapter';
import { StorageCache } from '../infrastructure/storage/StorageCache';
import { Vec3 } from 'vec3';
import {
  GlobalState, BotRecord, ColonyPhase,
  createGlobalState, applySnapshot,
} from './GlobalState';
import { assignRoles, mineTargetForPhase, isInventoryFull } from './RoleSystem';
import type { BotSnapshot, TaskDescriptor } from '../ipc/messages';

const TICK_MS    = 2_000;  // how often the Orchestrator wakes up
const MAX_FAILS  = 3;      // pause autonomous assignment for a bot after N consecutive failures

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
export class Orchestrator {
  private readonly state: GlobalState = createGlobalState();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private taskCounter = 0;

  /** Bots whose autonomous assignment is suspended (manual override active). */
  private readonly paused = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly adapter: WorkerCommandAdapter,
    private readonly repository: IBotRepository,
    private readonly storage: StorageCache,
    /** If false the Orchestrator only tracks state but never assigns tasks. */
    private autonomousMode = true,
  ) {
    adapter.on('state_update', (botId: string, snap: BotSnapshot) => {
      const rec = this.state.bots.get(botId);
      if (rec) {
        applySnapshot(rec, snap);
      } else {
        this.state.bots.set(botId, {
          ...snap,
          role:       'unassigned',
          failCount:  0,
          lastTaskAt: 0,
        });
      }
    });

    adapter.on('task_complete', (botId: string, _taskId: string) => {
      const rec = this.state.bots.get(botId);
      if (rec) { rec.taskStatus = 'idle'; rec.failCount = 0; }
    });

    adapter.on('task_failed', (botId: string, _taskId: string, error: string) => {
      console.warn(`[Orchestrator] ${botId} failed: ${error}`);
      const rec = this.state.bots.get(botId);
      if (rec) { rec.taskStatus = 'idle'; rec.failCount++; }
    });

    // When a bot disconnects, mark it idle and pause autonomous assignment
    // until it comes back online. This stops the Orchestrator from queueing
    // tasks into a dead Worker thread.
    adapter.on('disconnected', (botId: string, reason: string) => {
      console.warn(`[Orchestrator] ${botId} disconnected (${reason}) — suspending assignment`);
      const rec = this.state.bots.get(botId);
      if (rec) { rec.taskStatus = 'idle'; rec.failCount = 0; }
      this.pauseBot(botId, 60_000); // hold off for up to 60 s while reconnecting
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  start(): void {
    if (this.ticker) return;
    console.log('[Orchestrator] Autonomous mode started');
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
  }

  enableAutonomous(): void  { this.autonomousMode = true; }
  disableAutonomous(): void { this.autonomousMode = false; }

  setStoragePos(x: number, y: number, z: number): void {
    this.state.storagePos = this.toBlockPos({ x, y, z });
  }

  clearStoragePos(): void {
    this.state.storagePos = null;
    console.log('[Orchestrator] storagePos cleared');
  }

  setPhase(phase: ColonyPhase): void {
    this.state.phase = phase;
    console.log(`[Orchestrator] Colony phase → ${phase}`);
  }

  /**
   * Temporarily suspend autonomous task assignment for a bot.
   * Called when the operator sends a manual command to that bot.
   * After `quietMs` the bot re-enters autonomous mode.
   */
  pauseBot(botId: string, quietMs = 30_000): void {
    const existing = this.paused.get(botId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => this.paused.delete(botId), quietMs);
    this.paused.set(botId, t);
  }

  resumeBot(botId: string): void {
    const existing = this.paused.get(botId);
    if (existing) clearTimeout(existing);
    this.paused.delete(botId);
  }

  isPaused(botId: string): boolean {
    return this.paused.has(botId);
  }

  pausedBotIds(): string[] {
    return Array.from(this.paused.keys());
  }

  addThreat(username: string): void { this.state.threats.add(username); }
  removeThreat(username: string): void { this.state.threats.delete(username); }

  getState(): Readonly<GlobalState> { return this.state; }

  // ── Tick loop ─────────────────────────────────────────────────────────────

  private tick(): void {
    if (!this.autonomousMode) return;

    const onlineBots = this.repository.findAll().filter(b => b.isOnline());
    if (onlineBots.length === 0) return;
    this.ensureBasePos();

    // Re-assign roles whenever needed
    const roles = assignRoles(onlineBots.length);
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
      if (!rec) continue;
      if (rec.taskStatus === 'running') continue;
      if (this.paused.has(bot.id)) continue;
      if (rec.failCount >= MAX_FAILS) {
        // Cool down: reset fail count and idle for one tick
        rec.failCount = 0;
        this.adapter.assignTask(bot.id, { id: this.nextId(), type: 'idle', params: { durationMs: 10_000 } });
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

  private nextId(): string {
    return `orch_${++this.taskCounter}_${Date.now()}`;
  }

  /**
   * Resolve the best chest position for a bot.
   * Prefers the nearest registered chest to the bot's current position.
   * Falls back to the manually set storagePos if no chests are registered.
   */
  private resolveChest(rec: BotRecord): import('../ipc/messages').SerializedVec3 | null {
    if (rec.position) {
      const botVec = new Vec3(rec.position.x, rec.position.y, rec.position.z);
      const nearest = this.storage.getNearest(botVec);
      if (nearest) return { x: nearest.pos.x, y: nearest.pos.y, z: nearest.pos.z };
    }
    return this.state.storagePos;
  }

  private ensureBasePos(): void {
    if (this.state.basePos) return;
    const firstWithPos = Array.from(this.state.bots.values()).find(r => !!r.position)?.position;
    if (!firstWithPos) return;
    this.state.basePos = this.toBlockPos(firstWithPos);
    console.log(`[Orchestrator] basePos set to (${this.state.basePos.x}, ${this.state.basePos.y}, ${this.state.basePos.z})`);
  }

  private toBlockPos(pos: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    return {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
    };
  }

  private hasDepositableItems(rec: BotRecord): boolean {
    const keepPattern = /(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots|shield|bow|crossbow|fishing_rod|shears)$/;
    return rec.inventory.some(i => i.count > 0 && !keepPattern.test(i.name));
  }

  private selectTask(rec: BotRecord): TaskDescriptor | null {
    const { phase } = this.state;
    const chestPos = this.resolveChest(rec);
    const hasAnyStorage = this.storage.list().length > 0;

    switch (rec.role) {

      case 'miner': {
        // Bootstrap safety: if no storage exists yet, any miner can bootstrap
        // the first chest so 1-3 bot colonies are not blocked waiting for a builder.
        if (!hasAnyStorage) {
          const base = this.state.basePos ?? this.toBlockPos(rec.position ?? { x: 0, y: 64, z: 0 });
          return {
            id: this.nextId(),
            type: 'build_storage',
            params: {
              storageLabel: 'base_0',
              centerX: base.x + 2,
              centerY: base.y,
              centerZ: base.z,
              chestCount: 1,
            },
          };
        }

        // Deposit first if carrying a lot
        if (isInventoryFull(rec) && chestPos) {
          return { id: this.nextId(), type: 'deposit', params: { chestPos } };
        }
        if (phase === 'bootstrap') {
          return { id: this.nextId(), type: 'collect_wood', params: { count: 32, chestPos: chestPos ?? undefined } };
        }
        const blockName = mineTargetForPhase(phase);
        return { id: this.nextId(), type: 'mine', params: { blockName, count: 32, chestPos: chestPos ?? undefined } };
      }

      case 'hauler':
        if (chestPos && this.hasDepositableItems(rec)) {
          return { id: this.nextId(), type: 'deposit', params: { chestPos } };
        }
        return this.idle(8_000);

      case 'farmer':
        return {
          id: this.nextId(),
          type: 'farm',
          params: {
            centerX: this.state.basePos?.x ?? rec.position?.x ?? 0,
            centerZ: this.state.basePos?.z ?? rec.position?.z ?? 0,
            radius: 16,
          },
        };

      case 'soldier':
        return {
          id: this.nextId(),
          type: 'guard',
          params: {
            x: this.state.basePos?.x ?? rec.position?.x ?? 0,
            y: this.state.basePos?.y ?? rec.position?.y ?? 64,
            z: this.state.basePos?.z ?? rec.position?.z ?? 0,
            radius: 24,
          },
        };

      case 'builder': {
        // If no storage exists at all, the builder's first job is to construct one
        if (!hasAnyStorage) {
          const base = this.state.basePos ?? this.toBlockPos(rec.position ?? { x: 0, y: 64, z: 0 });
          return {
            id: this.nextId(),
            type: 'build_storage',
            params: {
              storageLabel: 'base',
              centerX: base.x + 3,
              centerY: base.y,
              centerZ: base.z,
              chestCount: 4,
            },
          };
        }
        // Otherwise gather materials or deposit
        if (isInventoryFull(rec) && chestPos) {
          return { id: this.nextId(), type: 'deposit', params: { chestPos } };
        }
        return { id: this.nextId(), type: 'collect_wood', params: { count: 16, chestPos: chestPos ?? undefined } };
      }

      default:
        return this.idle(10_000);
    }
  }

  private idle(ms: number): TaskDescriptor {
    return { id: this.nextId(), type: 'idle', params: { durationMs: ms } };
  }
}
