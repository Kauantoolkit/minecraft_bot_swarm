import { IBotRepository } from '../domain/repositories/IBotRepository';
import { NetworkProvider } from '../infrastructure/network/NetworkProvider';
import { ProxyLoader } from '../infrastructure/network/ProxyLoader';
import { IBotAdapter } from '../infrastructure/mineflayer/IBotAdapter';
export declare class BotManager {
    private readonly repository;
    private readonly networkProvider;
    private readonly proxyLoader;
    private readonly adapter;
    constructor(repository: IBotRepository, networkProvider: NetworkProvider, proxyLoader: ProxyLoader, adapter: IBotAdapter);
    spawnSwarm(count: number): Promise<void>;
    spawnMore(count: number): Promise<void>;
    getRepository(): IBotRepository;
}
//# sourceMappingURL=BotManager.d.ts.map