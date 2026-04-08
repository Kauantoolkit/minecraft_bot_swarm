"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwarmController = void 0;
const SchematicLoader_1 = require("../infrastructure/schematic/SchematicLoader");
const BuildQueue_1 = require("../infrastructure/schematic/BuildQueue");
const QuarryQueue_1 = require("../infrastructure/mining/QuarryQueue");
const StorageCache_1 = require("../infrastructure/storage/StorageCache");
const SwarmIntel_1 = require("./SwarmIntel");
const PlayerRelationship_1 = require("../domain/value-objects/PlayerRelationship");
const BUILD_MAX_PASSES = 5;
const BUILD_PASS_DELAY_MS = 3000;
class SwarmController {
    constructor(repository, adapter) {
        this.repository = repository;
        this.adapter = adapter;
        this.buildQueue = new BuildQueue_1.BuildQueue();
        this.quarryQueue = new QuarryQueue_1.QuarryQueue();
        this.intel = new SwarmIntel_1.SwarmIntel();
        this.relations = new PlayerRelationship_1.PlayerRelationshipStore();
        this.storage = new StorageCache_1.StorageCache();
    }
    /**
     * Resolve target to online bot list.
     * If target is undefined → all online bots.
     * If target is a string array → filter by username or id.
     */
    resolve(target) {
        const all = this.repository.findAll().filter(b => b.isOnline());
        if (!target || target.length === 0)
            return all;
        return all.filter(b => target.includes(b.username) || target.includes(b.id));
    }
    log(action, bots) {
        console.log(`[Swarm] ${action} → ${bots.length} bot(s): ${bots.map(b => b.username).join(', ')}`);
    }
    // ─── Movement ─────────────────────────────────────────────────────────────
    async moveAllTo(x, y, z, target) {
        const bots = this.resolve(target);
        this.log(`move(${x},${y},${z})`, bots);
        await Promise.allSettled(bots.map(bot => this.adapter.moveTo(bot, x, y, z).catch(err => console.warn(`[Swarm] ${bot.username} move failed: ${err.message}`))));
    }
    followAll(targetUsername, target) {
        const bots = this.resolve(target);
        this.log(`follow(${targetUsername})`, bots);
        bots.forEach(bot => this.adapter.follow(bot, targetUsername));
    }
    stopAll(target) {
        const bots = this.resolve(target);
        this.log('stop', bots);
        bots.forEach(bot => this.adapter.stop(bot));
    }
    // ─── Chat ─────────────────────────────────────────────────────────────────
    sayAll(message, target) {
        const bots = this.resolve(target);
        this.log(`say("${message}")`, bots);
        bots.forEach(bot => this.adapter.say(bot, message));
    }
    // ─── Combat ───────────────────────────────────────────────────────────────
    attackAll(targetUsername, target) {
        const bots = this.resolve(target);
        this.log(`attack(${targetUsername})`, bots);
        bots.forEach(bot => this.adapter.attack(bot, targetUsername));
    }
    pvpAll(targetUsernames, target) {
        const bots = this.resolve(target);
        this.log(`pvp([${targetUsernames.join(', ')}])`, bots);
        bots.forEach(bot => this.adapter.pvp(bot, targetUsernames, this.intel, this.relations));
    }
    bodyguardAll(protectedUsername, radius, target) {
        const bots = this.resolve(target);
        this.log(`bodyguard(${protectedUsername})`, bots);
        const swarmUsernames = bots.map(b => b.username);
        bots.forEach(bot => this.adapter.bodyguard(bot, protectedUsername, radius, swarmUsernames, this.relations, this.intel));
    }
    guardAll(x, y, z, radius, target) {
        const bots = this.resolve(target);
        this.log(`guard(${x},${y},${z} r=${radius})`, bots);
        const botUsernames = bots.map(b => b.username);
        bots.forEach(bot => this.adapter.guard(bot, x, y, z, radius, botUsernames, this.relations));
    }
    defendAll(radius, target) {
        const bots = this.resolve(target);
        this.log(`defend(r=${radius})`, bots);
        bots.forEach(bot => this.adapter.startDefend(bot, radius));
    }
    stopDefendAll(target) {
        const bots = this.resolve(target);
        this.log('stopDefend', bots);
        bots.forEach(bot => this.adapter.stopDefend(bot));
    }
    avoidAll(targetUsernames, radius, target) {
        const bots = this.resolve(target);
        this.log(`avoid([${targetUsernames.join(', ')}] r=${radius})`, bots);
        bots.forEach(bot => this.adapter.avoid(bot, targetUsernames, radius));
    }
    // ─── Resources ────────────────────────────────────────────────────────────
    collectAll(blockName, count, storageLabel, target) {
        const bots = this.resolve(target);
        this.log(`collect(${blockName} x${count}${storageLabel ? ` →${storageLabel}` : ''})`, bots);
        bots.forEach(bot => {
            const onFull = storageLabel ? this.makeDepositFn(storageLabel, bot) : undefined;
            this.adapter.collect(bot, blockName, count, onFull).catch(err => console.warn(`[Swarm] ${bot.username} collect error: ${err.message}`));
        });
    }
    collectVeinAll(blockName, count, storageLabel, target) {
        const bots = this.resolve(target);
        this.log(`collectVein(${blockName} x${count}${storageLabel ? ` →${storageLabel}` : ''})`, bots);
        bots.forEach(bot => {
            const onFull = storageLabel ? this.makeDepositFn(storageLabel, bot) : undefined;
            this.adapter.collectVein(bot, blockName, count, onFull).catch(err => console.warn(`[Swarm] ${bot.username} vein error: ${err.message}`));
        });
    }
    quarryAll(x1, y1, z1, x2, y2, z2, storageLabel, target) {
        const bots = this.resolve(target);
        this.quarryQueue.load(x1, y1, z1, x2, y2, z2);
        this.log(`quarry${storageLabel ? ` →${storageLabel}` : ''}`, bots);
        bots.forEach(bot => {
            const onFull = storageLabel ? this.makeDepositFn(storageLabel, bot) : undefined;
            this.adapter.quarryFromQueue(bot, this.quarryQueue, onFull).catch(err => console.warn(`[Swarm] ${bot.username} quarry error: ${err.message}`));
        });
    }
    depositAll(storageLabel, target) {
        const bots = this.resolve(target);
        bots.forEach(bot => {
            const chestPos = this.resolveChestPos(storageLabel, bot);
            if (!chestPos)
                return;
            this.adapter.depositAll(bot, chestPos).catch(err => console.warn(`[Swarm] ${bot.username} deposit error: ${err.message}`));
        });
    }
    withdraw(storageLabel, itemName, count, target) {
        const bots = this.resolve(target);
        bots.forEach(bot => {
            const chestPos = this.resolveChestPos(storageLabel, bot);
            if (!chestPos)
                return;
            this.adapter.withdraw(bot, chestPos, itemName, count).catch(err => console.warn(`[Swarm] ${bot.username} withdraw error: ${err.message}`));
        });
    }
    // ─── Storage helpers ───────────────────────────────────────────────────────
    resolveChestPos(label, bot) {
        if (label === 'nearest') {
            const mfBot = bot.handle;
            const botPos = mfBot?.entity?.position;
            if (!botPos)
                return null;
            return this.storage.getNearest(botPos)?.pos ?? null;
        }
        const pos = this.storage.getByLabel(label);
        if (!pos)
            console.warn(`[Swarm] unknown storage label "${label}"`);
        return pos;
    }
    makeDepositFn(label, bot) {
        return async (domainBot) => {
            const mfBot = bot.handle;
            const botPos = mfBot?.entity?.position;
            const chestPos = label === 'nearest' && botPos
                ? this.storage.getNearest(botPos)?.pos
                : this.storage.getByLabel(label);
            if (!chestPos) {
                console.warn(`[Swarm] ${domainBot.username}: no storage for label "${label}" — skipping deposit`);
                return;
            }
            await this.adapter.depositAll(domainBot, chestPos);
        };
    }
    farmAll(centerX, centerZ, radius, target) {
        const bots = this.resolve(target);
        this.log(`farm(${centerX},${centerZ} r=${radius})`, bots);
        bots.forEach(bot => {
            this.adapter.farm(bot, centerX, centerZ, radius).catch(err => console.warn(`[Swarm] ${bot.username} farm error: ${err.message}`));
        });
    }
    exploreAll(direction, target) {
        const bots = this.resolve(target);
        this.log(`explore(${direction})`, bots);
        bots.forEach(bot => {
            this.adapter.explore(bot, direction).catch(err => console.warn(`[Swarm] ${bot.username} explore error: ${err.message}`));
        });
    }
    // ─── Building ─────────────────────────────────────────────────────────────
    async buildAll(schematicPath, x, y, z, target) {
        const bots = this.resolve(target);
        this.log(`build(${schematicPath})`, bots);
        const loader = new SchematicLoader_1.SchematicLoader();
        const tasks = await loader.load(schematicPath, x, y, z);
        this.buildQueue.load(tasks);
        for (let pass = 1; pass <= BUILD_MAX_PASSES; pass++) {
            if (this.buildQueue.isEmpty() && !this.buildQueue.hasDeferredTasks())
                break;
            console.log(`[Swarm] Build pass ${pass}/${BUILD_MAX_PASSES} — ${this.buildQueue.remaining} blocks remaining`);
            await Promise.allSettled(bots.map(bot => this.adapter.buildFromQueue(bot, this.buildQueue).catch(err => console.warn(`[Swarm] ${bot.username} build error: ${err.message}`))));
            if (!this.buildQueue.hasDeferredTasks())
                break;
            const missing = this.buildQueue.getMissingBlocks();
            console.log(`[Swarm] Pass ${pass} done — missing: ${missing.join(', ')}`);
            await Promise.allSettled(missing.map(blockName => Promise.allSettled(bots.map(bot => this.adapter.collect(bot, blockName, 64).catch(() => { })))));
            if (this.buildQueue.restoreDeferred() === 0)
                break;
            await sleep(BUILD_PASS_DELAY_MS);
        }
        console.log(this.buildQueue.remaining === 0
            ? '[Swarm] Build complete!'
            : `[Swarm] Build stopped — ${this.buildQueue.remaining} blocks unplaced`);
    }
    // ─── Inventory ────────────────────────────────────────────────────────────
    equipAll(itemName, target) {
        const bots = this.resolve(target);
        this.log(`equip(${itemName})`, bots);
        bots.forEach(bot => {
            this.adapter.equip(bot, itemName).catch(err => console.warn(`[Swarm] ${bot.username} equip error: ${err.message}`));
        });
    }
    eatAll(target) {
        const bots = this.resolve(target);
        this.log('eat', bots);
        bots.forEach(bot => {
            this.adapter.eat(bot).catch(err => console.warn(`[Swarm] ${bot.username} eat error: ${err.message}`));
        });
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────────
    disconnectAll(target) {
        const bots = target ? this.resolve(target) : this.repository.findAll();
        this.log('disconnect', bots);
        bots.forEach(bot => this.adapter.disconnect(bot));
    }
    status() {
        const bots = this.repository.findAll();
        if (bots.length === 0) {
            console.log('[Swarm] No bots registered.');
            return;
        }
        bots.forEach(bot => console.log(`  ${bot}`));
        const online = bots.filter(b => b.isOnline()).length;
        console.log(`  Online: ${online}/${bots.length}`);
    }
}
exports.SwarmController = SwarmController;
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
//# sourceMappingURL=SwarmController.js.map