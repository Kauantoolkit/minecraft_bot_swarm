"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandListener = void 0;
const readline_1 = __importDefault(require("readline"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const WorkerCommandAdapter_1 = require("../worker/WorkerCommandAdapter");
const config_1 = require("../config");
class CommandListener {
    constructor(controller, repository, adapter, botManager, groups) {
        this.controller = controller;
        this.repository = repository;
        this.adapter = adapter;
        this.botManager = botManager;
        this.groups = groups;
        // Dedup: multiple bots hear the same chat message simultaneously — only process once
        this.lastChat = { input: '', time: 0 };
    }
    startConsole() {
        this.rl = readline_1.default.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'swarm> ',
        });
        this.rl.prompt();
        this.rl.on('line', (line) => {
            this.dispatch(line.trim());
            this.rl?.prompt();
        });
        this.rl.on('close', () => {
            console.log('[CommandListener] Console closed — disconnecting swarm...');
            this.controller.disconnectAll();
            process.exit(0);
        });
        console.log('[CommandListener] Console ready. Type "help" for commands.');
    }
    attachChatListeners() {
        if (this.adapter instanceof WorkerCommandAdapter_1.WorkerCommandAdapter) {
            // Worker mode: chat events are forwarded from each worker as CHAT_MSG messages.
            // We only need one global listener on the adapter — dedup is handled below.
            this.adapter.on('chat_msg', (botId, username, message) => {
                if (username !== config_1.config.master.username)
                    return;
                const now = Date.now();
                if (message === this.lastChat.input && now - this.lastChat.time < 1000)
                    return;
                this.lastChat = { input: message, time: now };
                console.log(`[CommandListener] Chat(worker) from ${username}: ${message}`);
                this.dispatch(message);
            });
            return;
        }
        // Direct mode: attach to the mineflayer bot handle directly
        this.repository.findAll().forEach(domainBot => {
            const mfBot = domainBot.handle;
            if (!mfBot)
                return;
            if (mfBot._swarmChatAttached)
                return;
            mfBot._swarmChatAttached = true;
            mfBot.on('chat', (username, message) => {
                if (username !== config_1.config.master.username)
                    return;
                const now = Date.now();
                if (message === this.lastChat.input && now - this.lastChat.time < 1000)
                    return;
                this.lastChat = { input: message, time: now };
                console.log(`[CommandListener] Chat from ${username}: ${message}`);
                this.dispatch(message);
            });
        });
    }
    // ─── Target resolution ────────────────────────────────────────────────────
    //
    // Format:  @target <command> [args...]
    //
    //   @all              → all online bots (default when omitted)
    //   @SwarmBot_3       → single bot by username
    //   @1-5              → bots whose suffix number is in 1..5 (e.g. SwarmBot_1..SwarmBot_5)
    //   @builders         → named group "builders"
    //   @SwarmBot_1,Bot_2 → comma-separated list of usernames
    //
    // Returns [resolvedTarget, restOfInput] or null if prefix was invalid.
    parseTarget(input) {
        if (!input.startsWith('@'))
            return [undefined, input];
        const spaceIdx = input.indexOf(' ');
        const targetStr = spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx);
        const rest = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();
        // @all → undefined (all bots)
        if (targetStr === 'all')
            return [undefined, rest];
        // @1-5 → range of suffix numbers
        const rangeMatch = targetStr.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
            const lo = parseInt(rangeMatch[1], 10);
            const hi = parseInt(rangeMatch[2], 10);
            const all = this.repository.findAll().map(b => b.username);
            const target = all.filter(name => {
                const m = name.match(/_(\d+)$/);
                if (!m)
                    return false;
                const n = parseInt(m[1], 10);
                return n >= lo && n <= hi;
            });
            return [target.length > 0 ? target : [], rest];
        }
        // @name,name2 → comma-separated list
        if (targetStr.includes(',')) {
            return [targetStr.split(',').map(s => s.trim()).filter(Boolean), rest];
        }
        // @groupName → named group
        const groupMembers = this.groups.resolve(targetStr);
        if (groupMembers !== undefined)
            return [groupMembers, rest];
        // @username → single bot
        return [[targetStr], rest];
    }
    dispatch(input) {
        if (!input)
            return;
        // Extract optional @target prefix
        const [target, commandInput] = this.parseTarget(input);
        if (!commandInput)
            return;
        const [cmd, ...args] = commandInput.split(/\s+/);
        switch (cmd.toLowerCase()) {
            // ── Movement ──────────────────────────────────────────────────────────
            case 'move': {
                const [x, y, z] = args.map(Number);
                if ([x, y, z].some(isNaN)) {
                    console.log('Usage: move <x> <y> <z>');
                    break;
                }
                this.controller.moveAllTo(x, y, z, target);
                break;
            }
            case 'follow': {
                const [t] = args;
                if (!t) {
                    console.log('Usage: follow <player>');
                    break;
                }
                this.controller.followAll(t, target);
                break;
            }
            case 'stop':
                this.controller.stopAll(target);
                break;
            // ── Chat ──────────────────────────────────────────────────────────────
            case 'say': {
                const message = args.join(' ');
                if (!message) {
                    console.log('Usage: say <message>');
                    break;
                }
                this.controller.sayAll(message, target);
                break;
            }
            // ── Combat ────────────────────────────────────────────────────────────
            case 'attack': {
                const [t] = args;
                if (!t) {
                    console.log('Usage: attack <player>');
                    break;
                }
                this.controller.attackAll(t, target);
                break;
            }
            case 'pvp': {
                if (args.length === 0) {
                    console.log('Usage: pvp <player> [player2 ...]');
                    break;
                }
                this.controller.pvpAll(args, target);
                break;
            }
            case 'attack-list': {
                const file = args[0]
                    ? path_1.default.resolve(process.cwd(), args[0])
                    : path_1.default.resolve(process.cwd(), 'targets.txt');
                const targets = loadTargetFile(file);
                if (targets.length === 0) {
                    console.log(`[CommandListener] No targets found in ${file}`);
                    break;
                }
                console.log(`[CommandListener] PvP targets: ${targets.join(', ')}`);
                this.controller.pvpAll(targets, target);
                break;
            }
            case 'guard': {
                const [x, y, z, r] = args.map(Number);
                if ([x, y, z].some(isNaN)) {
                    console.log('Usage: guard <x> <y> <z> [radius]');
                    break;
                }
                this.controller.guardAll(x, y, z, isNaN(r) ? 10 : r, target);
                break;
            }
            case 'defend': {
                if (args[0] === 'off') {
                    this.controller.stopDefendAll(target);
                    this.controller.stopAll(target);
                }
                else if (args[0] && isNaN(Number(args[0]))) {
                    const player = args[0];
                    const radius = parseInt(args[1], 10) || 6;
                    this.controller.bodyguardAll(player, radius, target);
                }
                else {
                    const radius = parseInt(args[0], 10) || 8;
                    this.controller.defendAll(radius, target);
                }
                break;
            }
            // ── Resources ─────────────────────────────────────────────────────────
            case 'collect': {
                // collect <block> [count] [--vein] [--store <label>]
                const storeIdx = args.indexOf('--store');
                const storageLabel = storeIdx >= 0 ? args[storeIdx + 1] : undefined;
                const cleanArgs = storeIdx >= 0
                    ? args.filter((_, i) => i !== storeIdx && i !== storeIdx + 1)
                    : args;
                const [blockName, rawCount, flag] = cleanArgs;
                if (!blockName) {
                    console.log('Usage: collect <blockName> [count] [--vein] [--store <label>]');
                    break;
                }
                const count = parseInt(rawCount, 10) || 1;
                if (flag === '--vein' || flag === 'vein') {
                    this.controller.collectVeinAll(blockName, count, storageLabel, target);
                }
                else {
                    this.controller.collectAll(blockName, count, storageLabel, target);
                }
                break;
            }
            case 'quarry': {
                // quarry <x1> <y1> <z1> <x2> <y2> <z2> [--store <label>]
                const storeIdx = args.indexOf('--store');
                const storageLabel = storeIdx >= 0 ? args[storeIdx + 1] : undefined;
                const coordArgs = storeIdx >= 0
                    ? args.filter((_, i) => i !== storeIdx && i !== storeIdx + 1)
                    : args;
                const nums = coordArgs.map(Number);
                if (nums.length < 6 || nums.some(isNaN)) {
                    console.log('Usage: quarry <x1> <y1> <z1> <x2> <y2> <z2> [--store <label>]');
                    break;
                }
                this.controller.quarryAll(...nums, storageLabel, target);
                break;
            }
            case 'store': {
                const [sub, ...storeArgs] = args;
                switch (sub) {
                    case 'register': {
                        // store register <label> <x> <y> <z>
                        const [label, sx, sy, sz] = storeArgs;
                        const [x, y, z] = [Number(sx), Number(sy), Number(sz)];
                        if (!label || isNaN(x) || isNaN(y) || isNaN(z)) {
                            console.log('Usage: store register <label> <x> <y> <z>');
                        }
                        else {
                            // eslint-disable-next-line @typescript-eslint/no-require-imports
                            const { Vec3 } = require('vec3');
                            this.controller.storage.register(label, new Vec3(x, y, z));
                        }
                        break;
                    }
                    case 'remove': {
                        const [label] = storeArgs;
                        if (!label) {
                            console.log('Usage: store remove <label>');
                            break;
                        }
                        const removed = this.controller.storage.remove(label);
                        console.log(removed ? `[Storage] Removed "${label}"` : `[Storage] Label "${label}" not found`);
                        break;
                    }
                    case 'list': {
                        const entries = this.controller.storage.list();
                        if (entries.length === 0) {
                            console.log('[Storage] No storages registered');
                            break;
                        }
                        entries.forEach(({ label, pos }) => console.log(`  ${label.padEnd(20)} (${pos.x}, ${pos.y}, ${pos.z})`));
                        break;
                    }
                    case 'deposit': {
                        // store deposit [label|nearest]
                        const label = storeArgs[0] ?? 'nearest';
                        this.controller.depositAll(label, target);
                        break;
                    }
                    case 'withdraw': {
                        // store withdraw <label> <item> [count]
                        const [label, itemName, rawCount] = storeArgs;
                        if (!label || !itemName) {
                            console.log('Usage: store withdraw <label> <item> [count]');
                            break;
                        }
                        this.controller.withdraw(label, itemName, parseInt(rawCount, 10) || 1, target);
                        break;
                    }
                    default:
                        console.log('store register <label> <x> <y> <z> | store remove <label> | store list | store deposit [label] | store withdraw <label> <item> [count]');
                }
                break;
            }
            case 'farm': {
                const [rawCX, rawCZ, rawR] = args.map(Number);
                if (isNaN(rawCX) || isNaN(rawCZ)) {
                    console.log('Usage: farm <centerX> <centerZ> [radius]');
                    break;
                }
                this.controller.farmAll(rawCX, rawCZ, isNaN(rawR) ? 30 : rawR, target);
                break;
            }
            case 'explore': {
                const dir = (args[0] ?? 'auto');
                this.controller.exploreAll(dir, target);
                break;
            }
            case 'avoid': {
                const radiusIdx = args.indexOf('--radius');
                const radius = radiusIdx !== -1 ? parseInt(args[radiusIdx + 1], 10) || 20 : 20;
                const players = radiusIdx !== -1 ? args.slice(0, radiusIdx) : args;
                if (players.length === 0) {
                    console.log('Usage: avoid <player> [player2] [--radius N]');
                    break;
                }
                this.controller.avoidAll(players, radius, target);
                break;
            }
            // ── Building ──────────────────────────────────────────────────────────
            case 'build': {
                const [file, rawX, rawY, rawZ] = args;
                const bx = parseInt(rawX, 10), by = parseInt(rawY, 10), bz = parseInt(rawZ, 10);
                if (!file || [bx, by, bz].some(isNaN)) {
                    console.log('Usage: build <file.schem> <x> <y> <z>');
                    break;
                }
                const schematicPath = path_1.default.resolve(process.cwd(), file);
                this.controller.buildAll(schematicPath, bx, by, bz, target).catch(err => console.error(`[CommandListener] Build failed: ${err.message}`));
                break;
            }
            // ── Inventory ─────────────────────────────────────────────────────────
            case 'equip': {
                const [itemName] = args;
                if (!itemName) {
                    console.log('Usage: equip <itemName>');
                    break;
                }
                this.controller.equipAll(itemName, target);
                break;
            }
            case 'eat':
                this.controller.eatAll(target);
                break;
            // ── Groups ────────────────────────────────────────────────────────────
            case 'group': {
                const [sub, name, ...rest] = args;
                if (!sub) {
                    console.log('Usage: group <create|delete|add|remove|list|members> [name] [bots...]');
                    break;
                }
                switch (sub) {
                    case 'create':
                        if (!name) {
                            console.log('Usage: group create <name>');
                            break;
                        }
                        this.groups.create(name);
                        break;
                    case 'delete':
                        if (!name) {
                            console.log('Usage: group delete <name>');
                            break;
                        }
                        this.groups.delete(name);
                        break;
                    case 'add':
                        if (!name || rest.length === 0) {
                            console.log('Usage: group add <name> <bot1> [bot2 ...]');
                            break;
                        }
                        this.groups.add(name, ...rest);
                        break;
                    case 'remove':
                        if (!name || rest.length === 0) {
                            console.log('Usage: group remove <name> <bot1> [bot2 ...]');
                            break;
                        }
                        this.groups.remove(name, ...rest);
                        break;
                    case 'list':
                        this.groups.list();
                        break;
                    case 'members':
                        if (!name) {
                            console.log('Usage: group members <name>');
                            break;
                        }
                        this.groups.members(name);
                        break;
                    default:
                        console.log(`Unknown group subcommand: "${sub}". Use create|delete|add|remove|list|members.`);
                }
                break;
            }
            // ── Relationships ──────────────────────────────────────────────────────
            case 'friend': {
                const [sub, player] = args;
                if (sub === 'add' && player) {
                    this.controller.relations.addFriend(player);
                    break;
                }
                if (sub === 'remove' && player) {
                    this.controller.relations.remove(player);
                    break;
                }
                if (sub === 'list') {
                    console.log('Friends:', this.controller.relations.getFriends().join(', ') || '—');
                    break;
                }
                console.log('Usage: friend <add|remove|list> [player]');
                break;
            }
            case 'enemy': {
                const [sub, player] = args;
                if (sub === 'add' && player) {
                    this.controller.relations.addEnemy(player);
                    break;
                }
                if (sub === 'remove' && player) {
                    this.controller.relations.remove(player);
                    break;
                }
                if (sub === 'list') {
                    console.log('Enemies:', this.controller.relations.getEnemies().join(', ') || '—');
                    break;
                }
                console.log('Usage: enemy <add|remove|list> [player]');
                break;
            }
            case 'neutral': {
                const [mode] = args;
                if (!['ignore', 'attack', 'armed'].includes(mode)) {
                    console.log('Usage: neutral <ignore|attack|armed>');
                    console.log('  ignore — never attack neutral players');
                    console.log('  attack — treat neutrals like enemies');
                    console.log('  armed  — attack neutrals holding a weapon');
                    break;
                }
                this.controller.relations.setNeutralBehavior(mode);
                break;
            }
            case 'relations':
                this.controller.relations.print();
                break;
            // ── Swarm management ──────────────────────────────────────────────────
            case 'spawn': {
                const count = parseInt(args[0], 10);
                if (isNaN(count) || count <= 0) {
                    console.log('Usage: spawn <count>');
                    break;
                }
                this.botManager.spawnMore(count).then(() => this.attachChatListeners());
                break;
            }
            case 'status':
                this.controller.status();
                break;
            case 'quit':
            case 'exit':
                this.controller.disconnectAll();
                process.exit(0);
                break;
            case 'help':
                console.log(HELP_TEXT);
                break;
            default:
                console.log(`Unknown command: "${cmd}". Type "help".`);
        }
    }
}
exports.CommandListener = CommandListener;
function loadTargetFile(filePath) {
    if (!fs_1.default.existsSync(filePath))
        return [];
    return fs_1.default
        .readFileSync(filePath, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
}
const HELP_TEXT = `
─── Targeting (prefix any command) ─────────────────────
  @all <cmd>                    All bots (default)
  @SwarmBot_3 <cmd>             Single bot by name
  @1-5 <cmd>                    Bots with suffix _1 to _5
  @builders <cmd>               Named group "builders"
  @Bot1,Bot2 <cmd>              Comma-separated list

─── Movement ───────────────────────────────────────────
  move <x> <y> <z>             Move all bots to coords
  follow <player>               All bots follow a player
  stop                          Stop all movement / modes

─── Chat ────────────────────────────────────────────────
  say <message>                 All bots send chat

─── Combat ──────────────────────────────────────────────
  attack <player>               Single-hit all bots
  pvp <p1> [p2 ...]            Continuous chase+attack
  attack-list [file]            PvP from targets.txt
  guard <x> <y> <z> [radius]   Guard position, attack intruders
  defend <player> [radius]      Bodyguard: follow + protect a player
  defend [radius]               Self-defense: auto-attack mobs + flee creepers
  defend off                    Disable defend/bodyguard
  avoid <p1> [p2] [--radius N]  Flee from specific players

─── Storage ─────────────────────────────────────────────
  store register <label> <x> <y> <z>  Register a chest
  store remove <label>           Remove a chest
  store list                     List registered chests
  store deposit [label|nearest]  Deposit inventory to chest
  store withdraw <label> <item> [count]  Withdraw from chest

─── Resources ───────────────────────────────────────────
  collect <block> [count] [--vein] [--store <label>]
  quarry <x1> <y1> <z1> <x2> <y2> <z2> [--store <label>]
  farm <x> <z> [radius]         Auto-harvest+replant crops
  explore [n|s|e|w|auto]        Explore new chunks

─── Building ────────────────────────────────────────────
  build <file.schem> <x> <y> <z>  Build Sponge schematic

─── Inventory ───────────────────────────────────────────
  equip <item>                  Equip item to main hand
  eat                           Eat best food in inventory

─── Groups ──────────────────────────────────────────────
  group create <name>           Create a new group
  group delete <name>           Delete a group
  group add <name> <bot1> ...   Add bots to a group
  group remove <name> <bot1>... Remove bots from a group
  group list                    List all groups
  group members <name>          Show members of a group

─── Relationships ───────────────────────────────────────
  friend add/remove/list <p>    Manage friend list (never attacked)
  enemy  add/remove/list <p>    Manage enemy list (always attacked)
  neutral <ignore|attack|armed> How to treat unlisted players
  relations                     Show current relationship table

─── Swarm ───────────────────────────────────────────────
  spawn <n>                     Add n more bots
  status                        Show bot states
  quit / exit                   Disconnect all and exit
`.trim();
//# sourceMappingURL=CommandListener.js.map