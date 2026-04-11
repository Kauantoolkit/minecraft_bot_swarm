import { MineflayerAdapter } from '../infrastructure/mineflayer/MineflayerAdapter';
import { Bot } from '../domain/entities/Bot';
import { TaskDescriptor, TaskStatus, SerializedVec3 } from '../ipc/messages';
import { Vec3 } from 'vec3';

const WOOD_TYPES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'crimson_stem', 'warped_stem',
];

function isWoodSource(name: string): boolean {
  return name.endsWith('_log') || name.endsWith('_stem');
}

function normalizeWoodSourceName(name: string): string {
  return name.startsWith('stripped_') ? name.slice('stripped_'.length) : name;
}

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

  // ── Helper de Debug Pesado ──────────────────────────────────────────────
  private logDebug(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    const botName = this.bot.username || 'UnknownBot';
    const taskId = this._currentTaskId ? `[Task:${this._currentTaskId}]` : '[NoTask]';
    console.debug(`[DEBUG] ${timestamp} | [${botName}] ${taskId} | ${message}`, ...args);
  }

  /**
   * Cancel the currently running task. The active execute() promise will
   * reject with Error('cancelled').
   */
  cancel(): void {
    this.logDebug('🛑 cancel() invoked. Setting _cancelled to true.');
    this._cancelled = true;
    this.adapter.stop(this.bot);
    if (this._cancelResolve) {
      this.logDebug('Resolving cancellation token...');
      this._cancelResolve();
    } else {
      this.logDebug('No cancellation token to resolve.');
    }
  }

  async run(descriptor: TaskDescriptor): Promise<void> {
    this.logDebug(`▶️ run() called for task descriptor:`, JSON.stringify(descriptor));
    this._cancelled = false;
    this._currentTaskId = descriptor.id;
    this._status = 'running';

    try {
      this.logDebug('Entering execute()...');
      await this.execute(descriptor);
      this.logDebug('✅ execute() completed successfully.');
      this._status = 'complete';
    } catch (err) {
      this.logDebug(`❌ execute() failed or was cancelled. Error: ${(err as Error).message}`, err);
      this._status = 'failed';
      throw err;
    } finally {
      this.logDebug('Cleaning up currentTaskId in finally block.');
      this._currentTaskId = null;
    }
  }

  private checkCancelled(): void {
    if (this._cancelled) {
      this.logDebug('⚠️ checkCancelled() triggered! Throwing "cancelled" Error.');
      throw new Error('cancelled');
    }
  }

  /** Returns a promise that resolves when cancel() is called. */
  private cancellationToken(): Promise<never> {
    return new Promise<never>((_, reject) => {
      this._cancelResolve = () => {
        this.logDebug('cancellationToken internal reject triggered.');
        reject(new Error('cancelled'));
      };
    });
  }

  private async execute(d: TaskDescriptor): Promise<void> {
    this.logDebug(`Executing Switch-Case for task type: [${d.type}]`);
    
    switch (d.type) {
      // ── Idle ───────────────────────────────────────────────────────────────
      case 'idle': {
        const ms = d.params.durationMs ?? 5000;
        this.logDebug(`Sleeping (idle) for ${ms}ms...`);
        await Promise.race([sleep(ms), this.cancellationToken()]);
        this.logDebug('Woke up from idle sleep.');
        break;
      }

      // ── Mine ───────────────────────────────────────────────────────────────
      case 'mine': {
        this.checkCancelled();
        const { blockName, count, chestPos } = d.params;
        this.logDebug(`Mining: block=${blockName}, count=${count}, chestPos=${JSON.stringify(chestPos)}`);
        const onFull = chestPos ? this.depositCallback(chestPos) : undefined;
        await this.adapter.collect(this.bot, blockName, count, onFull);
        this.logDebug(`Mining completed for ${blockName}.`);
        break;
      }

      // ── Collect wood ───────────────────────────────────────────────────────
      case 'collect_wood': {
  this.checkCancelled();
  const { count, chestPos } = d.params;
  const onFull = chestPos ? this.depositCallback(chestPos) : undefined;
  const mfBot = this.bot.handle as any;

  // 1. Em vez de iterar sobre WOOD_TYPES, buscamos QUALQUER madeira próxima primeiro
  const nearestBlock = mfBot.findBlock({
    matching: (b: any) => b && isWoodSource(b.name),
    maxDistance: 64,
    useExtraInfo: true
  });

  if (!nearestBlock) {
    this.logDebug("Nenhuma madeira de qualquer tipo encontrada em 64 blocos.");
    throw new Error('No wood found nearby');
  }

  const woodToCollect = nearestBlock.name;
  this.logDebug(`Madeira detectada visualmente: ${woodToCollect} em ${nearestBlock.position}`);

  // 2. Tenta coletar o bloco que ele REALMENTE viu
  try {
    this.checkCancelled();
    await this.adapter.collect(this.bot, woodToCollect, count, onFull, false);
    return;
  } catch (err) {
    this.logDebug(`Falha no caminho normal para ${woodToCollect}. Tentando scaffold...`);
    try {
      await this.adapter.collect(this.bot, woodToCollect, count, onFull, true);
      return;
    } catch (err2) {
      this.logDebug(`Falha total ao tentar alcançar a madeira em ${nearestBlock.position}`);
      throw new Error(`Target wood ${woodToCollect} is unreachable.`);
    }
  }
}

      // ── Deposit all ────────────────────────────────────────────────────────
      case 'deposit': {
        this.checkCancelled();
        this.logDebug(`Depositing all items at chest: ${JSON.stringify(d.params.chestPos)}`);
        const pos = toVec3(d.params.chestPos);
        await this.adapter.depositAll(this.bot, pos);
        this.logDebug(`Deposit all completed.`);
        break;
      }

      // ── Guard (runs until cancelled) ───────────────────────────────────────
      case 'guard': {
        this.checkCancelled();
        const { x, y, z, radius } = d.params;
        this.logDebug(`Guarding position: x=${x}, y=${y}, z=${z}, radius=${radius}`);
        this.adapter.guard(this.bot, x, y, z, radius, []);
        this.logDebug('Awaiting cancellation token (Guard mode runs indefinitely)...');
        await this.cancellationToken();
        break;
      }

      // ── Farm ───────────────────────────────────────────────────────────────
      case 'farm': {
        this.checkCancelled();
        const { centerX, centerZ, radius } = d.params;
        this.logDebug(`Farming at center: X=${centerX}, Z=${centerZ}, radius=${radius}`);
        await Promise.race([
          this.adapter.farm(this.bot, centerX, centerZ, radius),
          this.cancellationToken(),
        ]);
        this.logDebug('Farming cycle finished (or cancelled).');
        break;
      }

      // ── Explore ────────────────────────────────────────────────────────────
      case 'explore': {
        this.checkCancelled();
        this.logDebug(`Exploring in direction: ${d.params.direction}`);
        await Promise.race([
          this.adapter.explore(this.bot, d.params.direction),
          this.cancellationToken(),
        ]);
        this.logDebug('Explore task completed (or cancelled).');
        break;
      }

      // ── Craft ──────────────────────────────────────────────────────────────
      case 'craft': {
        this.checkCancelled();
        this.logDebug(`Crafting: ${d.params.count}x ${d.params.itemName}`);
        await this.adapter.craftItem(this.bot, d.params.itemName, d.params.count);
        this.logDebug(`Crafting completed.`);
        break;
      }

      // ── Build storage ───────────────────────────────────────────────────────
      case 'build_storage': {
        const { storageLabel, centerX, centerY, centerZ, chestCount } = d.params;
        this.logDebug(`Building storage: label="${storageLabel}", count=${chestCount}, pos=(${centerX}, ${centerY}, ${centerZ})`);

        this.checkCancelled();

        // ── Step 1: Ensure enough wood logs
        const logsNeeded = chestCount * 2 + 2;
        this.logDebug(`[Step 1/5] Ensuring logs. Needed: ${logsNeeded}`);
        await this.ensureWoodLogs(logsNeeded);
        this.checkCancelled();

        // ── Step 2: Craft planks from logs
        const planksNeeded = chestCount * 8 + 4;
        this.logDebug(`[Step 2/5] Crafting planks. Needed: ${planksNeeded}`);
        await this.craftPlanks(planksNeeded);
        this.checkCancelled();

        // ── Step 3: Craft chests
        this.logDebug(`[Step 3/5] Crafting chests. Count: ${chestCount}`);
        await this.adapter.craftItem(this.bot, 'chest', chestCount);
        this.checkCancelled();

        // ── Step 4: Place chests
        this.logDebug(`[Step 4/5] Placing chests...`);
        const placed: SerializedVec3[] = [];
        for (let i = 0; i < chestCount; i++) {
          this.checkCancelled();
          const tx = centerX + i * 2;
          this.logDebug(`Trying to place chest ${i + 1}/${chestCount} at (${tx}, ${centerY}, ${centerZ})...`);
          try {
            const pos = await this.adapter.placeChest(this.bot, tx, centerY, centerZ);
            if (pos) {
              placed.push({ x: pos.x, y: pos.y, z: pos.z });
              this.logDebug(`✅ Placed chest ${i + 1} successfully at (${pos.x}, ${pos.y}, ${pos.z}).`);
            } else {
              this.logDebug(`⚠️ placeChest returned null/undefined for chest ${i + 1}.`);
            }
          } catch (err) {
            this.logDebug(`❌ Could not place chest ${i + 1}: ${(err as Error).message}`);
            console.warn(`[TaskRunner] Could not place chest ${i + 1}: ${(err as Error).message}`);
          }
        }

        // ── Step 5: Report placed positions
        this.logDebug(`[Step 5/5] Reporting placements. Total placed: ${placed.length}`);
        if (placed.length > 0 && this.onChestsPlaced) {
          this.logDebug('Calling onChestsPlaced callback.');
          this.onChestsPlaced(storageLabel, placed);
        }

        console.log(`[TaskRunner] ${this.bot.username}: built ${placed.length}/${chestCount} chests at "${storageLabel}"`);
        this.logDebug(`Build storage finished.`);
        break;
      }
      
      default:
        this.logDebug(`⚠️ Unknown task type encountered: ${(d as any).type}`);
    }
  }

  // ── Build-storage helpers ───────────────────────────────────────────────

  private nearestWoodType(): string | null {
    this.logDebug('Finding nearest wood type...');
    const mfBot = this.bot.handle as any; // Usar any aqui para facilitar acesso ao findBlock do mineflayer
    
    if (!mfBot) return null;

    // Aumentamos a busca e garantimos que o bloco retornado é válido
    const nearest = mfBot.findBlock({
      matching: (block: any) => block && isWoodSource(block.name),
      maxDistance: 64, // Reduzi para 64 para evitar timeouts de CPU (ECONNRESET)
      useExtraInfo: true
    });
    
    if (!nearest) {
      this.logDebug('nearestWoodType: No wood block found within 64 blocks.');
      return null;
    }

    const normalized = normalizeWoodSourceName(nearest.name);
    return normalized;
  }

  private async ensureWoodLogs(needed: number): Promise<void> {
    this.logDebug(`ensureWoodLogs: Evaluating current log inventory...`);
    const mfBot = this.bot.handle as { inventory: { items(): Array<{ name: string; count: number }> } } | null;
    if (!mfBot) {
      this.logDebug('ensureWoodLogs: bot.handle is null/undefined.');
      return;
    }

    const currentLogs = mfBot.inventory.items()
      .filter(i => {
        const isWood = isWoodSource(i.name);
        if (isWood) this.logDebug(`Found log in inventory: ${i.name} (x${i.count})`);
        return isWood;
      })
      .reduce((s, i) => s + i.count, 0);

    this.logDebug(`ensureWoodLogs: Has ${currentLogs} logs, needs ${needed}.`);
    if (currentLogs >= needed) {
      this.logDebug('ensureWoodLogs: Requirements met. Returning.');
      return;
    }

    const toCollect = needed - currentLogs;
    console.log(`[TaskRunner] ${this.bot.username}: need ${toCollect} more logs`);
    this.logDebug(`Need to collect ${toCollect} more logs.`);

    const preferred = this.nearestWoodType();
    const candidateOrder = preferred
      ? [preferred, ...WOOD_TYPES.filter(wood => wood !== preferred)]
      : WOOD_TYPES;

    for (const wood of candidateOrder) {
      this.checkCancelled();
      this.logDebug(`ensureWoodLogs: Trying to collect ${toCollect}x ${wood} (normal pathing)...`);
      try {
        await this.adapter.collect(this.bot, wood, toCollect, undefined, false);
        this.logDebug(`ensureWoodLogs: Successfully collected ${wood}.`);
        return;
      } catch (err) {
        this.logDebug(`ensureWoodLogs: Normal collect failed for ${wood} -> ${(err as Error).message}. Trying scaffold...`);
        try {
          await this.adapter.collect(this.bot, wood, toCollect, undefined, true);
          this.logDebug(`ensureWoodLogs: Successfully collected ${wood} via scaffold.`);
          return;
        } catch (err2) {
           this.logDebug(`ensureWoodLogs: Scaffold collect failed for ${wood} -> ${(err2 as Error).message}. Moving to next type...`);
          // try next type
        }
      }
    }
    
    this.logDebug('❌ ensureWoodLogs: Failed to find ANY wood logs nearby.');
    throw new Error('Could not find any wood logs nearby');
  }

  private async craftPlanks(needed: number): Promise<void> {
    this.logDebug('craftPlanks: Evaluating current plank inventory...');
    const mfBot = this.bot.handle as { inventory: { items(): Array<{ name: string; count: number }> } } | null;
    if (!mfBot) {
      this.logDebug('craftPlanks: bot.handle is null/undefined.');
      return;
    }

    const currentPlanks = mfBot.inventory.items()
      .filter(i => {
        const isPlank = i.name.endsWith('_planks');
        if (isPlank) this.logDebug(`Found planks in inventory: ${i.name} (x${i.count})`);
        return isPlank;
      })
      .reduce((s, i) => s + i.count, 0);

    this.logDebug(`craftPlanks: Has ${currentPlanks} planks, needs ${needed}.`);
    if (currentPlanks >= needed) {
      this.logDebug('craftPlanks: Requirements met. Returning.');
      return;
    }

    const logs = mfBot.inventory.items().filter(i => isWoodSource(i.name));
    this.logDebug(`craftPlanks: Found ${logs.length} distinct log stacks to convert.`);
    
    for (const logStack of logs) {
      this.checkCancelled();
      const plankName = logStack.name
        .replace('_log', '_planks')
        .replace('_stem', '_planks');
      
      const batchLogs = Math.ceil((needed - currentPlanks) / 4);
      this.logDebug(`craftPlanks: Attempting to craft ${batchLogs} times from ${logStack.name} -> ${plankName}`);
      
      try {
        await this.adapter.craftItem(this.bot, plankName, batchLogs);
        this.logDebug(`craftPlanks: Successfully crafted ${plankName}.`);
        return;
      } catch (err) {
        this.logDebug(`craftPlanks: Failed to craft ${plankName}: ${(err as Error).message}. Trying next log type if available...`);
        // wrong plank type, try next
      }
    }
    
    this.logDebug('❌ craftPlanks: Exhausted logs but still missing planks.');
    throw new Error('Could not craft planks — no logs in inventory');
  }

  private depositCallback(chestPos: { x: number; y: number; z: number }) {
    this.logDebug(`Creating deposit callback targeting: ${JSON.stringify(chestPos)}`);
    return async () => {
      this.logDebug('Deposit callback triggered (inventory full or task complete).');
      if (!this._cancelled) {
        this.logDebug('Depositing items...');
        await this.adapter.depositAll(this.bot, toVec3(chestPos));
        this.logDebug('Deposit finished via callback.');
      } else {
        this.logDebug('Deposit callback ignored because task is cancelled.');
      }
    };
  }
}

function toVec3(v: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(v.x, v.y, v.z);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}