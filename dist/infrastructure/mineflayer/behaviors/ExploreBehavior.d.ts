import { Bot } from '../../../domain/entities/Bot';
import { MetaStore } from '../BotMeta';
export declare class ExploreBehavior {
    private readonly meta;
    constructor(meta: MetaStore);
    explore(domainBot: Bot, direction: 'north' | 'south' | 'east' | 'west' | 'auto'): Promise<void>;
    stopExplore(domainBot: Bot): void;
}
//# sourceMappingURL=ExploreBehavior.d.ts.map