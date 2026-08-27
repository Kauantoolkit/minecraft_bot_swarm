import { IBotRepository } from '../domain/repositories/IBotRepository';
import { IOrchestratorAdapter } from './IOrchestratorAdapter';
import { StorageCache } from '../infrastructure/storage/StorageCache';
import { Vec3 } from 'vec3';
import {
  GlobalState, BotRecord, ColonyPhase,
  createGlobalState, applySnapshot,
} from './GlobalState';
import { assignRoles, mineTargetForPhase, isInventoryFull } from './RoleSystem';
import type { BotSnapshot, TaskDescriptor } from '../ipc/messages';
import { tracer } from '../infrastructure/Tracer';

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
    private readonly adapter: IOrchestratorAdapter,
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
          role:            'unassigned',
          failCount:       0,
          lastTaskAt:      0,
          currentTaskType: null,
        });
      }
    });

    adapter.on('task_complete', (botId: string, _taskId: string) => {
      const rec = this.state.bots.get(botId);
      if (rec) { rec.taskStatus = 'idle'; rec.failCount = 0; rec.currentTaskType = null; }
    });

    adapter.on('task_failed', (botId: string, _taskId: string, error: string) => {
      console.warn(`[Orchestrator] ${botId} failed: ${error}`);
      const rec = this.state.bots.get(botId);
      if (rec) {
        tracer.record(rec.username, botId, 'orch_task_failed', `Task failed (fail #${rec.failCount + 1}): ${error}`, {
          role: rec.role, failCount: rec.failCount + 1, taskType: rec.currentTaskType,
          inventory: rec.inventory, position: rec.position, phase: this.state.phase,
        });
        rec.taskStatus = 'idle'; rec.failCount++; rec.currentTaskType = null;
      }
    });

    // When a bot disconnects, mark it idle and pause autonomous assignment
    // until it comes back online. This stops the Orchestrator from queueing
    // tasks into a dead Worker thread.
    adapter.on('disconnected', (botId: string, reason: string) => {
      console.warn(`[Orchestrator] ${botId} disconnected (${reason}) — suspending assignment`);
      const rec = this.state.bots.get(botId);
      if (rec) { rec.taskStatus = 'idle'; rec.failCount = 0; rec.currentTaskType = null; }
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

  enableAutonomous(): void        { this.autonomousMode = true; }
  disableAutonomous(): void       { this.autonomousMode = false; }
  isAutonomousEnabled(): boolean  { return this.autonomousMode; }

  setStoragePos(x: number, y: number, z: number): void {
    this.state.storagePos = { x, y, z };
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

    // Re-assign roles whenever needed
    const roles = assignRoles(onlineBots.length);
    onlineBots.forEach((bot, i) => {
      const rec = this.state.bots.get(bot.id);
      if (rec && rec.role === 'unassigned') {
        rec.role = roles[i] ?? 'miner';
        console.log(`[Orchestrator] ${bot.username} → role: ${rec.role}`);
      }
    });

    // Auto-advance phase based on storage progress
    this.autoAdvancePhase();

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
        tracer.record(rec.username, bot.id, 'orch_assign', `Assigning ${task.type} (role=${rec.role}, phase=${this.state.phase})`, {
          taskId: task.id, taskType: task.type, params: task.params,
          role: rec.role, phase: this.state.phase,
          inventory: rec.inventory, position: rec.position,
          storagePos: this.state.storagePos,
          registeredChests: this.storage.list().length,
        });
        rec.taskStatus       = 'running';
        rec.lastTaskAt       = Date.now();
        rec.currentTaskType  = task.type;
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

  private selectTask(rec: BotRecord): TaskDescriptor | null {
    const { phase } = this.state;
    const chestPos = this.resolveChest(rec);

    switch (rec.role) {

      case 'miner': {
        // Deposit first if carrying a lot
        if (isInventoryFull(rec) && chestPos) {
          return { id: this.nextId(), type: 'deposit', params: { chestPos } };
        }
        if (phase === 'bootstrap') {
          const woodCount = rec.inventory
            .filter(i => i.name.endsWith('_log'))
            .reduce((s, i) => s + i.count, 0);
          // No storage yet — wait for builder to set up the input chest.
          if (!chestPos) {
            if (woodCount >= 16) return this.idle(5_000); // carrying enough, just hold
            return { id: this.nextId(), type: 'collect_wood', params: { count: 16 } };
          }
          // Input chest exists — collect wood and deposit to it continuously.
          return { id: this.nextId(), type: 'collect_wood', params: { count: 16, chestPos } };
        }
        const blockName = mineTargetForPhase(phase);
        return { id: this.nextId(), type: 'mine', params: { blockName, count: 16, chestPos: chestPos ?? undefined } };
      }

      case 'hauler': {
        if (!isInventoryFull(rec)) return this.idle(10_000);
        if (!chestPos) return this.idle(5_000);
        return { id: this.nextId(), type: 'deposit', params: { chestPos } };
      }

      case 'farmer':
        return { id: this.nextId(), type: 'farm', params: { centerX: 0, centerZ: 0, radius: 16 } };

      case 'soldier':
        return { id: this.nextId(), type: 'guard', params: { x: 0, y: 64, z: 0, radius: 32 } };

      case 'builder': {
        const inputChestVec = this.storage.getByLabel('input');
        const baseChests    = this.storage.list().filter(s => s.label.startsWith('base'));

        // ── Phase A: Bootstrap — no input chest yet ───────────────────────────
        // Builder self-collects the minimum wood needed for 1 chest, places it,
        // and registers it as the shared "input" drop-off point for miners.
        if (!inputChestVec) {
          return {
            id: this.nextId(),
            type: 'build_storage',
            params: {
              storageLabel: 'input',
              centerX: rec.position?.x ?? 0,
              centerY: rec.position?.y ?? 64,
              centerZ: (rec.position?.z ?? 0) + 2,
              chestCount: 1,
              // no inputChestPos → builder collects its own wood for this first chest
            },
          };
        }

        // ── Phase B: Deposit if inventory is full ─────────────────────────────
        if (isInventoryFull(rec) && chestPos) {
          return { id: this.nextId(), type: 'deposit', params: { chestPos } };
        }

        // ── Phase C: Expand storage using miners' deposits ────────────────────
        // Each expansion run withdraws logs from the input chest, crafts chests,
        // and places them in a row anchored to the input chest.
        const inputPos = { x: inputChestVec.x, y: inputChestVec.y, z: inputChestVec.z };
        return {
          id: this.nextId(),
          type: 'build_storage',
          params: {
            storageLabel:  'base',
            // Spread chests in +X from the input chest, 2 blocks apart per slot
            centerX: inputChestVec.x + (baseChests.length + 1) * 2,
            centerY: inputChestVec.y,
            centerZ: inputChestVec.z,
            chestCount:    2,
            inputChestPos: inputPos,
          },
        };
      }

      default:
        return this.idle(10_000);
    }
  }

  private idle(ms: number): TaskDescriptor {
    return { id: this.nextId(), type: 'idle', params: { durationMs: ms } };
  }

  /**
   * Automatically advance the colony phase when storage milestones are met.
   * Called once per tick — only logs when a transition actually happens.
   */
  private autoAdvancePhase(): void {
    const { phase } = this.state;
    const baseChests = this.storage.list().filter(s => s.label.startsWith('base'));

    if (phase === 'bootstrap' && baseChests.length >= 4) {
      this.state.phase = 'resource_gathering';
      console.log('[Orchestrator] 🏗️  Phase → resource_gathering (4+ base chests built)');
    }
    // Future: resource_gathering → base_building when enough stone/iron, etc.
  }
}
