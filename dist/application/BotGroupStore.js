"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotGroupStore = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const SAVE_FILE = path_1.default.resolve(process.cwd(), 'groups.json');
/**
 * Manages named bot groups.
 * Groups persist across restarts via groups.json.
 */
class BotGroupStore {
    constructor() {
        this.groups = new Map();
        this.load();
    }
    create(name) {
        if (!this.groups.has(name)) {
            this.groups.set(name, new Set());
            this.save();
            console.log(`[Groups] Created "${name}"`);
        }
        else {
            console.log(`[Groups] "${name}" already exists`);
        }
    }
    delete(name) {
        if (this.groups.delete(name)) {
            this.save();
            console.log(`[Groups] Deleted "${name}"`);
        }
    }
    add(groupName, ...usernames) {
        if (!this.groups.has(groupName))
            this.groups.set(groupName, new Set());
        usernames.forEach(u => this.groups.get(groupName).add(u));
        this.save();
        console.log(`[Groups] "${groupName}" ← [${usernames.join(', ')}]`);
    }
    remove(groupName, ...usernames) {
        const group = this.groups.get(groupName);
        if (!group)
            return;
        usernames.forEach(u => group.delete(u));
        this.save();
    }
    /** Returns the usernames in the group, or undefined if the group doesn't exist. */
    resolve(name) {
        const group = this.groups.get(name);
        return group ? [...group] : undefined;
    }
    list() {
        if (this.groups.size === 0) {
            console.log('[Groups] No groups defined');
            return;
        }
        for (const [name, members] of this.groups) {
            console.log(`  @${name}: ${[...members].join(', ') || '(empty)'}`);
        }
    }
    members(name) {
        const group = this.groups.get(name);
        if (!group) {
            console.log(`[Groups] Group "${name}" not found`);
            return;
        }
        console.log(`  @${name}: ${[...group].join(', ') || '(empty)'}`);
    }
    save() {
        const obj = {};
        for (const [name, members] of this.groups)
            obj[name] = [...members];
        fs_1.default.writeFileSync(SAVE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    }
    load() {
        if (!fs_1.default.existsSync(SAVE_FILE))
            return;
        try {
            const obj = JSON.parse(fs_1.default.readFileSync(SAVE_FILE, 'utf-8'));
            for (const [name, members] of Object.entries(obj)) {
                this.groups.set(name, new Set(members));
            }
            console.log(`[Groups] Loaded ${this.groups.size} groups`);
        }
        catch {
            console.warn('[Groups] Could not load groups.json');
        }
    }
}
exports.BotGroupStore = BotGroupStore;
//# sourceMappingURL=BotGroupStore.js.map