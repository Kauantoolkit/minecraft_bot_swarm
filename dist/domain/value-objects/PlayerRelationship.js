"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlayerRelationshipStore = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const WEAPON_SUBSTRINGS = ['sword', 'axe', 'bow', 'crossbow', 'trident', 'mace'];
const SAVE_FILE = path_1.default.resolve(process.cwd(), 'relationships.json');
class PlayerRelationshipStore {
    constructor() {
        this.friends = new Set();
        this.enemies = new Set();
        this.neutralBehavior = 'ignore';
        this.load();
    }
    // ─── Mutations ─────────────────────────────────────────────────────────────
    addFriend(username) {
        this.friends.add(username);
        this.enemies.delete(username);
        this.save();
        console.log(`[Relations] ${username} → FRIEND`);
    }
    addEnemy(username) {
        this.enemies.add(username);
        this.friends.delete(username);
        this.save();
        console.log(`[Relations] ${username} → ENEMY`);
    }
    remove(username) {
        this.friends.delete(username);
        this.enemies.delete(username);
        this.save();
        console.log(`[Relations] ${username} → NEUTRAL (removed)`);
    }
    setNeutralBehavior(behavior) {
        this.neutralBehavior = behavior;
        this.save();
        console.log(`[Relations] Neutral behavior → ${behavior}`);
    }
    // ─── Queries ───────────────────────────────────────────────────────────────
    getRelationship(username) {
        if (this.friends.has(username))
            return 'friend';
        if (this.enemies.has(username))
            return 'enemy';
        return 'neutral';
    }
    /**
     * Should the swarm attack this player right now?
     * @param heldItemName optional — the item name the player is holding (for 'armed' mode)
     */
    shouldAttackPlayer(username, heldItemName) {
        const rel = this.getRelationship(username);
        if (rel === 'friend')
            return false;
        if (rel === 'enemy')
            return true;
        // Neutral
        switch (this.neutralBehavior) {
            case 'attack': return true;
            case 'armed': return isHoldingWeapon(heldItemName);
            case 'ignore':
            default: return false;
        }
    }
    getFriends() { return [...this.friends]; }
    getEnemies() { return [...this.enemies]; }
    getNeutralBehavior() { return this.neutralBehavior; }
    print() {
        console.log(`  Friends  (${this.friends.size}): ${[...this.friends].join(', ') || '—'}`);
        console.log(`  Enemies  (${this.enemies.size}): ${[...this.enemies].join(', ') || '—'}`);
        console.log(`  Neutrals: ${this.neutralBehavior}`);
    }
    // ─── Persistence ───────────────────────────────────────────────────────────
    save() {
        const data = {
            friends: [...this.friends],
            enemies: [...this.enemies],
            neutralBehavior: this.neutralBehavior,
        };
        fs_1.default.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    }
    load() {
        if (!fs_1.default.existsSync(SAVE_FILE))
            return;
        try {
            const data = JSON.parse(fs_1.default.readFileSync(SAVE_FILE, 'utf-8'));
            this.friends = new Set(data.friends ?? []);
            this.enemies = new Set(data.enemies ?? []);
            this.neutralBehavior = data.neutralBehavior ?? 'ignore';
            console.log(`[Relations] Loaded — ${this.friends.size} friends, ${this.enemies.size} enemies, neutral=${this.neutralBehavior}`);
        }
        catch {
            console.warn('[Relations] Could not load relationships.json — starting fresh');
        }
    }
}
exports.PlayerRelationshipStore = PlayerRelationshipStore;
function isHoldingWeapon(itemName) {
    if (!itemName)
        return false;
    return WEAPON_SUBSTRINGS.some(w => itemName.includes(w));
}
//# sourceMappingURL=PlayerRelationship.js.map