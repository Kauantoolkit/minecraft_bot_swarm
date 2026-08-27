import { MineflayerAdapter } from '../infrastructure/mineflayer/MineflayerAdapter';
import { Bot } from '../domain/entities/Bot';
import { TaskDescriptor, TaskStatus, SerializedVec3 } from '../ipc/messages';
import { Vec3 } from 'vec3';
import { tracer } from '../infrastructure/Tracer';

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
export class TaskRunner {
  private _currentTaskId: string | null = null;
  private _status: TaskStatus = 'idle';
  private _cancelled = false;
  private _cancelResolve: (() => void) | null = null;

  constructor(
    private readonly adapter: MineflayerAdapter,
    private readonly bot: Bot,
    /** Called when a build_storage task places chests — main thread registers them. */
    private readonly onChestsPlaced?: (label: string, positions: SerializedVec3[]) => void,
  ) {}

  get currentTaskId(): string | null { return this._currentTaskId; }
  get status(): TaskStatus             { return this._status; }

  /**
   * Cancel the currently running task. The active execute() promise will
   * reject with Error('cancelled').
   */
  cancel(): void {
    this._cancelled = true;
    this.adapter.stop(this.bot);
    this._cancelResolve?.();
  }

  async run(descriptor: TaskDescriptor): Promise<void> {
    this._cancelled = false;
    this._currentTaskId = descriptor.id;
    this._status = 'running';

    const invSnapshot = this.inventorySnapshot();
    tracer.record(this.bot.username, this.bot.id, 'task_start', `Starting ${descriptor.type}`, {
      taskId: descriptor.id,
      taskType: descriptor.type,
      params: descriptor.params,
      inventory: invSnapshot,
      position: this.positionSnapshot(),
    });

    try {
      await this.execute(descriptor);
      this._status = 'complete';
      tracer.record(this.bot.username, this.bot.id, 'task_complete', `Completed ${descriptor.type}`, {
        taskId: descriptor.id,
        taskType: descriptor.type,
        inventory: this.inventorySnapshot(),
        position: this.positionSnapshot(),
      });
    } catch (err) {
      this._status = 'failed';
      tracer.record(this.bot.username, this.bot.id, 'task_failed', `Failed ${descriptor.type}: ${(err as Error).message}`, {
        taskId: descriptor.id,
        taskType: descriptor.type,
        error: (err as Error).message,
        stack: (err as Error).stack,
        params: descriptor.params,
        inventoryBefore: invSnapshot,
        inventoryAfter: this.inventorySnapshot(),
        position: this.positionSnapshot(),
      });
      throw err;
    } finally {
      this._currentTaskId = null;
    }
  }

  private checkCancelled(): void {
    if (this._cancelled) throw new Error('cancelled');
  }

  /** Returns a promise that resolves when cancel() is called. */
  private cancellationToken(): Promise<never> {
    return new Promise<never>((_, reject) => {
      this._cancelResolve = () => reject(new Error('cancelled'));
    });
  }

  private trace(event: string, detail: string, ctx: Record<string, unknown> = {}): void {
    tracer.record(this.bot.username, this.bot.id, event, detail, ctx);
  }

  private async execute(d: TaskDescriptor): Promise<void> {
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
        const have = this.countInInventory(blockName);
        this.trace('task_step', `mine: need ${count}x ${blockName}, have ${have}`, { blockName, count, have, chestPos });
        if (have >= count) {
          this.trace('task_step', `mine: already enough, depositing`, { have, count });
          if (chestPos) await this.adapter.depositAll(this.bot, toVec3(chestPos));
          break;
        }
        const onFull = chestPos ? this.depositCallback(chestPos) : undefined;
        await this.adapter.collect(this.bot, blockName, count - have, onFull);
        break;
      }

      // ── Collect wood ───────────────────────────────────────────────────────
      case 'collect_wood': {
        this.checkCancelled();
        const { count, chestPos } = d.params;
        const woodInInventory = WOOD_TYPES.reduce((sum, w) => sum + this.countInInventory(w), 0);
        this.trace('task_step', `collect_wood: need ${count}, have ${woodInInventory} logs`, { count, woodInInventory, chestPos });
        if (woodInInventory >= count) {
          this.trace('task_step', `collect_wood: already enough, depositing`, { woodInInventory, count });
          if (chestPos) await this.adapter.depositAll(this.bot, toVec3(chestPos));
          break;
        }
        const onFull = chestPos ? this.depositCallback(chestPos) : undefined;
        await this.adapter.collect(this.bot, WOOD_TYPES, count - woodInInventory, onFull, true);
        break;
      }

      // ── Deposit all ────────────────────────────────────────────────────────
      case 'deposit': {
        this.checkCancelled();
        const pos = toVec3(d.params.chestPos);
        this.trace('task_step', `deposit: going to chest`, { chestPos: d.params.chestPos, inventory: this.inventorySnapshot() });
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

      // ── Craft ──────────────────────────────────────────────────────────────
      case 'craft': {
        this.checkCancelled();
        await this.adapter.craftItem(this.bot, d.params.itemName, d.params.count);
        break;
      }

      // ── Withdraw from chest ─────────────────────────────────────────────────
      case 'withdraw': {
        this.checkCancelled();
        const pos = toVec3(d.params.chestPos);
        await this.adapter.withdraw(this.bot, pos, d.params.itemName, d.params.count);
        break;
      }

      // ── Build storage ───────────────────────────────────────────────────────
      // Full chain: mine wood if needed → craft planks → craft chests → place → register
      case 'build_storage': {
        const { storageLabel, centerX, centerY, centerZ, chestCount, inputChestPos } = d.params;

        this.trace('task_step', `build_storage: starting "${storageLabel}" (${chestCount} chests)`, {
          storageLabel, centerX, centerY, centerZ, chestCount, inputChestPos,
          inventory: this.inventorySnapshot(),
        });

        this.checkCancelled();

        // ── Step 1: Ensure enough wood logs ──────────────────────────────────
        const logsNeeded = chestCount * 2 + 2;
        if (inputChestPos) {
          const available = await this.withdrawLogs(toVec3(inputChestPos), logsNeeded);
          this.trace('task_step', `build_storage: withdrew logs, have ${available}/${logsNeeded}`, {
            available, logsNeeded, inventory: this.inventorySnapshot(),
          });
          if (available < logsNeeded) {
            this.trace('task_step', `build_storage: not enough logs, waiting for miners`, { available, logsNeeded });
            console.log(`[TaskRunner] ${this.bot.username}: only ${available}/${logsNeeded} logs available — waiting for miners…`);
            await Promise.race([sleep(10_000), this.cancellationToken()]);
            break;
          }
        } else {
          this.trace('task_step', `build_storage: self-collecting ${logsNeeded} logs`, { logsNeeded });
          await this.ensureWoodLogs(logsNeeded);
        }
        this.checkCancelled();

        // ── Step 2: Craft planks from logs ────────────────────────────────────
        const planksNeeded = chestCount * 8 + 4;
        this.trace('task_step', `build_storage: crafting ${planksNeeded} planks`, { planksNeeded, inventory: this.inventorySnapshot() });
        await this.craftPlanks(planksNeeded);
        this.checkCancelled();

        // ── Step 3: Craft chests ─────────────────────────────────────────────
        this.trace('task_step', `build_storage: crafting ${chestCount} chests`, { chestCount, inventory: this.inventorySnapshot() });
        await this.adapter.craftItem(this.bot, 'chest', chestCount);
        this.checkCancelled();

        // ── Step 4: Place chests in a row at the target location ──────────────
        const placed: SerializedVec3[] = [];
        for (let i = 0; i < chestCount; i++) {
          this.checkCancelled();
          // Space chests 2 blocks apart so they stay single (no double-chest merge)
          const tx = centerX + i * 2;
          try {
            const pos = await this.adapter.placeChest(this.bot, tx, centerY, centerZ);
            if (pos) placed.push({ x: pos.x, y: pos.y, z: pos.z });
          } catch (err) {
            console.warn(`[TaskRunner] Could not place chest ${i + 1}: ${(err as Error).message}`);
          }
        }

        // ── Step 5: Report placed positions to main thread ────────────────────
        if (placed.length > 0 && this.onChestsPlaced) {
          this.onChestsPlaced(storageLabel, placed);
        }

        console.log(`[TaskRunner] ${this.bot.username}: built ${placed.length}/${chestCount} chests at "${storageLabel}"`);
        break;
      }
    }
  }

  // ── Build-storage helpers ───────────────────────────────────────────────

  /**
   * Try to withdraw logs from the input chest (any wood type).
   * Returns total logs available in inventory after withdrawal (chest + what was already held).
   *
   * StorageBehavior.withdraw returns 0 when an item isn't found — it does not throw.
   * Errors here are real infrastructure failures (pathfinding, chest unreachable) and
   * should propagate rather than being swallowed by a catch-all.
   */
  private async withdrawLogs(chestPos: Vec3, needed: number): Promise<number> {
    const mfBot = this.bot.handle as { inventory: { items(): Array<{ name: string; count: number }> } } | null;
    if (!mfBot) return 0;

    const currentLogs = mfBot.inventory.items()
      .filter(i => WOOD_TYPES.includes(i.name))
      .reduce((s, i) => s + i.count, 0);

    if (currentLogs >= needed) return currentLogs;

    const toWithdraw = needed - currentLogs;
    let withdrawn = 0;

    for (const logType of WOOD_TYPES) {
      if (withdrawn >= toWithdraw) break;
      // withdraw() returns 0 if the item is absent — no exception. Any exception thrown
      // here is a real failure (navigation timeout, chest blocked) and must not be masked.
      const got = await this.adapter.withdraw(this.bot, chestPos, logType, toWithdraw - withdrawn);
      if (got > 0) {
        console.log(`[TaskRunner] ${this.bot.username}: withdrew ${got}x ${logType} from input chest`);
        withdrawn += got;
      }
    }

    return currentLogs + withdrawn;
  }

  private async ensureWoodLogs(needed: number): Promise<void> {
    const mfBot = this.bot.handle as { inventory: { items(): Array<{ name: string; count: number }> } } | null;
    if (!mfBot) return;

    const currentLogs = mfBot.inventory.items()
      .filter(i => i.name.endsWith('_log'))
      .reduce((s, i) => s + i.count, 0);

    if (currentLogs >= needed) return;

    const toCollect = needed - currentLogs;
    console.log(`[TaskRunner] ${this.bot.username}: need ${toCollect} more logs`);

    // Pass all types at once — picks nearest available
    await this.adapter.collect(this.bot, WOOD_TYPES, toCollect);

  }

  /**
   * Craft planks from logs in inventory until `needed` planks are available.
   *
   * The critical fix: after each craftItem call, re-read the inventory count.
   * The previous implementation returned on the first successful craft without
   * checking whether that single log stack was large enough to cover the full
   * need. If oak logs were insufficient, birch logs were never used.
   */
  private async craftPlanks(needed: number): Promise<void> {
    const mfBot = this.bot.handle as { inventory: { items(): Array<{ name: string; count: number }> } } | null;
    if (!mfBot) return;

    const countPlanks = () => mfBot.inventory.items()
      .filter(i => i.name.endsWith('_planks'))
      .reduce((s, i) => s + i.count, 0);

    if (countPlanks() >= needed) return;

    // Each log → 4 planks; craft in batches by log type
    const logs = mfBot.inventory.items().filter(i => i.name.endsWith('_log'));
    for (const logStack of logs) {
      this.checkCancelled();
      const currentPlanks = countPlanks();
      if (currentPlanks >= needed) return;

      const plankName = logStack.name.replace('_log', '_planks');
      // mfBot.craft count = number of craft operations (not items). Each plank recipe yields 4 planks.
      const craftOps = Math.ceil((needed - currentPlanks) / 4);
      await this.adapter.craftItem(this.bot, plankName, craftOps);
      // Re-read after craft: if this log stack was too small to cover the full deficit,
      // loop continues and tries the next log type rather than exiting prematurely.
    }

    const finalPlanks = countPlanks();
    if (finalPlanks < needed) {
      throw new Error(`Could not craft enough planks: have ${finalPlanks}, need ${needed}`);
    }
  }

  private depositCallback(chestPos: { x: number; y: number; z: number }) {
    return async () => {
      if (!this._cancelled) {
        await this.adapter.depositAll(this.bot, toVec3(chestPos));
      }
    };
  }

  private countInInventory(itemName: string): number {
    const mfBot = this.bot.handle as { inventory: { items(): Array<{ name: string; count: number }> } } | null;
    if (!mfBot) return 0;
    return mfBot.inventory.items()
      .filter(i => i.name === itemName)
      .reduce((sum, i) => sum + i.count, 0);
  }

  private inventorySnapshot(): Array<{ name: string; count: number }> {
    const mfBot = this.bot.handle as { inventory: { items(): Array<{ name: string; count: number }> } } | null;
    if (!mfBot) return [];
    const map = new Map<string, number>();
    for (const item of mfBot.inventory.items()) {
      map.set(item.name, (map.get(item.name) ?? 0) + item.count);
    }
    return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
  }

  private positionSnapshot(): { x: number; y: number; z: number } | null {
    const mfBot = this.bot.handle as { entity?: { position: { x: number; y: number; z: number } } } | null;
    if (!mfBot?.entity) return null;
    const p = mfBot.entity.position;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }
}

function toVec3(v: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(v.x, v.y, v.z);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
