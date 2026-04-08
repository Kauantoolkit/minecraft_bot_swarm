/** Hostile mob types that defend and bodyguard modes react to. */
export declare const HOSTILE_MOBS: Set<string>;
/**
 * Mobs that cannot be reached by ground pathfinding.
 * Bots hold ground and only swing when they swoop close enough,
 * instead of using GoalFollow which produces endless partial/noPath cycles.
 */
export declare const AERIAL_MOBS: Set<string>;
/** Distance at which a creeper triggers flee behaviour. */
export declare const CREEPER_FLEE_RADIUS = 7;
//# sourceMappingURL=constants.d.ts.map