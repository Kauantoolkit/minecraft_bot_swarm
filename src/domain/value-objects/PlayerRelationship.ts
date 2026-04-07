import fs from 'fs';
import path from 'path';

export type Relationship = 'friend' | 'enemy' | 'neutral';

/**
 * How to treat neutral players (not in friend or enemy list):
 *   ignore     — never attack neutrals
 *   attack     — treat neutrals like enemies (full open-pvp)
 *   armed      — attack neutrals that are visibly holding a weapon
 */
export type NeutralBehavior = 'ignore' | 'attack' | 'armed';

const WEAPON_SUBSTRINGS = ['sword', 'axe', 'bow', 'crossbow', 'trident', 'mace'];

const SAVE_FILE = path.resolve(process.cwd(), 'relationships.json');

interface SaveData {
  friends: string[];
  enemies: string[];
  neutralBehavior: NeutralBehavior;
}

export class PlayerRelationshipStore {
  private friends = new Set<string>();
  private enemies = new Set<string>();
  private neutralBehavior: NeutralBehavior = 'ignore';

  constructor() {
    this.load();
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  addFriend(username: string): void {
    this.friends.add(username);
    this.enemies.delete(username);
    this.save();
    console.log(`[Relations] ${username} → FRIEND`);
  }

  addEnemy(username: string): void {
    this.enemies.add(username);
    this.friends.delete(username);
    this.save();
    console.log(`[Relations] ${username} → ENEMY`);
  }

  remove(username: string): void {
    this.friends.delete(username);
    this.enemies.delete(username);
    this.save();
    console.log(`[Relations] ${username} → NEUTRAL (removed)`);
  }

  setNeutralBehavior(behavior: NeutralBehavior): void {
    this.neutralBehavior = behavior;
    this.save();
    console.log(`[Relations] Neutral behavior → ${behavior}`);
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  getRelationship(username: string): Relationship {
    if (this.friends.has(username)) return 'friend';
    if (this.enemies.has(username)) return 'enemy';
    return 'neutral';
  }

  /**
   * Should the swarm attack this player right now?
   * @param heldItemName optional — the item name the player is holding (for 'armed' mode)
   */
  shouldAttackPlayer(username: string, heldItemName?: string): boolean {
    const rel = this.getRelationship(username);
    if (rel === 'friend') return false;
    if (rel === 'enemy') return true;

    // Neutral
    switch (this.neutralBehavior) {
      case 'attack': return true;
      case 'armed':  return isHoldingWeapon(heldItemName);
      case 'ignore':
      default:       return false;
    }
  }

  getFriends(): string[] { return [...this.friends]; }
  getEnemies(): string[] { return [...this.enemies]; }
  getNeutralBehavior(): NeutralBehavior { return this.neutralBehavior; }

  print(): void {
    console.log(`  Friends  (${this.friends.size}): ${[...this.friends].join(', ') || '—'}`);
    console.log(`  Enemies  (${this.enemies.size}): ${[...this.enemies].join(', ') || '—'}`);
    console.log(`  Neutrals: ${this.neutralBehavior}`);
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private save(): void {
    const data: SaveData = {
      friends: [...this.friends],
      enemies: [...this.enemies],
      neutralBehavior: this.neutralBehavior,
    };
    fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  }

  private load(): void {
    if (!fs.existsSync(SAVE_FILE)) return;
    try {
      const data: SaveData = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8'));
      this.friends = new Set(data.friends ?? []);
      this.enemies = new Set(data.enemies ?? []);
      this.neutralBehavior = data.neutralBehavior ?? 'ignore';
      console.log(`[Relations] Loaded — ${this.friends.size} friends, ${this.enemies.size} enemies, neutral=${this.neutralBehavior}`);
    } catch {
      console.warn('[Relations] Could not load relationships.json — starting fresh');
    }
  }
}

function isHoldingWeapon(itemName?: string): boolean {
  if (!itemName) return false;
  return WEAPON_SUBSTRINGS.some(w => itemName.includes(w));
}
