import { Bot } from '../domain/entities/Bot';
import { IBotRepository } from '../domain/repositories/IBotRepository';
import { NetworkProvider } from '../infrastructure/network/NetworkProvider';
import { ProxyLoader } from '../infrastructure/network/ProxyLoader';
import { MineflayerAdapter } from '../infrastructure/mineflayer/MineflayerAdapter';
import { config } from '../config';

export class BotManager {
  constructor(
    private readonly repository: IBotRepository,
    private readonly networkProvider: NetworkProvider,
    private readonly proxyLoader: ProxyLoader,
    private readonly adapter: MineflayerAdapter,
  ) {}

  async spawnSwarm(count: number): Promise<void> {
    console.log(`[BotManager] Spawning ${count} bots...`);

    const useProxy =
      config.connection.mode === 'proxy' && this.proxyLoader.hasProxies();

    if (config.connection.mode === 'proxy' && !this.proxyLoader.hasProxies()) {
      console.warn('[BotManager] Proxy mode requested but proxy list is empty — falling back to direct.');
    }

    for (let i = 0; i < count; i++) {
      const username = `${config.swarm.usernamePrefix}_${i + 1}`;
      const proxy = useProxy ? this.proxyLoader.next() : undefined;

      const bot = new Bot({ id: `bot_${i + 1}`, username, proxy });
      this.repository.add(bot);

      const connOptions = this.networkProvider.buildConnectionOptions(username, proxy);

      try {
        await this.adapter.spawn(bot, connOptions);
      } catch (err) {
        console.error(`[BotManager] Failed to spawn ${username}: ${(err as Error).message}`);
      }

      if (i < count - 1) {
        await sleep(config.swarm.spawnDelayMs);
      }
    }

    console.log(`[BotManager] Swarm ready — ${this.repository.count()} bots online`);
  }

  async spawnMore(count: number): Promise<void> {
    const existing = this.repository.count();
    console.log(`[BotManager] Spawning ${count} more bots (existing: ${existing})...`);

    const useProxy =
      config.connection.mode === 'proxy' && this.proxyLoader.hasProxies();

    for (let i = 0; i < count; i++) {
      const index = existing + i + 1;
      const username = `${config.swarm.usernamePrefix}_${index}`;
      const proxy = useProxy ? this.proxyLoader.next() : undefined;

      const bot = new Bot({ id: `bot_${index}`, username, proxy });
      this.repository.add(bot);

      const connOptions = this.networkProvider.buildConnectionOptions(username, proxy);

      try {
        await this.adapter.spawn(bot, connOptions);
      } catch (err) {
        console.error(`[BotManager] Failed to spawn ${username}: ${(err as Error).message}`);
      }

      if (i < count - 1) await sleep(config.swarm.spawnDelayMs);
    }

    console.log(`[BotManager] Swarm now has ${this.repository.count()} bots`);
  }

  getRepository(): IBotRepository {
    return this.repository;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
