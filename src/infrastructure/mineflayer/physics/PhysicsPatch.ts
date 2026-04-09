/**
 * Physics patches for mineflayer 1.21.
 *
 * Mineflayer occasionally produces NaN/Inf velocity vectors on 1.21 servers,
 * which crashes the internal physics simulation and freezes the bot in place.
 * These patches intercept velocity at three layers to prevent that:
 *
 *   1. Velocity property setter on the entity object — clamps on assignment.
 *   2. entity_velocity network packet handler — drops packets with NaN values.
 *   3. Watchdog setInterval — detects and corrects NaN velocity every 50 ms.
 */

import { Bot as MineflayerBot } from 'mineflayer';
import { Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { ts } from '../utils';

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function clampVelocity(vec: Vec3): Vec3 {
  return new Vec3(
    isNaN(vec.x) || !isFinite(vec.x) ? 0 : vec.x,
    isNaN(vec.y) || !isFinite(vec.y) ? 0 : vec.y,
    isNaN(vec.z) || !isFinite(vec.z) ? 0 : vec.z,
  );
}

export function vecIsNaN(vec: Vec3): boolean {
  return isNaN(vec.x) || isNaN(vec.y) || isNaN(vec.z);
}

// ─── Movement factory ─────────────────────────────────────────────────────────

// Blocks that are always impassable regardless of movement mode.
const FATAL_BLOCK_NAMES = [
  'lava', 'flowing_lava',
  'fire', 'soul_fire',
  'magma_block',
  'cactus',
  'sweet_berry_bush',
  'wither_rose',
  'cobweb',
];

// Additional blocks treated as impassable in "dry" mode (mining navigation).
const WATER_BLOCK_NAMES = ['water', 'flowing_water'];

// Blocks the bot can place as scaffolding to climb up (checked against inventory).
const SCAFFOLDING_BLOCK_NAMES = [
  'dirt', 'cobblestone', 'stone', 'gravel', 'sand',
  'netherrack', 'cobbled_deepslate', 'andesite', 'diorite', 'granite',
];

type McData = { blocksByName: Record<string, { id: number } | undefined>; itemsByName: Record<string, { id: number } | undefined> };

function buildMovements(mfBot: MineflayerBot, avoidWater: boolean, scaffold = false): Movements {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mcData = require('minecraft-data')(mfBot.version) as McData;
  const movements = new Movements(mfBot);
  movements.allowSprinting = true;
  movements.maxDropDown    = 3;

  const avoid = avoidWater
    ? [...FATAL_BLOCK_NAMES, ...WATER_BLOCK_NAMES]
    : FATAL_BLOCK_NAMES;

  for (const name of avoid) {
    const block = mcData.blocksByName[name];
    if (block) movements.blocksToAvoid.add(block.id);
  }

  if (!avoidWater) {
    // General travel: water is traversable but 10× more costly than land.
    (movements as unknown as Record<string, unknown>)['liquidCost'] = 10;
  }

  if (scaffold) {
    // Allow the pathfinder to place blocks to climb up (like Baritone).
    (movements as unknown as Record<string, unknown>)['canDig'] = true;
    (movements as unknown as Record<string, unknown>)['allow1by1towers'] = true;
    const scaffoldIds: number[] = [];
    const inventoryItems = mfBot.inventory.items() as Array<{ type: number }>;
    for (const name of SCAFFOLDING_BLOCK_NAMES) {
      const itemDef = mcData.itemsByName[name];
      if (!itemDef) continue;
      if (inventoryItems.some(i => i.type === itemDef.id)) {
        scaffoldIds.push(itemDef.id);
      }
    }
    (movements as unknown as Record<string, unknown>)['scaffoldingBlocks'] = scaffoldIds;
  }

  return movements;
}

/**
 * General-purpose movements: avoids fatal blocks, water is costly but passable.
 * Used for follow, guard, explore, and all non-mining travel.
 */
export function createMovements(mfBot: MineflayerBot): Movements {
  return buildMovements(mfBot, false);
}

/**
 * Scaffolding movements: same as general but the pathfinder will place dirt/
 * cobblestone/etc. from inventory to climb up to blocks that are otherwise
 * out of reach (like upper tree logs).
 */
export function createScaffoldMovements(mfBot: MineflayerBot): Movements {
  return buildMovements(mfBot, false, true);
}

/**
 * Dry movements: water is completely impassable, same as lava.
 * Used by mining navigation — if no dry path exists the pathfinder returns
 * noPath and the mining loop skips to the next candidate block.
 */
export function createDryMovements(mfBot: MineflayerBot): Movements {
  return buildMovements(mfBot, true);
}

// ─── Patch installer ──────────────────────────────────────────────────────────

export function installPhysicsPatches(domainBot: Bot): void {
  const mfBot = domainBot.handle as MineflayerBot;
  if (!mfBot?.entity) return;

  const entity = mfBot.entity;

  // Patch 1: Override velocity setter → clamp NaN/Inf on assignment.
  const oldVelocity = Object.getOwnPropertyDescriptor(entity, 'velocity');
  if (oldVelocity?.set) {
    Object.defineProperty(entity, 'velocity', {
      set(v: Vec3) { oldVelocity.set!.call(this, clampVelocity(v)); },
      get: oldVelocity.get,
      configurable: true,
    });
  }

  // Patch 2: Intercept entity_velocity packets — drop if any component is NaN.
  const clientWrite = mfBot._client.write.bind(mfBot._client);
  mfBot._client.write = function (channel: string, packet: any) {
    if (channel === 'play' && packet.name === 'entity_velocity') {
      const vx = packet.params.velocityX / 8000.0;
      const vy = packet.params.velocityY / 8000.0;
      const vz = packet.params.velocityZ / 8000.0;
      if (isNaN(vx) || isNaN(vy) || isNaN(vz)) {
        console.warn(`[${ts()}] PhysicsPatch: Ignored NaN velocity packet for ${mfBot.username}`);
        return;
      }
    }
    return clientWrite(channel, packet);
  };

  // Patch 3: Watchdog — corrects NaN velocity/position and stuck physicsEnabled every 50 ms.
  let lastGoodPos: Vec3 | null = null;
  const watchdog = setInterval(() => {
    if (!mfBot.entity?.velocity) return;

    if (!mfBot.physicsEnabled) {
      console.warn(`[${ts()}] PhysicsPatch: Forced physicsEnabled=true → ${mfBot.username}`);
      mfBot.physicsEnabled = true;
    }

    // Position NaN guard — must run before velocity clamp so we have a safe base.
    const pos = mfBot.entity.position;
    if (isNaN(pos.x) || isNaN(pos.y) || isNaN(pos.z)) {
      if (lastGoodPos) {
        pos.x = lastGoodPos.x;
        pos.y = lastGoodPos.y;
        pos.z = lastGoodPos.z;
        mfBot.entity.velocity = new Vec3(0, -0.08, 0);
        mfBot.clearControlStates();
        console.warn(`[${ts()}] PhysicsPatch: Restored NaN position → ${mfBot.username} (${Math.floor(lastGoodPos.x)},${Math.floor(lastGoodPos.y)},${Math.floor(lastGoodPos.z)})`);
      }
    } else {
      lastGoodPos = pos.clone();
    }

    if (vecIsNaN(mfBot.entity.velocity)) {
      mfBot.entity.velocity = clampVelocity(mfBot.entity.velocity);
      mfBot.clearControlStates();
      console.log(`[${ts()}] PhysicsPatch: Clamped NaN velocity → ${mfBot.username}`);

      const below = mfBot.blockAt(mfBot.entity.position.offset(0, -0.5, 0));
      if (!below || below.boundingBox === 'empty') {
        mfBot.entity.velocity = new Vec3(0, -0.08, 0);
      }
    }
  }, 50);
  mfBot.once('end', () => clearInterval(watchdog));

  console.log(`[${ts()}] ✅ PhysicsPatches ACTIVE for ${domainBot.username}`);
}
