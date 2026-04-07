import fs from 'fs';
import path from 'path';

const SAVE_FILE = path.resolve(process.cwd(), 'groups.json');

/**
 * Manages named bot groups.
 * Groups persist across restarts via groups.json.
 */
export class BotGroupStore {
  private groups = new Map<string, Set<string>>();

  constructor() {
    this.load();
  }

  create(name: string): void {
    if (!this.groups.has(name)) {
      this.groups.set(name, new Set());
      this.save();
      console.log(`[Groups] Created "${name}"`);
    } else {
      console.log(`[Groups] "${name}" already exists`);
    }
  }

  delete(name: string): void {
    if (this.groups.delete(name)) {
      this.save();
      console.log(`[Groups] Deleted "${name}"`);
    }
  }

  add(groupName: string, ...usernames: string[]): void {
    if (!this.groups.has(groupName)) this.groups.set(groupName, new Set());
    usernames.forEach(u => this.groups.get(groupName)!.add(u));
    this.save();
    console.log(`[Groups] "${groupName}" ← [${usernames.join(', ')}]`);
  }

  remove(groupName: string, ...usernames: string[]): void {
    const group = this.groups.get(groupName);
    if (!group) return;
    usernames.forEach(u => group.delete(u));
    this.save();
  }

  /** Returns the usernames in the group, or undefined if the group doesn't exist. */
  resolve(name: string): string[] | undefined {
    const group = this.groups.get(name);
    return group ? [...group] : undefined;
  }

  list(): void {
    if (this.groups.size === 0) {
      console.log('[Groups] No groups defined');
      return;
    }
    for (const [name, members] of this.groups) {
      console.log(`  @${name}: ${[...members].join(', ') || '(empty)'}`);
    }
  }

  members(name: string): void {
    const group = this.groups.get(name);
    if (!group) { console.log(`[Groups] Group "${name}" not found`); return; }
    console.log(`  @${name}: ${[...group].join(', ') || '(empty)'}`);
  }

  private save(): void {
    const obj: Record<string, string[]> = {};
    for (const [name, members] of this.groups) obj[name] = [...members];
    fs.writeFileSync(SAVE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  }

  private load(): void {
    if (!fs.existsSync(SAVE_FILE)) return;
    try {
      const obj: Record<string, string[]> = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8'));
      for (const [name, members] of Object.entries(obj)) {
        this.groups.set(name, new Set(members));
      }
      console.log(`[Groups] Loaded ${this.groups.size} groups`);
    } catch {
      console.warn('[Groups] Could not load groups.json');
    }
  }
}
