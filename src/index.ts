import { config } from './config';
import { install as installLogBuffer } from './infrastructure/LogBuffer';
installLogBuffer();

// Infrastructure
import { InMemoryBotRepository } from './infrastructure/repositories/InMemoryBotRepository';
import { NetworkProvider } from './infrastructure/network/NetworkProvider';
import { ProxyLoader } from './infrastructure/network/ProxyLoader';

// Worker-based adapter (each bot runs in its own thread)
import { WorkerCommandAdapter } from './worker/WorkerCommandAdapter';

// Application
import { BotManager } from './application/BotManager';
import { SwarmController } from './application/SwarmController';
import { CommandListener } from './application/CommandListener';
import { BotGroupStore } from './application/BotGroupStore';

// Orchestrator
import { Orchestrator } from './orchestrator/Orchestrator';
import { StorageCache } from './infrastructure/storage/StorageCache';

// Web
import { WebServer } from './infrastructure/web/WebServer';

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log(' Minecraft Bot Swarm — starting up');
  console.log('='.repeat(50));
  console.log(`  Server   : ${config.server.host}:${config.server.port} (MC ${config.server.version})`);
  console.log(`  Bots     : ${config.swarm.botCount}`);
  console.log(`  Mode     : ${config.connection.mode}`);
  console.log(`  Master   : ${config.master.username}`);
  console.log(`  Threads  : one Worker thread per bot`);
  console.log('='.repeat(50));

  // ── Infrastructure ────────────────────────────────────────────────────────

  const repository     = new InMemoryBotRepository();
  const networkProvider = new NetworkProvider();
  const proxyLoader    = new ProxyLoader();
  const storage        = new StorageCache();

  // This adapter spawns Worker threads — each bot is truly independent
  const adapter = new WorkerCommandAdapter();

  proxyLoader.load(config.connection.proxyFile);

  // ── Application ───────────────────────────────────────────────────────────

  const botManager  = new BotManager(repository, networkProvider, proxyLoader, adapter);
  const controller  = new SwarmController(repository, adapter, storage);
  const groups      = new BotGroupStore();
  const cmdListener = new CommandListener(controller, repository, adapter, botManager, groups);

  // ── Orchestrator (autonomous colony brain) ────────────────────────────────

  const orchestrator = new Orchestrator(adapter, repository, storage);

  const webServer   = new WebServer(repository, controller, adapter, cmd => cmdListener.dispatch(cmd), config.web.port, orchestrator);

  // When a bot autonomously builds and places chests, register them and
  // set the storage position so the Orchestrator can start assigning deposits.
  adapter.on('chests_placed', (
    _botId: string,
    label: string,
    positions: Array<{ x: number; y: number; z: number }>,
  ) => {
    const added = storage.registerMany(label, positions);
    console.log(`[Main] ${added} chest(s) auto-registered under "${label}"`);
    if (positions.length > 0 && !orchestrator.getState().storagePos) {
      orchestrator.setStoragePos(positions[0].x, positions[0].y, positions[0].z);
      console.log(`[Main] Storage pos set to first placed chest: (${positions[0].x}, ${positions[0].y}, ${positions[0].z})`);
    }
  });

  // When the operator sends a manual command, temporarily suspend autonomous
  // task assignment for the targeted bots so they don't get immediately
  // overridden by the next orchestrator tick.
  adapter.on('cmd_override', (botId: string) => orchestrator.pauseBot(botId));

  // ── Startup sequence ──────────────────────────────────────────────────────

  webServer.start();

  // Spawn all bots (each gets its own Worker thread)
  await botManager.spawnSwarm(config.swarm.botCount);

  // After all bots have spawned, push the swarm username list to every worker
  const usernames = repository.findAll().map(b => b.username);
  adapter.broadcastSwarmUsernames(usernames);

  // Attach in-game chat listeners (works via worker CHAT_MSG events)
  cmdListener.attachChatListeners();

  // Start autonomous orchestration
  orchestrator.start();

  // Start console REPL
  cmdListener.startConsole();

  console.log(`[Main] All ${config.swarm.botCount} bot(s) running in dedicated threads.`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
