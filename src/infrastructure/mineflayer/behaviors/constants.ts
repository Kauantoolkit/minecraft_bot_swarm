/** Hostile mob types that defend and bodyguard modes react to. */
export const HOSTILE_MOBS = new Set([
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
export const AERIAL_MOBS = new Set(['phantom', 'ghast', 'blaze', 'bat', 'bee', 'vex']);

/** Distance at which a creeper triggers flee behaviour. */
export const CREEPER_FLEE_RADIUS = 7;
