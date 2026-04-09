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
export declare function clampVelocity(vec: Vec3): Vec3;
export declare function vecIsNaN(vec: Vec3): boolean;
/**
 * General-purpose movements: avoids fatal blocks, water is costly but passable.
 * Used for follow, guard, explore, and all non-mining travel.
 */
export declare function createMovements(mfBot: MineflayerBot): Movements;
/**
 * Scaffolding movements: same as general but the pathfinder will place dirt/
 * cobblestone/etc. from inventory to climb up to blocks that are otherwise
 * out of reach (like upper tree logs).
 */
export declare function createScaffoldMovements(mfBot: MineflayerBot): Movements;
/**
 * Dry movements: water is completely impassable, same as lava.
 * Used by mining navigation — if no dry path exists the pathfinder returns
 * noPath and the mining loop skips to the next candidate block.
 */
export declare function createDryMovements(mfBot: MineflayerBot): Movements;
export declare function installPhysicsPatches(domainBot: Bot): void;
//# sourceMappingURL=PhysicsPatch.d.ts.map