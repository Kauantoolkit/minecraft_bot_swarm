import { Role, ColonyPhase, BotRecord } from './GlobalState';
/**
 * Determines which role each bot should have given the current swarm size.
 * Returns an ordered list aligned with the bot array passed in.
 *
 * Rough ratios (adjustable):
 *   1 bot  → 1 miner
 *   2 bots → 2 miners
 *   3 bots → 2 miners, 1 hauler
 *   5 bots → 3 miners, 1 hauler, 1 builder
 *   N bots → 50 % miners, 15 % haulers, 15 % builders, 10 % farmers, 10 % soldiers
 */
export declare function assignRoles(botCount: number): Role[];
/** Ordered list of task types a role should prefer. */
export declare const ROLE_TASK_PRIORITY: Record<Role, string[]>;
export declare function mineTargetForPhase(phase: ColonyPhase): string;
export declare function isInventoryFull(record: BotRecord): boolean;
//# sourceMappingURL=RoleSystem.d.ts.map