"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotManager = void 0;
const Bot_1 = require("../domain/entities/Bot");
const config_1 = require("../config");
class BotManager {
    constructor(repository, networkProvider, proxyLoader, adapter) {
        this.repository = repository;
        this.networkProvider = networkProvider;
        this.proxyLoader = proxyLoader;
        this.adapter = adapter;
    }
    async spawnSwarm(count) {
        console.log(`[BotManager] Spawning ${count} bots...`);
        const useProxy = config_1.config.connection.mode === 'proxy' && this.proxyLoader.hasProxies();
        if (config_1.config.connection.mode === 'proxy' && !this.proxyLoader.hasProxies()) {
            console.warn('[BotManager] Proxy mode requested but proxy list is empty — falling back to direct.');
        }
        for (let i = 0; i < count; i++) {
            const username = `${config_1.config.swarm.usernamePrefix}_${i + 1}`;
            const proxy = useProxy ? this.proxyLoader.next() : undefined;
            const bot = new Bot_1.Bot({ id: `bot_${i + 1}`, username, proxy });
            this.repository.add(bot);
            const connOptions = this.networkProvider.buildConnectionOptions(username, proxy);
            try {
                await this.adapter.spawn(bot, connOptions);
            }
            catch (err) {
                console.error(`[BotManager] Failed to spawn ${username}: ${err.message}`);
            }
            if (i < count - 1) {
                await sleep(config_1.config.swarm.spawnDelayMs);
            }
        }
        console.log(`[BotManager] Swarm ready — ${this.repository.count()} bots online`);
    }
    async spawnMore(count) {
        const existing = this.repository.count();
        console.log(`[BotManager] Spawning ${count} more bots (existing: ${existing})...`);
        const useProxy = config_1.config.connection.mode === 'proxy' && this.proxyLoader.hasProxies();
        for (let i = 0; i < count; i++) {
            const index = existing + i + 1;
            const username = `${config_1.config.swarm.usernamePrefix}_${index}`;
            const proxy = useProxy ? this.proxyLoader.next() : undefined;
            const bot = new Bot_1.Bot({ id: `bot_${index}`, username, proxy });
            this.repository.add(bot);
            const connOptions = this.networkProvider.buildConnectionOptions(username, proxy);
            try {
                await this.adapter.spawn(bot, connOptions);
            }
            catch (err) {
                console.error(`[BotManager] Failed to spawn ${username}: ${err.message}`);
            }
            if (i < count - 1)
                await sleep(config_1.config.swarm.spawnDelayMs);
        }
        console.log(`[BotManager] Swarm now has ${this.repository.count()} bots`);
    }
    getRepository() {
        return this.repository;
    }
}
exports.BotManager = BotManager;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=BotManager.js.map