import { config } from './config';
import { install as installLogBuffer } from './infrastructure/LogBuffer';
installLogBuffer(); // capture all console output before anything else starts

// Infrastructure
import { InMemoryBotRepository } from './infrastructure/repositories/InMemoryBotRepository';
import { NetworkProvider } from './infrastructure/network/NetworkProvider';
import { ProxyLoader } from './infrastructure/network/ProxyLoader';
import { MineflayerAdapter } from './infrastructure/mineflayer/MineflayerAdapter';

// Application
import { BotManager } from './application/BotManager';
import { SwarmController } from './application/SwarmController';
import { CommandListener } from './application/CommandListener';
import { BotGroupStore } from './application/BotGroupStore';

// Infrastructure — Web
import { WebServer } from './infrastructure/web/WebServer';

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log(' Minecraft Bot Swarm — starting up');
  console.log('='.repeat(50));
  console.log(`  Server  : ${config.server.host}:${config.server.port} (MC ${config.server.version})`);
  console.log(`  Bots    : ${config.swarm.botCount}`);
  console.log(`  Mode    : ${config.connection.mode}`);
  console.log(`  Master  : ${config.master.username}`);
  console.log('='.repeat(50));

  // --- Composition Root ---

  const repository = new InMemoryBotRepository();
  const networkProvider = new NetworkProvider();
  const proxyLoader = new ProxyLoader();
  const adapter = new MineflayerAdapter();

  proxyLoader.load(config.connection.proxyFile);

  const botManager = new BotManager(repository, networkProvider, proxyLoader, adapter);
  const swarmController = new SwarmController(repository, adapter);
  const groups = new BotGroupStore();
  const commandListener = new CommandListener(swarmController, repository, adapter, botManager, groups);
  const webServer = new WebServer(repository, swarmController, adapter, cmd => commandListener.dispatch(cmd), config.web.port);

  // --- Web debug server ---
  webServer.start();

  // --- Spawn ---
  await botManager.spawnSwarm(config.swarm.botCount);

  // Attach in-game chat listeners after all bots have spawned
  commandListener.attachChatListeners();

  // Start console interface
  commandListener.startConsole();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
