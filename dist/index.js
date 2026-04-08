"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const LogBuffer_1 = require("./infrastructure/LogBuffer");
(0, LogBuffer_1.install)();
// Infrastructure
const InMemoryBotRepository_1 = require("./infrastructure/repositories/InMemoryBotRepository");
const NetworkProvider_1 = require("./infrastructure/network/NetworkProvider");
const ProxyLoader_1 = require("./infrastructure/network/ProxyLoader");
// Worker-based adapter (each bot runs in its own thread)
const WorkerCommandAdapter_1 = require("./worker/WorkerCommandAdapter");
// Application
const BotManager_1 = require("./application/BotManager");
const SwarmController_1 = require("./application/SwarmController");
const CommandListener_1 = require("./application/CommandListener");
const BotGroupStore_1 = require("./application/BotGroupStore");
// Orchestrator
const Orchestrator_1 = require("./orchestrator/Orchestrator");
const StorageCache_1 = require("./infrastructure/storage/StorageCache");
// Web
const WebServer_1 = require("./infrastructure/web/WebServer");
async function main() {
    console.log('='.repeat(50));
    console.log(' Minecraft Bot Swarm — starting up');
    console.log('='.repeat(50));
    console.log(`  Server   : ${config_1.config.server.host}:${config_1.config.server.port} (MC ${config_1.config.server.version})`);
    console.log(`  Bots     : ${config_1.config.swarm.botCount}`);
    console.log(`  Mode     : ${config_1.config.connection.mode}`);
    console.log(`  Master   : ${config_1.config.master.username}`);
    console.log(`  Threads  : one Worker thread per bot`);
    console.log('='.repeat(50));
    // ── Infrastructure ────────────────────────────────────────────────────────
    const repository = new InMemoryBotRepository_1.InMemoryBotRepository();
    const networkProvider = new NetworkProvider_1.NetworkProvider();
    const proxyLoader = new ProxyLoader_1.ProxyLoader();
    const storage = new StorageCache_1.StorageCache();
    // This adapter spawns Worker threads — each bot is truly independent
    const adapter = new WorkerCommandAdapter_1.WorkerCommandAdapter();
    proxyLoader.load(config_1.config.connection.proxyFile);
    // ── Application ───────────────────────────────────────────────────────────
    const botManager = new BotManager_1.BotManager(repository, networkProvider, proxyLoader, adapter);
    const controller = new SwarmController_1.SwarmController(repository, adapter);
    const groups = new BotGroupStore_1.BotGroupStore();
    const cmdListener = new CommandListener_1.CommandListener(controller, repository, adapter, botManager, groups);
    const webServer = new WebServer_1.WebServer(repository, controller, adapter, cmd => cmdListener.dispatch(cmd), config_1.config.web.port);
    // ── Orchestrator (autonomous colony brain) ────────────────────────────────
    const orchestrator = new Orchestrator_1.Orchestrator(adapter, repository, storage);
    // When the operator sends a manual command, temporarily suspend autonomous
    // task assignment for the targeted bots so they don't get immediately
    // overridden by the next orchestrator tick.
    adapter.on('cmd_override', (botId) => orchestrator.pauseBot(botId));
    // ── Startup sequence ──────────────────────────────────────────────────────
    webServer.start();
    // Spawn all bots (each gets its own Worker thread)
    await botManager.spawnSwarm(config_1.config.swarm.botCount);
    // After all bots have spawned, push the swarm username list to every worker
    const usernames = repository.findAll().map(b => b.username);
    adapter.broadcastSwarmUsernames(usernames);
    // Attach in-game chat listeners (works via worker CHAT_MSG events)
    cmdListener.attachChatListeners();
    // Start autonomous orchestration
    orchestrator.start();
    // Start console REPL
    cmdListener.startConsole();
    console.log(`[Main] All ${config_1.config.swarm.botCount} bot(s) running in dedicated threads.`);
}
main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map