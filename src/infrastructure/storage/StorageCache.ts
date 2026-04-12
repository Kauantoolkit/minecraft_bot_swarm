import * as fs from 'fs';
import * as path from 'path';
import { Vec3 } from 'vec3';
import { instanceDataDir } from '../../config';

interface StorageEntry {
  label: string;
  x: number;
  y: number;
  z: number;
}

const PERSIST_FILE = path.join(instanceDataDir, 'storages.json');

/**
 * Registry of known storage containers (chests, barrels, etc.).
 *
 * Entries are registered by the operator via `store register <label> <x> <y> <z>`
 * and persisted to storages.json between restarts.
 *
 * Behaviors use getNearest() to find the closest chest to deposit into,
 * or getByLabel() when a specific storage is requested.
 */
export class StorageCache {
  private entries: StorageEntry[] = [];

  constructor() {
    this.load();
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  register(label: string, pos: Vec3): void {
    const existing = this.entries.findIndex(e => e.label === label);
    const entry: StorageEntry = { label, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    if (existing >= 0) {
      this.entries[existing] = entry;
      console.log(`[Storage] Updated "${label}" → (${entry.x}, ${entry.y}, ${entry.z})`);
    } else {
      this.entries.push(entry);
      console.log(`[Storage] Registered "${label}" → (${entry.x}, ${entry.y}, ${entry.z})`);
    }
    this.save();
  }

  remove(label: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.label !== label);
    if (this.entries.length < before) { this.save(); return true; }
    return false;
  }

  // ─── Lookup ────────────────────────────────────────────────────────────────

  getByLabel(label: string): Vec3 | null {
    const e = this.entries.find(e => e.label === label);
    return e ? new Vec3(e.x, e.y, e.z) : null;
  }

  getNearest(botPos: Vec3): { label: string; pos: Vec3 } | null {
    if (this.entries.length === 0) return null;
    let best = this.entries[0];
    let bestDist = botPos.distanceTo(new Vec3(best.x, best.y, best.z));
    for (const e of this.entries.slice(1)) {
      const d = botPos.distanceTo(new Vec3(e.x, e.y, e.z));
      if (d < bestDist) { best = e; bestDist = d; }
    }
    return { label: best.label, pos: new Vec3(best.x, best.y, best.z) };
  }

  list(): Array<{ label: string; pos: Vec3 }> {
    return this.entries.map(e => ({ label: e.label, pos: new Vec3(e.x, e.y, e.z) }));
  }

  /** Register multiple chests at once (from an auto-scan). Skips duplicates. */
  registerMany(prefix: string, positions: Array<{ x: number; y: number; z: number }>): number {
    let added = 0;
    for (const pos of positions) {
      const isDupe = this.entries.some(
        e => e.x === Math.floor(pos.x) && e.y === Math.floor(pos.y) && e.z === Math.floor(pos.z),
      );
      if (isDupe) continue;
      const label = `${prefix}_${this.entries.filter(e => e.label.startsWith(prefix)).length}`;
      this.entries.push({ label, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
      added++;
    }
    if (added > 0) {
      this.save();
      console.log(`[Storage] Auto-registered ${added} chest(s) under prefix "${prefix}"`);
    }
    return added;
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (fs.existsSync(PERSIST_FILE)) {
        this.entries = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
        console.log(`[Storage] Loaded ${this.entries.length} storage(s) from storages.json`);
      }
    } catch {
      console.warn('[Storage] Could not load storages.json — starting empty');
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(this.entries, null, 2));
    } catch {
      console.warn('[Storage] Could not save storages.json');
    }
  }
}
