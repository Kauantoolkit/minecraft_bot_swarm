"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CREEPER_FLEE_RADIUS = exports.AERIAL_MOBS = exports.HOSTILE_MOBS = void 0;
/** Hostile mob types that defend and bodyguard modes react to. */
exports.HOSTILE_MOBS = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
    'witch', 'pillager', 'vindicator', 'ravager', 'phantom', 'drowned',
    'husk', 'stray', 'wither_skeleton', 'blaze', 'ghast', 'magma_cube',
    'slime', 'silverfish', 'endermite', 'guardian', 'elder_guardian',
    'shulker', 'vex', 'evoker', 'zombie_villager', 'piglin_brute',
    'zoglin', 'hoglin', 'warden',
]);
/**
 * Mobs that cannot be reached by ground pathfinding.
 * Bots hold ground and only swing when they swoop close enough,
 * instead of using GoalFollow which produces endless partial/noPath cycles.
 */
exports.AERIAL_MOBS = new Set(['phantom', 'ghast', 'blaze', 'bat', 'bee', 'vex']);
/** Distance at which a creeper triggers flee behaviour. */
exports.CREEPER_FLEE_RADIUS = 7;
//# sourceMappingURL=constants.js.map