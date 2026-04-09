import type { BotSnapshot, TaskStatus, SerializedVec3 } from '../ipc/messages';

export type Role =
  | 'miner'
  | 'hauler'
  | 'builder'
  | 'farmer'
  | 'soldier'
  | 'unassigned';

export type ColonyPhase =
  | 'bootstrap'          // no tools, gather wood first
  | 'resource_gathering' // stone/iron tools, mine resources
  | 'base_building'      // enough materials, build a base
  | 'expansion'          // expand farm / mine deeper
  | 'combat';            // active threat

/** Full view of a single bot maintained by the Orchestrator. */
export interface BotRecord extends BotSnapshot {
  role: Role;
  failCount: number;    // consecutive task failures — used for role rebalancing
  lastTaskAt: number;   // epoch ms
}

/** Shared colony state — lives in the main thread only. */
export interface GlobalState {
  bots:          Map<string, BotRecord>;
  storagePos:    SerializedVec3 | null;
  resources:     Map<string, number>;  // item name → approx count in storage
  threats:       Set<string>;          // hostile player usernames
  phase:         ColonyPhase;
}

export function createGlobalState(): GlobalState {
  return {
    bots:       new Map(),
    storagePos: null,
    resources:  new Map(),
    threats:    new Set(),
    phase:      'bootstrap',
  };
}

/** Merge a fresh BotSnapshot into an existing BotRecord, preserving role/failCount. */
export function applySnapshot(record: BotRecord, snap: BotSnapshot): void {
  // Preserve orchestrator-owned fields — the worker always sends role:'unassigned'
  // and Object.assign would overwrite the role the orchestrator just assigned.
  const { role, failCount, lastTaskAt } = record;
  Object.assign(record, snap);
  record.role        = role;
  record.failCount   = failCount;
  record.lastTaskAt  = lastTaskAt;
}
