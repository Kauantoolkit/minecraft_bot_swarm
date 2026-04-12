import mineflayer, { Bot as MineflayerBot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { Bot } from '../../domain/entities/Bot';
import { BotState } from '../../domain/value-objects/BotState';
import { ConnectionOptions } from '../network/NetworkProvider';
import { BuildQueue } from '../schematic/BuildQueue';
import { QuarryQueue } from '../mining/QuarryQueue';
import { SwarmIntel } from '../../application/SwarmIntel';
import { PlayerRelationshipStore } from '../../domain/value-objects/PlayerRelationship';
import { BotMeta, MetaStore } from './BotMeta';
import { ts } from './utils';
import { installPhysicsPatches, createMovements } from './physics/PhysicsPatch';
import { MovementBehavior } from './behaviors/MovementBehavior';
import { CombatBehavior } from './behaviors/CombatBehavior';
import { GuardBehavior } from './behaviors/GuardBehavior';
import { DefendBehavior } from './behaviors/DefendBehavior';
import { AvoidBehavior } from './behaviors/AvoidBehavior';
import { FarmBehavior } from './behaviors/FarmBehavior';
import { ExploreBehavior } from './behaviors/ExploreBehavior';
import { InventoryBehavior } from './behaviors/InventoryBehavior';
import { MiningBehavior, DepositFn } from './behaviors/MiningBehavior';
import { BuildBehavior } from './behaviors/BuildBehavior';
import { StorageBehavior } from './behaviors/StorageBehavior';
import { CraftingBehavior } from './behaviors/CraftingBehavior';
import { Vec3 } from 'vec3';
import type { IBotAdapter } from './IBotAdapter';

// Hostile mobs the defend mode will react to
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'pillager', 'vindicator', 'ravager', 'phantom', 'drowned',
  'husk', 'stray', 'wither_skeleton', 'blaze', 'ghast', 'magma_cube',
  'slime', 'silverfish', 'endermite', 'guardian', 'elder_guardian',
  'shulker', 'vex', 'evoker', 'zombie_villager', 'piglin_brute',
  'zoglin', 'hoglin', 'warden',
]);

// Aerial mobs that cannot be reached by ground pathfinding.
// For these, the bot stays in place and only swings when they swoop close enough,
// instead of using GoalFollow which produces endless partial/noPath cycles and
// leaves the bot jumping in the air trying to reach an unreachable position.
const AERIAL_MOBS = new Set(['phantom', 'ghast', 'blaze', 'bat', 'bee', 'vex']);

const CREEPER_FLEE_RADIUS = 7;


export class MineflayerAdapter implements IBotAdapter {
  private readonly metaStore = new MetaStore();
  private readonly movementBehavior  = new MovementBehavior(this.metaStore);
  private readonly combatBehavior    = new CombatBehavior(this.metaStore);
  private readonly guardBehavior     = new GuardBehavior(this.metaStore);
  private readonly defendBehavior    = new DefendBehavior(this.metaStore);
  private readonly avoidBehavior     = new AvoidBehavior(this.metaStore);
  private readonly farmBehavior      = new FarmBehavior(this.metaStore);
  private readonly exploreBehavior   = new ExploreBehavior(this.metaStore);
  private readonly inventoryBehavior = new InventoryBehavior();
  private readonly miningBehavior    = new MiningBehavior();
  private readonly buildBehavior     = new BuildBehavior();
  private readonly storageBehavior   = new StorageBehavior();
  private readonly craftingBehavior  = new CraftingBehavior();

  private getMeta(bot: Bot): BotMeta {
    return this.metaStore.get(bot);
  }

  /** Returns the current active mode string for display in the debug UI. */
  getMode(bot: Bot): string {
    const meta = this.metaStore.get(bot);
    if (!meta) return 'idle';
    const primary = meta.activeMode || 'idle';
    const hasDefend = !!(meta as { defendListener?: unknown }).defendListener;
    return hasDefend && !primary.startsWith('defend') ? `${primary}+defend` : primary;
  }


  // ─── Lifecycle ────────────────────────────────────────────────────────────

  spawn(domainBot: Bot, options: ConnectionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      domainBot.setState(BotState.CONNECTING);

      const mfBot: MineflayerBot = mineflayer.createBot({
        host: options.host,
        port: options.port,
        ...(options.version !== false && { version: options.version }),
        username: options.username,
        agent: options.agent,
        hideErrors: false,
      });

      mfBot.loadPlugin(pathfinder);
      domainBot.attachHandle(mfBot);

      // physicsTick is only emitted when physicsEnabled=true, so we can't use it as a watchdog.
      // Use setInterval instead — runs on the JS event loop regardless of physics state.
      const physicsGuard = setInterval(() => {
        if (!mfBot.physicsEnabled) {
          mfBot.physicsEnabled = true;
          console.warn(`[${domainBot.username}] physicsEnabled was false — forced true`);
        }
      }, 500);
      mfBot.once('end', () => clearInterval(physicsGuard));

      let resolved = false;
      mfBot.on('spawn', () => {
        // Ensure physics is always on — plugins like baritone can leave it disabled
        mfBot.physicsEnabled = true;
        // Limit A* CPU: default tickTimeout=40ms × 10 bots = 400ms blocked per tick
        mfBot.pathfinder.tickTimeout = 10;
        (mfBot.pathfinder as unknown as Record<string, unknown>).searchRadius = 64;
        // Clear any stuck movement keys and active path from previous life
        mfBot.clearControlStates();
        mfBot.pathfinder.stop();
        mfBot.pathfinder.setMovements(createMovements(mfBot));
        
        // 🔧 Physics freeze fix for 1.21 velocity NaN bug
        installPhysicsPatches(domainBot);

        // Auto-defend: always active from first spawn so bots aren't defenceless.
        this.defendBehavior.start(domainBot, 16);

        domainBot.setState(BotState.CONNECTED);
        if (!resolved) {
          resolved = true;
          console.log(`[MineflayerAdapter] ${domainBot.username} spawned`);
          resolve();
        } else {
          console.log(`[MineflayerAdapter] ${domainBot.username} respawned`);
          // Active listeners (pvp/bodyguard/follow) will naturally re-engage
          // via their per-tick logic once they see the target again
        }
      });

      // Auto-respawn when bot dies (sends the "Respawn" packet after 1.5 s)
      mfBot.on('death', () => {
        console.warn(`[MineflayerAdapter] ${domainBot.username} died — respawning in 1.5 s`);
        setTimeout(() => {
          try { mfBot.respawn(); } catch { /* ignore if already respawned */ }
        }, 1500);
      });

      mfBot.once('error', (err: Error) => {
        domainBot.setState(BotState.ERROR);
        console.error(`[MineflayerAdapter] ${domainBot.username} error: ${err.message}`);
        if (!resolved) { resolved = true; reject(err); }
      });

      mfBot.once('kicked', (reason: string) => {
        domainBot.setState(BotState.DISCONNECTED);
        console.warn(`[MineflayerAdapter] ${domainBot.username} kicked: ${reason}`);
      });

      // Health monitoring — auto-eat + log low health
      mfBot.on('health', () => {
        const health = mfBot.health;
        if (health < 10) {
          console.warn(`[${ts()}] ${domainBot.username}: Low health (${health}) → attempting eat`);
          this.eat(domainBot).catch(() => {});
        }
        if (health <= 5) {
          console.error(`[${ts()}] ${domainBot.username}: Critical health (${health})!`);
        }
      });

      mfBot.once('end', (reason: string) => {
        domainBot.setState(BotState.DISCONNECTED);
        console.warn(`[MineflayerAdapter] ${domainBot.username} disconnected: ${reason}`);
      });
    });
  }

  disconnect(domainBot: Bot): void {
    this.stop(domainBot);
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    mfBot.quit();
    domainBot.setState(BotState.DISCONNECTED);
  }

  // ─── Movement ─────────────────────────────────────────────────────────────

  moveTo(domainBot: Bot, x: number, y: number, z: number): Promise<void> {
    return this.movementBehavior.moveTo(domainBot, x, y, z);
  }

  follow(domainBot: Bot, targetUsername: string): void {
    this.movementBehavior.follow(domainBot, targetUsername);
  }

  stop(domainBot: Bot): void {
    this.stopPvp(domainBot);
    this.stopGuard(domainBot);
    this.stopDefend(domainBot);
    this.stopAvoid(domainBot);
    this.stopFarm(domainBot);
    this.stopExplore(domainBot);
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    mfBot.physicsEnabled = true;
    mfBot.pathfinder.stop();
    mfBot.clearControlStates();
    domainBot.setState(BotState.CONNECTED);
    this.getMeta(domainBot).activeMode = 'idle';
  }

  // ─── Chat ─────────────────────────────────────────────────────────────────

  say(domainBot: Bot, message: string): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    mfBot.chat(message);
  }

  // ─── Combat ───────────────────────────────────────────────────────────────

  attack(domainBot: Bot, targetUsername: string): void {
    this.combatBehavior.attack(domainBot, targetUsername);
  }

  pvp(domainBot: Bot, targetUsernames: string[], intel?: SwarmIntel, relations?: PlayerRelationshipStore): void {
    this.combatBehavior.pvp(domainBot, targetUsernames, intel, relations);
  }

  stopPvp(domainBot: Bot): void {
    this.combatBehavior.stopPvp(domainBot);
  }


  // ─── Combat — Guard position ──────────────────────────────────────────────

  guard(domainBot: Bot, x: number, y: number, z: number, radius: number, excludeUsernames: string[], relations?: PlayerRelationshipStore): void {
    this.guardBehavior.guard(domainBot, x, y, z, radius, excludeUsernames, relations);
  }

  stopGuard(domainBot: Bot): void {
    this.guardBehavior.stopGuard(domainBot);
  }

  // ─── Combat — Bodyguard mode ──────────────────────────────────────────────

  bodyguard(domainBot: Bot, protectedUsername: string, radius: number, swarmUsernames: string[], relations?: PlayerRelationshipStore, intel?: SwarmIntel): void {
    this.guardBehavior.bodyguard(domainBot, protectedUsername, radius, swarmUsernames, relations, intel);
  }


  // ─── Combat — Defend mode (background) ───────────────────────────────────

  startDefend(domainBot: Bot, radius: number): void {
    this.defendBehavior.start(domainBot, radius);
  }

  stopDefend(domainBot: Bot): void {
    this.defendBehavior.stop(domainBot);
  }

  // ─── Resource collection ──────────────────────────────────────────────────

  // ─── Resource collection ──────────────────────────────────────────────────

  collect(domainBot: Bot, blockName: string | string[], count: number, onFull?: DepositFn, scaffold = false): Promise<void> {
    return this.miningBehavior.collect(domainBot, blockName, count, onFull, scaffold);
  }

  collectVein(domainBot: Bot, blockName: string, count: number, onFull?: DepositFn): Promise<void> {
    return this.miningBehavior.collectVein(domainBot, blockName, count, onFull);
  }

  quarryFromQueue(domainBot: Bot, queue: QuarryQueue, onFull?: DepositFn): Promise<void> {
    return this.miningBehavior.quarryFromQueue(domainBot, queue, onFull);
  }

  depositAll(domainBot: Bot, chestPos: Vec3): Promise<void> {
    return this.storageBehavior.depositAll(domainBot, chestPos);
  }

  withdraw(domainBot: Bot, chestPos: Vec3, itemName: string, count: number): Promise<number> {
    return this.storageBehavior.withdraw(domainBot, chestPos, itemName, count);
  }

  // ─── Building ─────────────────────────────────────────────────────────────

  buildFromQueue(domainBot: Bot, queue: BuildQueue): Promise<void> {
    return this.buildBehavior.buildFromQueue(domainBot, queue);
  }

  // ─── Inventory ────────────────────────────────────────────────────────────

  equip(domainBot: Bot, itemName: string): Promise<void> {
    return this.inventoryBehavior.equip(domainBot, itemName);
  }

  eat(domainBot: Bot): Promise<void> {
    return this.inventoryBehavior.eat(domainBot);
  }

  // ─── Farm ─────────────────────────────────────────────────────────────────

  farm(domainBot: Bot, centerX: number, centerZ: number, radius: number): Promise<void> {
    return this.farmBehavior.farm(domainBot, centerX, centerZ, radius);
  }

  stopFarm(domainBot: Bot): void {
    this.farmBehavior.stopFarm(domainBot);
  }

  // ─── Explore ──────────────────────────────────────────────────────────────

  explore(domainBot: Bot, direction: 'north' | 'south' | 'east' | 'west' | 'auto'): Promise<void> {
    return this.exploreBehavior.explore(domainBot, direction);
  }

  stopExplore(domainBot: Bot): void {
    this.exploreBehavior.stopExplore(domainBot);
  }

  // ─── Avoid player ─────────────────────────────────────────────────────────

  avoid(domainBot: Bot, targetUsernames: string[], triggerRadius: number): void {
    this.avoidBehavior.avoid(domainBot, targetUsernames, triggerRadius);
  }

  stopAvoid(domainBot: Bot): void {
    this.avoidBehavior.stopAvoid(domainBot);
  }

  // ─── Crafting ─────────────────────────────────────────────────────────────

  craftItem(domainBot: Bot, itemName: string, count: number): Promise<void> {
    return this.craftingBehavior.craft(domainBot, itemName, count);
  }

  /**
   * Navigate to (x, y, z), equip a chest from inventory, and place it on the
   * block below. Returns the final placed Vec3 or null on failure.
   */
  async placeChest(domainBot: Bot, x: number, y: number, z: number): Promise<Vec3 | null> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return null;

    const chestItem = mfBot.inventory.items().find(
      (i: { name: string }) => i.name === 'chest',
    );
    if (!chestItem) throw new Error('No chest in inventory');

    // Navigate close enough to place
    const { createMovements } = await import('./physics/PhysicsPatch');
    const { goals } = await import('mineflayer-pathfinder');
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    await new Promise<void>(res => {
      mfBot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 3));
      mfBot.once('goal_reached', res);
      setTimeout(res, 15_000);
    });

    const targetPos   = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const belowTarget = mfBot.blockAt(targetPos.offset(0, -1, 0));
    if (!belowTarget) throw new Error(`No block below (${x},${y},${z})`);

    await mfBot.equip(chestItem as Parameters<MineflayerBot['equip']>[0], 'hand');
    await mfBot.lookAt(targetPos, true);
    await mfBot.placeBlock(belowTarget, new Vec3(0, 1, 0));

    console.log(`[Adapter] ${domainBot.username}: placed chest at (${x},${y},${z})`);
    return targetPos;
  }

  // ─── Storage scan (worker-safe) ───────────────────────────────────────────

  scanNearbyChests(domainBot: Bot, x: number, y: number, z: number, radius: number): Promise<Array<{ x: number; y: number; z: number }>> {
    return this.storageBehavior.scanNearbyChests(domainBot, x, y, z, radius);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async autoEquipToolFor(mfBot: MineflayerBot, block: ReturnType<MineflayerBot['blockAt']>, mcData: unknown): Promise<void> {
    if (!block) return;
    const md = mcData as Record<string, unknown>;

    // Tool preference order per harvest type
    const TOOL_PRIORITY: Record<string, string[]> = {
      pickaxe: ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe','golden_pickaxe'],
      axe:     ['netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe','golden_axe'],
      shovel:  ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel','golden_shovel'],
      hoe:     ['netherite_hoe','diamond_hoe','iron_hoe','stone_hoe','wooden_hoe','golden_hoe'],
      sword:   ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword'],
    };

    const blockDef = (md['blocks'] as Record<number, { harvestTools?: Record<string, boolean> }>)[block.type];
    if (!blockDef?.harvestTools) return;

    const validToolIds = new Set(Object.keys(blockDef.harvestTools).map(Number));

    for (const tools of Object.values(TOOL_PRIORITY)) {
      for (const toolName of tools) {
        const toolDef = (md['itemsByName'] as Record<string, { id: number }>)[toolName];
        if (!toolDef || !validToolIds.has(toolDef.id)) continue;
        const item = (mfBot.inventory.items() as Array<{ type: number }>).find(i => i.type === toolDef.id);
        if (item) {
          await mfBot.equip(item as Parameters<MineflayerBot['equip']>[0], 'hand');
          return;
        }
      }
    }
  }
}

