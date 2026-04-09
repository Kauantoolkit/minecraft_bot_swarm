"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageCache = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vec3_1 = require("vec3");
const PERSIST_FILE = path.resolve(process.cwd(), 'storages.json');
/**
 * Registry of known storage containers (chests, barrels, etc.).
 *
 * Entries are registered by the operator via `store register <label> <x> <y> <z>`
 * and persisted to storages.json between restarts.
 *
 * Behaviors use getNearest() to find the closest chest to deposit into,
 * or getByLabel() when a specific storage is requested.
 */
class StorageCache {
    constructor() {
        this.entries = [];
        this.load();
    }
    // ─── Registration ──────────────────────────────────────────────────────────
    register(label, pos) {
        const existing = this.entries.findIndex(e => e.label === label);
        const entry = { label, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
        if (existing >= 0) {
            this.entries[existing] = entry;
            console.log(`[Storage] Updated "${label}" → (${entry.x}, ${entry.y}, ${entry.z})`);
        }
        else {
            this.entries.push(entry);
            console.log(`[Storage] Registered "${label}" → (${entry.x}, ${entry.y}, ${entry.z})`);
        }
        this.save();
    }
    remove(label) {
        const before = this.entries.length;
        this.entries = this.entries.filter(e => e.label !== label);
        if (this.entries.length < before) {
            this.save();
            return true;
        }
        return false;
    }
    // ─── Lookup ────────────────────────────────────────────────────────────────
    getByLabel(label) {
        const e = this.entries.find(e => e.label === label);
        return e ? new vec3_1.Vec3(e.x, e.y, e.z) : null;
    }
    getNearest(botPos) {
        if (this.entries.length === 0)
            return null;
        let best = this.entries[0];
        let bestDist = botPos.distanceTo(new vec3_1.Vec3(best.x, best.y, best.z));
        for (const e of this.entries.slice(1)) {
            const d = botPos.distanceTo(new vec3_1.Vec3(e.x, e.y, e.z));
            if (d < bestDist) {
                best = e;
                bestDist = d;
            }
        }
        return { label: best.label, pos: new vec3_1.Vec3(best.x, best.y, best.z) };
    }
    list() {
        return this.entries.map(e => ({ label: e.label, pos: new vec3_1.Vec3(e.x, e.y, e.z) }));
    }
    /** Register multiple chests at once (from an auto-scan). Skips duplicates. */
    registerMany(prefix, positions) {
        let added = 0;
        for (const pos of positions) {
            const isDupe = this.entries.some(e => e.x === Math.floor(pos.x) && e.y === Math.floor(pos.y) && e.z === Math.floor(pos.z));
            if (isDupe)
                continue;
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
    load() {
        try {
            if (fs.existsSync(PERSIST_FILE)) {
                this.entries = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
                console.log(`[Storage] Loaded ${this.entries.length} storage(s) from storages.json`);
            }
        }
        catch {
            console.warn('[Storage] Could not load storages.json — starting empty');
        }
    }
    save() {
        try {
            fs.writeFileSync(PERSIST_FILE, JSON.stringify(this.entries, null, 2));
        }
        catch {
            console.warn('[Storage] Could not save storages.json');
        }
    }
}
exports.StorageCache = StorageCache;
//# sourceMappingURL=StorageCache.js.map