import type { BotSnapshot, SerializedVec3 } from '../ipc/messages';
export type Role = 'miner' | 'hauler' | 'builder' | 'farmer' | 'soldier' | 'unassigned';
export type ColonyPhase = 'bootstrap' | 'resource_gathering' | 'base_building' | 'expansion' | 'combat';
/** Full view of a single bot maintained by the Orchestrator. */
export interface BotRecord extends BotSnapshot {
    role: Role;
    failCount: number;
    lastTaskAt: number;
}
/** Shared colony state — lives in the main thread only. */
export interface GlobalState {
    bots: Map<string, BotRecord>;
    storagePos: SerializedVec3 | null;
    resources: Map<string, number>;
    threats: Set<string>;
    phase: ColonyPhase;
}
export declare function createGlobalState(): GlobalState;
/** Merge a fresh BotSnapshot into an existing BotRecord, preserving role/failCount. */
export declare function applySnapshot(record: BotRecord, snap: BotSnapshot): void;
//# sourceMappingURL=GlobalState.d.ts.map