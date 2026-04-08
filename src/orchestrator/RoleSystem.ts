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
export function assignRoles(botCount: number): Role[] {
  if (botCount <= 0) return [];
  if (botCount === 1) return ['miner'];
  if (botCount === 2) return ['miner', 'miner'];
  if (botCount === 3) return ['miner', 'miner', 'hauler'];
  if (botCount === 4) return ['miner', 'miner', 'hauler', 'builder'];
  if (botCount === 5) return ['miner', 'miner', 'miner', 'hauler', 'builder'];

  const miners   = Math.max(1, Math.round(botCount * 0.50));
  const haulers  = Math.max(1, Math.round(botCount * 0.15));
  const builders = Math.max(1, Math.round(botCount * 0.15));
  const farmers  = Math.max(0, Math.round(botCount * 0.10));
  const soldiers = Math.max(0, botCount - miners - haulers - builders - farmers);

  return [
    ...fill('miner',   miners),
    ...fill('hauler',  haulers),
    ...fill('builder', builders),
    ...fill('farmer',  farmers),
    ...fill('soldier', soldiers),
  ];
}

function fill(role: Role, n: number): Role[] {
  return Array(n).fill(role);
}

// ── Task priority per role ────────────────────────────────────────────────────

/** Ordered list of task types a role should prefer. */
export const ROLE_TASK_PRIORITY: Record<Role, string[]> = {
  miner:      ['mine', 'collect_wood', 'deposit', 'idle'],
  hauler:     ['deposit', 'mine', 'idle'],
  builder:    ['collect_wood', 'deposit', 'idle'],
  farmer:     ['farm', 'idle'],
  soldier:    ['guard', 'idle'],
  unassigned: ['idle'],
};

// ── Phase → mine target ───────────────────────────────────────────────────────

export function mineTargetForPhase(phase: ColonyPhase): string {
  switch (phase) {
    case 'bootstrap':          return 'oak_log';
    case 'resource_gathering': return 'iron_ore';
    case 'base_building':      return 'stone';
    case 'expansion':          return 'diamond_ore';
    case 'combat':             return 'stone'; // keep gathering during combat
  }
}

// ── Inventory fullness check ──────────────────────────────────────────────────

export function isInventoryFull(record: BotRecord): boolean {
  const total = record.inventory.reduce((s, i) => s + i.count, 0);
  return total >= 32; // conservative threshold
}
