"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MineflayerAdapter = void 0;
const mineflayer_1 = __importDefault(require("mineflayer"));
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const BotState_1 = require("../../domain/value-objects/BotState");
const BotMeta_1 = require("./BotMeta");
const utils_1 = require("./utils");
const PhysicsPatch_1 = require("./physics/PhysicsPatch");
const MovementBehavior_1 = require("./behaviors/MovementBehavior");
const CombatBehavior_1 = require("./behaviors/CombatBehavior");
const GuardBehavior_1 = require("./behaviors/GuardBehavior");
const DefendBehavior_1 = require("./behaviors/DefendBehavior");
const AvoidBehavior_1 = require("./behaviors/AvoidBehavior");
const FarmBehavior_1 = require("./behaviors/FarmBehavior");
const ExploreBehavior_1 = require("./behaviors/ExploreBehavior");
const InventoryBehavior_1 = require("./behaviors/InventoryBehavior");
const MiningBehavior_1 = require("./behaviors/MiningBehavior");
const BuildBehavior_1 = require("./behaviors/BuildBehavior");
const StorageBehavior_1 = require("./behaviors/StorageBehavior");
// Hostile mobs the defend mode will react to
const HOSTILE_MOBS = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
    'witch', 'pillager', 'vindicator', 'ravager', 'phantom', 'drowned',
    'husk', 'stray', 'wither_skeleton', 'blaze', 'ghast', 'magma_cube',
    'slime', 'silverfish', 'endermite', 'guardian', 'elder_guardian',
    'shulker', 'vex', 'evoker', 'zombie_villager', 'piglin_brute',
    'zoglin', 'hoglin', 'warden',
]);
// Aerial mobs that cannot be reached by ground pathfinding.
// For these, the bot stays in place and only swings when they swoop close enough,
// instead of using GoalFollow which produces endless partial/noPath cycles and
// leaves the bot jumping in the air trying to reach an unreachable position.
const AERIAL_MOBS = new Set(['phantom', 'ghast', 'blaze', 'bat', 'bee', 'vex']);
const CREEPER_FLEE_RADIUS = 7;
class MineflayerAdapter {
    constructor() {
        this.metaStore = new BotMeta_1.MetaStore();
        this.movementBehavior = new MovementBehavior_1.MovementBehavior(this.metaStore);
        this.combatBehavior = new CombatBehavior_1.CombatBehavior(this.metaStore);
        this.guardBehavior = new GuardBehavior_1.GuardBehavior(this.metaStore);
        this.defendBehavior = new DefendBehavior_1.DefendBehavior(this.metaStore);
        this.avoidBehavior = new AvoidBehavior_1.AvoidBehavior(this.metaStore);
        this.farmBehavior = new FarmBehavior_1.FarmBehavior(this.metaStore);
        this.exploreBehavior = new ExploreBehavior_1.ExploreBehavior(this.metaStore);
        this.inventoryBehavior = new InventoryBehavior_1.InventoryBehavior();
        this.miningBehavior = new MiningBehavior_1.MiningBehavior();
        this.buildBehavior = new BuildBehavior_1.BuildBehavior();
        this.storageBehavior = new StorageBehavior_1.StorageBehavior();
    }
    getMeta(bot) {
        return this.metaStore.get(bot);
    }
    /** Returns the current active mode string for display in the debug UI. */
    getMode(bot) {
        const meta = this.metaStore.get(bot);
        if (!meta)
            return 'idle';
        const primary = meta.activeMode || 'idle';
        const hasDefend = !!meta.defendListener;
        return hasDefend && !primary.startsWith('defend') ? `${primary}+defend` : primary;
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────────
    spawn(domainBot, options) {
        return new Promise((resolve, reject) => {
            domainBot.setState(BotState_1.BotState.CONNECTING);
            const mfBot = mineflayer_1.default.createBot({
                host: options.host,
                port: options.port,
                ...(options.version !== false && { version: options.version }),
                username: options.username,
                agent: options.agent,
                hideErrors: false,
            });
            mfBot.loadPlugin(mineflayer_pathfinder_1.pathfinder);
            domainBot.attachHandle(mfBot);
            // physicsTick is only emitted when physicsEnabled=true, so we can't use it as a watchdog.
            // Use setInterval instead — runs on the JS event loop regardless of physics state.
            const physicsGuard = setInterval(() => {
                if (!mfBot.physicsEnabled) {
                    mfBot.physicsEnabled = true;
                    console.warn(`[${domainBot.username}] physicsEnabled was false — forced true`);
                }
            }, 500);
            mfBot.once('end', () => clearInterval(physicsGuard));
            let resolved = false;
            mfBot.on('spawn', () => {
                // Ensure physics is always on — plugins like baritone can leave it disabled
                mfBot.physicsEnabled = true;
                // Limit A* CPU: default tickTimeout=40ms × 10 bots = 400ms blocked per tick
                mfBot.pathfinder.tickTimeout = 10;
                mfBot.pathfinder.searchRadius = 64;
                // Clear any stuck movement keys and active path from previous life
                mfBot.clearControlStates();
                mfBot.pathfinder.stop();
                mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
                // 🔧 Physics freeze fix for 1.21 velocity NaN bug
                (0, PhysicsPatch_1.installPhysicsPatches)(domainBot);
                domainBot.setState(BotState_1.BotState.CONNECTED);
                if (!resolved) {
                    resolved = true;
                    console.log(`[MineflayerAdapter] ${domainBot.username} spawned`);
                    resolve();
                }
                else {
                    console.log(`[MineflayerAdapter] ${domainBot.username} respawned`);
                    // Active listeners (pvp/bodyguard/follow) will naturally re-engage
                    // via their per-tick logic once they see the target again
                }
            });
            // Auto-respawn when bot dies (sends the "Respawn" packet after 1.5 s)
            mfBot.on('death', () => {
                console.warn(`[MineflayerAdapter] ${domainBot.username} died — respawning in 1.5 s`);
                setTimeout(() => {
                    try {
                        mfBot.respawn();
                    }
                    catch { /* ignore if already respawned */ }
                }, 1500);
            });
            mfBot.once('error', (err) => {
                domainBot.setState(BotState_1.BotState.ERROR);
                console.error(`[MineflayerAdapter] ${domainBot.username} error: ${err.message}`);
                if (!resolved) {
                    resolved = true;
                    reject(err);
                }
            });
            mfBot.once('kicked', (reason) => {
                domainBot.setState(BotState_1.BotState.DISCONNECTED);
                console.warn(`[MineflayerAdapter] ${domainBot.username} kicked: ${reason}`);
            });
            // Health monitoring — auto-eat + log low health
            mfBot.on('health', () => {
                const health = mfBot.health;
                if (health < 10) {
                    console.warn(`[${(0, utils_1.ts)()}] ${domainBot.username}: Low health (${health}) → attempting eat`);
                    this.eat(domainBot).catch(() => { });
                }
                if (health <= 5) {
                    console.error(`[${(0, utils_1.ts)()}] ${domainBot.username}: Critical health (${health})!`);
                }
            });
            mfBot.once('end', (reason) => {
                domainBot.setState(BotState_1.BotState.DISCONNECTED);
                console.warn(`[MineflayerAdapter] ${domainBot.username} disconnected: ${reason}`);
            });
        });
    }
    disconnect(domainBot) {
        this.stop(domainBot);
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        mfBot.quit();
        domainBot.setState(BotState_1.BotState.DISCONNECTED);
    }
    // ─── Movement ─────────────────────────────────────────────────────────────
    moveTo(domainBot, x, y, z) {
        return this.movementBehavior.moveTo(domainBot, x, y, z);
    }
    follow(domainBot, targetUsername) {
        this.movementBehavior.follow(domainBot, targetUsername);
    }
    stop(domainBot) {
        this.stopPvp(domainBot);
        this.stopGuard(domainBot);
        this.stopDefend(domainBot);
        this.stopAvoid(domainBot);
        this.stopFarm(domainBot);
        this.stopExplore(domainBot);
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        mfBot.physicsEnabled = true;
        mfBot.pathfinder.stop();
        mfBot.clearControlStates();
        domainBot.setState(BotState_1.BotState.CONNECTED);
        this.getMeta(domainBot).activeMode = 'idle';
    }
    // ─── Chat ─────────────────────────────────────────────────────────────────
    say(domainBot, message) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        mfBot.chat(message);
    }
    // ─── Combat ───────────────────────────────────────────────────────────────
    attack(domainBot, targetUsername) {
        this.combatBehavior.attack(domainBot, targetUsername);
    }
    pvp(domainBot, targetUsernames, intel, relations) {
        this.combatBehavior.pvp(domainBot, targetUsernames, intel, relations);
    }
    stopPvp(domainBot) {
        this.combatBehavior.stopPvp(domainBot);
    }
    // ─── Combat — Guard position ──────────────────────────────────────────────
    guard(domainBot, x, y, z, radius, excludeUsernames, relations) {
        this.guardBehavior.guard(domainBot, x, y, z, radius, excludeUsernames, relations);
    }
    stopGuard(domainBot) {
        this.guardBehavior.stopGuard(domainBot);
    }
    // ─── Combat — Bodyguard mode ──────────────────────────────────────────────
    bodyguard(domainBot, protectedUsername, radius, swarmUsernames, relations, intel) {
        this.guardBehavior.bodyguard(domainBot, protectedUsername, radius, swarmUsernames, relations, intel);
    }
    // ─── Combat — Defend mode (background) ───────────────────────────────────
    startDefend(domainBot, radius) {
        this.defendBehavior.start(domainBot, radius);
    }
    stopDefend(domainBot) {
        this.defendBehavior.stop(domainBot);
    }
    // ─── Resource collection ──────────────────────────────────────────────────
    // ─── Resource collection ──────────────────────────────────────────────────
    collect(domainBot, blockName, count, onFull) {
        return this.miningBehavior.collect(domainBot, blockName, count, onFull);
    }
    collectVein(domainBot, blockName, count, onFull) {
        return this.miningBehavior.collectVein(domainBot, blockName, count, onFull);
    }
    quarryFromQueue(domainBot, queue, onFull) {
        return this.miningBehavior.quarryFromQueue(domainBot, queue, onFull);
    }
    depositAll(domainBot, chestPos) {
        return this.storageBehavior.depositAll(domainBot, chestPos);
    }
    withdraw(domainBot, chestPos, itemName, count) {
        return this.storageBehavior.withdraw(domainBot, chestPos, itemName, count);
    }
    // ─── Building ─────────────────────────────────────────────────────────────
    buildFromQueue(domainBot, queue) {
        return this.buildBehavior.buildFromQueue(domainBot, queue);
    }
    // ─── Inventory ────────────────────────────────────────────────────────────
    equip(domainBot, itemName) {
        return this.inventoryBehavior.equip(domainBot, itemName);
    }
    eat(domainBot) {
        return this.inventoryBehavior.eat(domainBot);
    }
    // ─── Farm ─────────────────────────────────────────────────────────────────
    farm(domainBot, centerX, centerZ, radius) {
        return this.farmBehavior.farm(domainBot, centerX, centerZ, radius);
    }
    stopFarm(domainBot) {
        this.farmBehavior.stopFarm(domainBot);
    }
    // ─── Explore ──────────────────────────────────────────────────────────────
    explore(domainBot, direction) {
        return this.exploreBehavior.explore(domainBot, direction);
    }
    stopExplore(domainBot) {
        this.exploreBehavior.stopExplore(domainBot);
    }
    // ─── Avoid player ─────────────────────────────────────────────────────────
    avoid(domainBot, targetUsernames, triggerRadius) {
        this.avoidBehavior.avoid(domainBot, targetUsernames, triggerRadius);
    }
    stopAvoid(domainBot) {
        this.avoidBehavior.stopAvoid(domainBot);
    }
    // ─── Helpers ──────────────────────────────────────────────────────────────
    async autoEquipToolFor(mfBot, block, mcData) {
        if (!block)
            return;
        const md = mcData;
        // Tool preference order per harvest type
        const TOOL_PRIORITY = {
            pickaxe: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'],
            axe: ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'],
            shovel: ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel', 'golden_shovel'],
            hoe: ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'wooden_hoe', 'golden_hoe'],
            sword: ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'],
        };
        const blockDef = md['blocks'][block.type];
        if (!blockDef?.harvestTools)
            return;
        const validToolIds = new Set(Object.keys(blockDef.harvestTools).map(Number));
        for (const tools of Object.values(TOOL_PRIORITY)) {
            for (const toolName of tools) {
                const toolDef = md['itemsByName'][toolName];
                if (!toolDef || !validToolIds.has(toolDef.id))
                    continue;
                const item = mfBot.inventory.items().find(i => i.type === toolDef.id);
                if (item) {
                    await mfBot.equip(item, 'hand');
                    return;
                }
            }
        }
    }
}
exports.MineflayerAdapter = MineflayerAdapter;
//# sourceMappingURL=MineflayerAdapter.js.map