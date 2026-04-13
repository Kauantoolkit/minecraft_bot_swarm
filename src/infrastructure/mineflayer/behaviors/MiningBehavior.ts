import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { QuarryQueue } from '../../mining/QuarryQueue';
import { MetaStore } from '../BotMeta';
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
  const pos = mfBot.entity?.position;
  if (!pos) return;
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

// Block material → best tool category when harvestTools is absent
const MATERIAL_TOOL: Record<string, string> = {
  wood:   'axe',
  plant:  'axe',
  leaves: 'axe',
  rock:   'pickaxe',
  dirt:   'shovel',
  sand:   'shovel',
  clay:   'shovel',
};

export class MiningBehavior {
  constructor(private readonly meta: MetaStore) {}

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Equips the best available tool for the given block.
   * 1. If the block defines harvestTools, use those.
   * 2. Otherwise fall back to MATERIAL_TOOL mapping (e.g. logs → axe).
   * Adds a short delay after equipping so the server registers the switch.
   */
  private async autoEquipToolFor(
    mfBot: MineflayerBot,
    block: ReturnType<MineflayerBot['blockAt']>,
    mcData: unknown,
  ): Promise<void> {
    if (!block) return;
    const md = mcData as Record<string, unknown>;

    const blockDef = (md['blocks'] as Record<number, { harvestTools?: Record<string, boolean>; material?: string }>)[block.type];

    let toolCategory: string | null = null;

    if (blockDef?.harvestTools) {
      // Find which TOOL_PRIORITY category contains a valid harvest tool for this block
      const validToolIds = new Set(Object.keys(blockDef.harvestTools).map(Number));
      for (const [category, tools] of Object.entries(TOOL_PRIORITY)) {
        for (const toolName of tools) {
          const toolDef = (md['itemsByName'] as Record<string, { id: number }>)[toolName];
          if (toolDef && validToolIds.has(toolDef.id)) { toolCategory = category; break; }
        }
        if (toolCategory) break;
      }
    } else if (blockDef?.material) {
      toolCategory = MATERIAL_TOOL[blockDef.material] ?? null;
    }

    if (!toolCategory) return;

    const candidates = TOOL_PRIORITY[toolCategory] ?? [];
    for (const toolName of candidates) {
      const toolDef = (md['itemsByName'] as Record<string, { id: number }>)[toolName];
      if (!toolDef) continue;
      const item = (mfBot.inventory.items() as Array<{ type: number }>).find(i => i.type === toolDef.id);
      if (item) {
        await mfBot.equip(item as Parameters<MineflayerBot['equip']>[0], 'hand');
        // Give the server a tick to register the item switch
        await new Promise(r => setTimeout(r, 150));
        return;
      }
    }
  }

  /**
   * Navigate to a block, stop pathfinder, then dig with a fresh reference.
   * Returns:
   *   'mined'       — block successfully broken
   *   'gone'        — block disappeared or changed before/during dig
   *   'unreachable' — bot could not get within reach after navigation
   *   'failed'      — dig was attempted but rejected by the server
   */
  private async safeDig(
    domainBot: Bot,
    mfBot: MineflayerBot,
    pos: Vec3,
    expectedName: string,
    mcData: ReturnType<typeof require>,
  ): Promise<'mined' | 'gone' | 'unreachable' | 'failed'> {
    await new Promise<void>((res) => {
      const onReach = () => { clearTimeout(timer); res(); };
      const timer = setTimeout(() => { mfBot.off('goal_reached', onReach); res(); }, 8000);
      mfBot.pathfinder.setGoal(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
      mfBot.once('goal_reached', onReach);
    });

    const block = mfBot.blockAt(pos);
    if (!block || block.name !== expectedName) {
      console.warn(`[safeDig] ${domainBot.username}: block gone or changed after nav (expected ${expectedName})`);
      return 'gone';
    }
    const entityPos = mfBot.entity?.position;
    if (!entityPos) {
      console.warn(`[safeDig] ${domainBot.username}: entity position unavailable — deferring`);
      return 'unreachable';
    }
    const dist = block.position.distanceTo(entityPos);
    if (dist > 5) {
      console.warn(`[safeDig] ${domainBot.username}: too far after nav (${dist.toFixed(1)}m) for ${expectedName} — marking unreachable`);
      return 'unreachable';
    }

    await this.autoEquipToolFor(mfBot, block, mcData);

    // Re-fetch block after possible tool equip delay
    const freshBlock = mfBot.blockAt(pos);
    if (!freshBlock || freshBlock.name !== expectedName) return 'gone';

    const canDig = mfBot.canDigBlock(freshBlock);
    const heldItem = (mfBot.heldItem as { name?: string } | null)?.name ?? 'hand';
    console.log(`[safeDig] ${domainBot.username}: ${expectedName} canDig=${canDig} held=${heldItem} onGround=${mfBot.entity.onGround}`);
    if (!canDig) return 'failed';

    const botMeta = this.meta.get(domainBot);
    // Set the flag BEFORE stopping pathfinder — DefendBehavior checks this
    // on every physicsTick and must see it before any pathfinder event fires.
    botMeta.digging = true;
    mfBot.pathfinder.stop();
    mfBot.clearControlStates();
    // Brief settle so the bot lands before digging
    await new Promise(r => setTimeout(r, 100));

    console.log(`[safeDig] ${domainBot.username}: starting dig ${expectedName} @ ${pos.x},${pos.y},${pos.z}`);

    const tryDig = async (b: NonNullable<ReturnType<MineflayerBot['blockAt']>>): Promise<boolean> => {
      try {
        await Promise.race([
          mfBot.dig(b, true),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dig timeout')), 30_000)),
        ]);
      } catch (err) {
        console.warn(`[safeDig] ${domainBot.username}: dig() threw: ${(err as Error).message}`);
        return false;
      }

      // After dig() resolves (client-side timer done), listen for a server
      // block_change at this position. If the server restores the block within
      // 1 s, the dig was rejected. If nothing arrives, the break was accepted.
      return new Promise<boolean>((resolve) => {
        let settled = false;

        type BlockChangePacket = { location: { x: number; y: number; z: number }; type: number };
        const onBlockChange = (packet: BlockChangePacket) => {
          if (settled) return;
          if (packet.location.x !== pos.x || packet.location.y !== pos.y || packet.location.z !== pos.z) return;
          const restoredId = packet.type >> 4; // block state → block id
          if (restoredId !== 0) {
            // Server sent back a non-air block → dig rejected
            settled = true;
            clearTimeout(timer);
            (mfBot._client as NodeJS.EventEmitter).removeListener('block_change', onBlockChange);
            console.warn(`[safeDig] ${domainBot.username}: server rejected dig @ ${pos.x},${pos.y},${pos.z} (block_change received)`);
            resolve(false);
          }
        };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          (mfBot._client as NodeJS.EventEmitter).removeListener('block_change', onBlockChange);
          const after = mfBot.blockAt(pos);
          const broke = !after || after.name !== expectedName;
          console.log(`[safeDig] ${domainBot.username}: after dig @ ${pos.x},${pos.y},${pos.z} → block=${after?.name ?? 'null'} broke=${broke}`);
          resolve(broke);
        }, 1000);

        (mfBot._client as NodeJS.EventEmitter).on('block_change', onBlockChange);
      });
    };

    try {
      if (await tryDig(freshBlock)) return 'mined';

      // One retry — bot stays in place
      await new Promise(r => setTimeout(r, 300));
      const retry = mfBot.blockAt(pos);
      if (!retry || retry.name !== expectedName || !mfBot.canDigBlock(retry)) return 'failed';
      return await tryDig(retry) ? 'mined' : 'failed';
    } finally {
      botMeta.digging = false;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async collect(domainBot: Bot, blockName: string | string[], count: number, onFull?: DepositFn, scaffold = false): Promise<void> {
    if (count <= 0) return;
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);

    // Resolve one or many block names to a set of type IDs
    const names = Array.isArray(blockName) ? blockName : [blockName];
    const typeIdToName = new Map<number, string>();
    for (const name of names) {
      const bt = mcData.blocksByName[name];
      if (bt) typeIdToName.set(bt.id, name);
      else console.warn(`[Mining] ${domainBot.username}: unknown block "${name}"`);
    }
    if (typeIdToName.size === 0) return;

    const label = names.length === 1 ? names[0] : `[${names.slice(0,3).join('|')}${names.length > 3 ? '…' : ''}]`;
    const movementsFn = scaffold ? createScaffoldMovements : createMovements;

    domainBot.setState(BotState.MOVING);
    mfBot.pathfinder.setMovements(movementsFn(mfBot));

    // Positions that the bot could not reach during this collect session — skip them.
    const unreachable = new Set<string>();
    const posKey = (v: Vec3 | null | undefined): string => v ? `${v.x},${v.y},${v.z}` : '';

    let collected = 0;
    while (collected < count) {
      if (onFull && isInventoryFull(mfBot)) {
        console.log(`[Mining] ${domainBot.username}: inventory full — depositing`);
        try {
          await onFull(domainBot);
        } catch (err) {
          console.warn(`[Mining] ${domainBot.username}: depósito falhou, parando coleta: ${(err as Error).message}`);
          break;
        }
        mfBot.pathfinder.setMovements(movementsFn(mfBot));
      }

      // Find nearest reachable block: prefer accessible blocks near bot's Y level,
      // fall back to any non-underwater match if none found.
      const botY = mfBot.entity?.position?.y ?? 0;
      const block =
        mfBot.findBlock({
          matching: b =>
            typeIdToName.has(b.type) &&
            !isBlockUnderwater(mfBot, b.position) &&
            isBlockAccessible(mfBot, b.position) &&
            !unreachable.has(posKey(b.position)) &&
            Math.abs(b.position.y - botY) <= 4,
          maxDistance: 64,
        }) ??
        mfBot.findBlock({
          matching: b =>
            typeIdToName.has(b.type) &&
            !isBlockUnderwater(mfBot, b.position) &&
            !unreachable.has(posKey(b.position)),
          maxDistance: 128,
        });
      if (!block) {
        const pos = mfBot.entity?.position;
        const posStr = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '?';
        console.warn(`[Mining] ${domainBot.username}: no ${label} in range (pos=${posStr})`);
        break;
      }

      const foundName = typeIdToName.get(block.type)!;
      const result = await this.safeDig(domainBot, mfBot, block.position, foundName, mcData);
      if (result === 'mined') {
        collected++;
        console.log(`[Mining] ${domainBot.username}: ${foundName} ${collected}/${count}`);
        await escapeWaterIfNeeded(mfBot, domainBot.username);
        mfBot.pathfinder.setMovements(movementsFn(mfBot));
      } else if (result === 'unreachable') {
        unreachable.add(posKey(block.position));
      }
    }

    await escapeWaterIfNeeded(mfBot, domainBot.username);

    if (collected > 0 && onFull) {
      console.log(`[Mining] ${domainBot.username}: collect done (${collected}/${count}) — depositing`);
      await onFull(domainBot);
    }

    domainBot.setState(BotState.CONNECTED);

    if (collected === 0) {
      throw new Error(`No accessible ${label} found within range`);
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

    const unreachable = new Set<string>();
    const posKey = (v: Vec3 | null | undefined): string => v ? `${v.x},${v.y},${v.z}` : '';

    const tryDigAt = async (pos: Vec3): Promise<boolean> => {
      const result = await this.safeDig(domainBot, mfBot, pos, blockName, mcData);
      if (result === 'unreachable') { unreachable.add(posKey(pos)); return false; }
      if (result !== 'mined') return false;

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
        try {
          await onFull(domainBot);
        } catch (err) {
          console.warn(`[Mining] ${domainBot.username}: depósito falhou, parando coleta: ${(err as Error).message}`);
          break;
        }
        mfBot.pathfinder.setMovements(createMovements(mfBot));
      }

      while (veinQueue.length > 0 && collected < count) {
        await tryDigAt(veinQueue.shift()!);
      }
      if (collected >= count) break;

      const block = mfBot.findBlock({
        matching: b =>
          b.type === blockType.id &&
          !isBlockUnderwater(mfBot, b.position) &&
          !unreachable.has(posKey(b.position)),
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
        try {
          await onFull(domainBot);
        } catch (err) {
          console.warn(`[Quarry] ${domainBot.username}: depósito falhou, parando quarry: ${(err as Error).message}`);
          break;
        }
        mfBot.pathfinder.setMovements(createMovements(mfBot));
      }

      const pos = queue.next();
      if (!pos) break;

      const block = mfBot.blockAt(pos);
      if (!block || block.name === 'air' || block.name === 'cave_air') continue;

      const result = await this.safeDig(domainBot, mfBot, pos, block.name, mcData);
      if (result === 'mined') {
        queue.markDone();
        console.log(`[Quarry] ${domainBot.username}: mined [${queue.progress}]`);
        mfBot.pathfinder.setMovements(createMovements(mfBot));
      } else if (result === 'unreachable') {
        // Skip permanently unreachable positions rather than looping forever.
        console.warn(`[Quarry] ${domainBot.username}: skipping unreachable pos ${pos.x},${pos.y},${pos.z}`);
        queue.markDone();
      } else {
        queue.putBack(pos);
      }
    }

    domainBot.setState(BotState.CONNECTED);
  }
}
