import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { QuarryQueue } from '../../mining/QuarryQueue';
import { createMovements, createScaffoldMovements } from '../physics/PhysicsPatch';
import { isInventoryFull } from './StorageBehavior';

/** Called by mining loops when the inventory is full. Implementations deposit to a chest. */
export type DepositFn = (bot: Bot) => Promise<void>;

/**
 * If the bot ended up in water after mining, navigate out before the next block.
 * Uses pathfinder to find the shortest path to a non-water position nearby.
 */
async function escapeWaterIfNeeded(mfBot: MineflayerBot, username: string): Promise<void> {
  const inWater = (mfBot.entity as unknown as { isInWater?: boolean }).isInWater;
  if (!inWater) return;
  console.warn(`[Mining] ${username}: in water after dig — escaping`);
  const pos = mfBot.entity.position;
  mfBot.pathfinder.setMovements(createMovements(mfBot));
  await new Promise<void>(res => {
    const onReach = () => { clearTimeout(timer); res(); };
    const timer = setTimeout(() => { mfBot.off('goal_reached', onReach); res(); }, 6000);
    mfBot.pathfinder.setGoal(new goals.GoalNear(
      Math.floor(pos.x), Math.floor(pos.y) + 3, Math.floor(pos.z), 2,
    ));
    mfBot.once('goal_reached', onReach);
  });
  mfBot.pathfinder.stop();
  mfBot.clearControlStates();
}

/**
 * Returns true if mining this block would require the bot to be submerged.
 * Checks whether the block itself or the block directly above it is water/waterlogged.
 */
const WATER_NAMES = new Set(['water', 'flowing_water']);

function isBlockUnderwater(mfBot: MineflayerBot, pos: Vec3 | null): boolean {
  if (!pos) return false;
  const above = mfBot.blockAt(pos.offset(0, 1, 0));
  const self  = mfBot.blockAt(pos);
  if (above && WATER_NAMES.has(above.name)) return true;
  if (self  && WATER_NAMES.has(self.name))  return true;
  if (self?.getProperties?.()?.['waterlogged'] === true) return true;
  return false;
}

/**
 * Returns true if the bot can reach this block without digging down.
 * A block is "surface-accessible" when at least one face is exposed:
 * the block above it is not a full solid cube, or one of the 4 sides
 * has a non-solid neighbor at the same or adjacent Y level.
 * This prevents the bot from choosing buried blocks over nearby surface ones.
 */
function isBlockAccessible(mfBot: MineflayerBot, pos: Vec3 | null): boolean {
  if (!pos) return false;

  // Top face exposed — most common case for surface collection
  const above = mfBot.blockAt(pos.offset(0, 1, 0));
  if (!above || above.boundingBox !== 'block') return true;

  // Any horizontal side exposed at the same Y (bot can stand next to it)
  const sides = [
    pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
    pos.offset(0, 0, 1), pos.offset(0, 0, -1),
  ];
  for (const side of sides) {
    const b = mfBot.blockAt(side);
    if (!b || b.boundingBox !== 'block') return true;
  }

  return false;
}

// Tool preference order per harvest type — highest tier first
const TOOL_PRIORITY: Record<string, string[]> = {
  pickaxe: ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe','golden_pickaxe'],
  axe:     ['netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe','golden_axe'],
  shovel:  ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel','golden_shovel'],
  hoe:     ['netherite_hoe','diamond_hoe','iron_hoe','stone_hoe','wooden_hoe','golden_hoe'],
  sword:   ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword'],
};

export class MiningBehavior {
  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Equips the best available tool for the given block. No-op if no tool found. */
  private async autoEquipToolFor(
    mfBot: MineflayerBot,
    block: ReturnType<MineflayerBot['blockAt']>,
    mcData: unknown,
  ): Promise<void> {
    if (!block) return;
    const md = mcData as Record<string, unknown>;

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

  /**
   * Navigate to a block, stop pathfinder, then dig with a fresh reference.
   * Returns true if the block was successfully mined, false if already gone or unreachable.
   */
  private async safeDig(
    mfBot: MineflayerBot,
    username: string,
    pos: Vec3,
    expectedName: string,
    mcData: ReturnType<typeof require>,
  ): Promise<boolean> {
    console.log(
      `[Mining] ${username}: indo até bloco "${expectedName}" em (${pos.x}, ${pos.y}, ${pos.z})`,
    );

    let goalReached = false;
    await new Promise<void>((res) => {
      const onReach = () => {
        goalReached = true;
        clearTimeout(timer);
        res();
      };
      const timer = setTimeout(() => {
        mfBot.off('goal_reached', onReach);
        res();
      }, 8000);
      mfBot.pathfinder.setGoal(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
      mfBot.once('goal_reached', onReach);
    });

    const block = mfBot.blockAt(pos);
    if (!block || block.name !== expectedName) {
      console.warn(
        `[Mining] ${username}: alvo mudou/sumiu antes de quebrar em (${pos.x}, ${pos.y}, ${pos.z})`,
      );
      return false;
    }
    if (block.position.distanceTo(mfBot.entity.position) > 5) {
      const reason = goalReached ? 'distância de quebra ainda alta' : 'não achou caminho a tempo';
      console.warn(
        `[Mining] ${username}: parou em "${expectedName}" (${pos.x}, ${pos.y}, ${pos.z}) — ${reason}`,
      );
      return false;
    }

    await this.autoEquipToolFor(mfBot, block, mcData);

    if (!mfBot.canDigBlock(block)) {
      console.warn(
        `[Mining] ${username}: não consegue quebrar "${expectedName}" em (${pos.x}, ${pos.y}, ${pos.z})`,
      );
      return false;
    }

    mfBot.pathfinder.stop();
    mfBot.clearControlStates();

    try {
      console.log(
        `[Mining] ${username}: tentando quebrar "${expectedName}" em (${pos.x}, ${pos.y}, ${pos.z})`,
      );
      await mfBot.dig(block, true);
      // Brief pause so the dropped item spawns and the bot can pick it up
      await new Promise(r => setTimeout(r, 400));
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 300));
      const retry = mfBot.blockAt(pos);
      if (!retry || retry.name !== expectedName || !mfBot.canDigBlock(retry)) return false;
      mfBot.pathfinder.stop();
      mfBot.clearControlStates();
      try {
        console.log(
          `[Mining] ${username}: retry quebrar "${expectedName}" em (${pos.x}, ${pos.y}, ${pos.z})`,
        );
        await mfBot.dig(retry, true);
        await new Promise(r => setTimeout(r, 400));
        return true;
      } catch {
        console.warn(
          `[Mining] ${username}: falha ao quebrar "${expectedName}" em (${pos.x}, ${pos.y}, ${pos.z})`,
        );
        return false;
      }
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async collect(domainBot: Bot, blockName: string, count: number, onFull?: DepositFn, scaffold = false): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const blockType = mcData.blocksByName[blockName];
    if (!blockType) {
      console.warn(`[Mining] ${domainBot.username}: unknown block "${blockName}"`);
      return;
    }

    const movementsFn = scaffold ? createScaffoldMovements : createMovements;

    domainBot.setState(BotState.MOVING);
    mfBot.pathfinder.setMovements(movementsFn(mfBot));

    let collected = 0;
    const failedPositions = new Set<string>();
    while (collected < count) {
      if (onFull && isInventoryFull(mfBot)) {
        console.log(`[Mining] ${domainBot.username}: inventory full — depositing`);
        await onFull(domainBot);
        mfBot.pathfinder.setMovements(movementsFn(mfBot));
      }

      const block = mfBot.findBlock({
        matching: b => b.type === blockType.id
          && !failedPositions.has(`${b.position.x},${b.position.y},${b.position.z}`)
          && !isBlockUnderwater(mfBot, b.position),
        maxDistance: 128,
      });
      if (!block) {
        const pos = mfBot.entity?.position;
        const posStr = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '?';
        const rawBlock = mfBot.findBlock({ matching: b => b.name.includes('log'), maxDistance: 128 });
        console.warn(`[Mining] ${domainBot.username}: no "${blockName}" in range (pos=${posStr}, anyLog=${rawBlock?.name ?? 'none'}@${rawBlock ? `${Math.floor(rawBlock.position.x)},${Math.floor(rawBlock.position.y)},${Math.floor(rawBlock.position.z)}` : '?'})`);
        break;
      }
      const mined = await this.safeDig(mfBot, domainBot.username, block.position, blockName, mcData);
      if (mined) {
        collected++;
        console.log(`[Mining] ${domainBot.username}: ${blockName} ${collected}/${count}`);
        await escapeWaterIfNeeded(mfBot, domainBot.username);
        mfBot.pathfinder.setMovements(movementsFn(mfBot));
      } else {
        failedPositions.add(`${block.position.x},${block.position.y},${block.position.z}`);
      }
    }

    await escapeWaterIfNeeded(mfBot, domainBot.username);

    // Always deposit after a collect run if a chest is configured, even if
    // we collected fewer blocks than requested (ran out of accessible blocks).
    if (collected > 0 && onFull) {
      console.log(`[Mining] ${domainBot.username}: collect done (${collected}/${count}) — depositing`);
      await onFull(domainBot);
    }

    domainBot.setState(BotState.CONNECTED);

    if (collected === 0) {
      throw new Error(`No accessible "${blockName}" found within range`);
    }
  }

  async collectVein(domainBot: Bot, blockName: string, count: number, onFull?: DepositFn): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const blockType = mcData.blocksByName[blockName];
    if (!blockType) {
      console.warn(`[Mining] ${domainBot.username}: unknown block "${blockName}"`);
      return;
    }

    domainBot.setState(BotState.MOVING);
    mfBot.pathfinder.setMovements(createMovements(mfBot));

    let collected = 0;
    const veinQueue: Vec3[] = [];

    const tryDigAt = async (pos: Vec3): Promise<boolean> => {
      const mined = await this.safeDig(mfBot, domainBot.username, pos, blockName, mcData);
      if (!mined) return false;

      collected++;
      console.log(`[Vein] ${domainBot.username}: ${blockName} ${collected}/${count}`);
      await escapeWaterIfNeeded(mfBot, domainBot.username);
      mfBot.pathfinder.setMovements(createMovements(mfBot));

      // Enqueue all 6 adjacent positions of the same type
      const offsets = [
        new Vec3(1,0,0), new Vec3(-1,0,0),
        new Vec3(0,1,0), new Vec3(0,-1,0),
        new Vec3(0,0,1), new Vec3(0,0,-1),
      ];
      for (const off of offsets) {
        const adj = pos.plus(off);
        const adjBlock = mfBot.blockAt(adj);
        if (adjBlock?.type === blockType.id) veinQueue.push(adj);
      }
      return true;
    };

    while (collected < count) {
      if (onFull && isInventoryFull(mfBot)) {
        console.log(`[Mining] ${domainBot.username}: inventory full — depositing`);
        await onFull(domainBot);
        mfBot.pathfinder.setMovements(createMovements(mfBot));
      }

      while (veinQueue.length > 0 && collected < count) {
        await tryDigAt(veinQueue.shift()!);
      }
      if (collected >= count) break;

      const block = mfBot.findBlock({
        matching: b => b.type === blockType.id
          && !isBlockUnderwater(mfBot, b.position),
        maxDistance: 128,
      });
      if (!block) {
        console.warn(`[Mining] ${domainBot.username}: no "${blockName}" in range`);
        break;
      }
      await tryDigAt(block.position);
    }

    domainBot.setState(BotState.CONNECTED);

    if (collected === 0) {
      throw new Error(`No accessible "${blockName}" found within range`);
    }
  }

  async quarryFromQueue(domainBot: Bot, queue: QuarryQueue, onFull?: DepositFn): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    domainBot.setState(BotState.MOVING);

    while (!queue.isEmpty()) {
      if (onFull && isInventoryFull(mfBot)) {
        console.log(`[Quarry] ${domainBot.username}: inventory full — depositing`);
        await onFull(domainBot);
        mfBot.pathfinder.setMovements(createMovements(mfBot));
      }

      const pos = queue.next();
      if (!pos) break;

      const block = mfBot.blockAt(pos);
      if (!block || block.name === 'air' || block.name === 'cave_air') continue;

      const mined = await this.safeDig(mfBot, domainBot.username, pos, block.name, mcData);
      if (mined) {
        queue.markDone();
        console.log(`[Quarry] ${domainBot.username}: mined [${queue.progress}]`);
        mfBot.pathfinder.setMovements(createMovements(mfBot));
      } else {
        queue.putBack(pos);
      }
    }

    domainBot.setState(BotState.CONNECTED);
  }
}
