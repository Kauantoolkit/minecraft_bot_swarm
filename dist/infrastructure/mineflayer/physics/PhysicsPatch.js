"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.clampVelocity = clampVelocity;
exports.vecIsNaN = vecIsNaN;
exports.createMovements = createMovements;
exports.createDryMovements = createDryMovements;
exports.installPhysicsPatches = installPhysicsPatches;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const vec3_1 = require("vec3");
const utils_1 = require("../utils");
// ─── Pure helpers ─────────────────────────────────────────────────────────────
function clampVelocity(vec) {
    return new vec3_1.Vec3(isNaN(vec.x) || !isFinite(vec.x) ? 0 : vec.x, isNaN(vec.y) || !isFinite(vec.y) ? 0 : vec.y, isNaN(vec.z) || !isFinite(vec.z) ? 0 : vec.z);
}
function vecIsNaN(vec) {
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
function buildMovements(mfBot, avoidWater) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const movements = new mineflayer_pathfinder_1.Movements(mfBot);
    movements.allowSprinting = true;
    movements.maxDropDown = 3;
    const avoid = avoidWater
        ? [...FATAL_BLOCK_NAMES, ...WATER_BLOCK_NAMES]
        : FATAL_BLOCK_NAMES;
    for (const name of avoid) {
        const block = mcData.blocksByName[name];
        if (block)
            movements.blocksToAvoid.add(block.id);
    }
    if (!avoidWater) {
        // General travel: water is traversable but 10× more costly than land.
        movements['liquidCost'] = 10;
    }
    return movements;
}
/**
 * General-purpose movements: avoids fatal blocks, water is costly but passable.
 * Used for follow, guard, explore, and all non-mining travel.
 */
function createMovements(mfBot) {
    return buildMovements(mfBot, false);
}
/**
 * Dry movements: water is completely impassable, same as lava.
 * Used by mining navigation — if no dry path exists the pathfinder returns
 * noPath and the mining loop skips to the next candidate block.
 */
function createDryMovements(mfBot) {
    return buildMovements(mfBot, true);
}
// ─── Patch installer ──────────────────────────────────────────────────────────
function installPhysicsPatches(domainBot) {
    const mfBot = domainBot.handle;
    if (!mfBot?.entity)
        return;
    const entity = mfBot.entity;
    // Patch 1: Override velocity setter → clamp NaN/Inf on assignment.
    const oldVelocity = Object.getOwnPropertyDescriptor(entity, 'velocity');
    if (oldVelocity?.set) {
        Object.defineProperty(entity, 'velocity', {
            set(v) { oldVelocity.set.call(this, clampVelocity(v)); },
            get: oldVelocity.get,
            configurable: true,
        });
    }
    // Patch 2: Intercept entity_velocity packets — drop if any component is NaN.
    const clientWrite = mfBot._client.write.bind(mfBot._client);
    mfBot._client.write = function (channel, packet) {
        if (channel === 'play' && packet.name === 'entity_velocity') {
            const vx = packet.params.velocityX / 8000.0;
            const vy = packet.params.velocityY / 8000.0;
            const vz = packet.params.velocityZ / 8000.0;
            if (isNaN(vx) || isNaN(vy) || isNaN(vz)) {
                console.warn(`[${(0, utils_1.ts)()}] PhysicsPatch: Ignored NaN velocity packet for ${mfBot.username}`);
                return;
            }
        }
        return clientWrite(channel, packet);
    };
    // Patch 3: Watchdog — corrects NaN velocity and stuck physicsEnabled every 50 ms.
    const watchdog = setInterval(() => {
        if (!mfBot.entity?.velocity)
            return;
        if (!mfBot.physicsEnabled) {
            console.warn(`[${(0, utils_1.ts)()}] PhysicsPatch: Forced physicsEnabled=true → ${mfBot.username}`);
            mfBot.physicsEnabled = true;
        }
        if (vecIsNaN(mfBot.entity.velocity)) {
            mfBot.entity.velocity = clampVelocity(mfBot.entity.velocity);
            mfBot.clearControlStates();
            console.log(`[${(0, utils_1.ts)()}] PhysicsPatch: Clamped NaN velocity → ${mfBot.username}`);
        }
    }, 50);
    mfBot.once('end', () => clearInterval(watchdog));
    console.log(`[${(0, utils_1.ts)()}] ✅ PhysicsPatches ACTIVE for ${domainBot.username}`);
}
//# sourceMappingURL=PhysicsPatch.js.map