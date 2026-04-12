import { MineflayerAdapter } from '../infrastructure/mineflayer/MineflayerAdapter';
import { Bot } from '../domain/entities/Bot';
import { TaskDescriptor, TaskStatus, SerializedVec3 } from '../ipc/messages';
import { Vec3 } from 'vec3';

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

    try {
      await this.execute(descriptor);
      this._status = 'complete';
    } catch (err) {
      this._status = 'failed';
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
        // If already carrying enough, skip mining and deposit directly
        if (chestPos && this.countInInventory(blockName) >= count) {
          console.log(`[TaskRunner] ${this.bot.username}: already has ${count}x ${blockName}, depositing`);
          await this.adapter.depositAll(this.bot, toVec3(chestPos));
          break;
        }
        const onFull = chestPos ? this.depositCallback(chestPos) : undefined;
        await this.adapter.collect(this.bot, blockName, count, onFull);
        break;
      }

      // ── Collect wood ───────────────────────────────────────────────────────
      case 'collect_wood': {
        this.checkCancelled();
        const { count, chestPos } = d.params;
        // If already carrying enough wood of any type, skip and deposit
        const woodInInventory = WOOD_TYPES.reduce((sum, w) => sum + this.countInInventory(w), 0);
        if (chestPos && woodInInventory >= count) {
          console.log(`[TaskRunner] ${this.bot.username}: already has ${woodInInventory} logs, depositing`);
          await this.adapter.depositAll(this.bot, toVec3(chestPos));
          break;
        }
        const onFull = chestPos ? this.depositCallback(chestPos) : undefined;
        // Pass all wood types at once — MiningBehavior picks the nearest available
        await this.adapter.collect(this.bot, WOOD_TYPES, count - woodInInventory, onFull, true);
        break;
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

      // ── Craft ──────────────────────────────────────────────────────────────
      case 'craft': {
        this.checkCancelled();
        await this.adapter.craftItem(this.bot, d.params.itemName, d.params.count);
        break;
      }

      // ── Build storage ───────────────────────────────────────────────────────
      // Full chain: mine wood if needed → craft planks → craft chests → place → register
      case 'build_storage': {
        const { storageLabel, centerX, centerY, centerZ, chestCount } = d.params;

        this.checkCancelled();

        // ── Step 1: Ensure enough wood logs ──────────────────────────────────
        // 1 chest = 8 planks = 2 logs; also need 1 crafting_table = 1 log (first time)
        const logsNeeded = chestCount * 2 + 2;
        await this.ensureWoodLogs(logsNeeded);
        this.checkCancelled();

        // ── Step 2: Craft planks from logs ────────────────────────────────────
        // 1 log → 4 planks
        const planksNeeded = chestCount * 8 + 4; // extra 4 for crafting table
        await this.craftPlanks(planksNeeded);
        this.checkCancelled();

        // ── Step 3: Craft chests (needs crafting table, 8 planks each) ───────
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

  private async craftPlanks(needed: number): Promise<void> {
    const mfBot = this.bot.handle as { inventory: { items(): Array<{ name: string; count: number }> } } | null;
    if (!mfBot) return;

    const currentPlanks = mfBot.inventory.items()
      .filter(i => i.name.endsWith('_planks'))
      .reduce((s, i) => s + i.count, 0);

    if (currentPlanks >= needed) return;

    // Each log → 4 planks; craft in batches by log type
    const logs = mfBot.inventory.items().filter(i => i.name.endsWith('_log'));
    for (const logStack of logs) {
      this.checkCancelled();
      const plankName = logStack.name.replace('_log', '_planks');
      const batchLogs = Math.ceil((needed - currentPlanks) / 4);
      try {
        await this.adapter.craftItem(this.bot, plankName, batchLogs);
        return;
      } catch {
        // wrong plank type, try next
      }
    }
    throw new Error('Could not craft planks — no logs in inventory');
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
}

function toVec3(v: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(v.x, v.y, v.z);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
