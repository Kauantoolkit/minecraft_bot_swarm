import { Bot } from '../../../domain/entities/Bot';
import { MetaStore } from '../BotMeta';
export declare class FarmBehavior {
    private readonly meta;
    constructor(meta: MetaStore);
    farm(domainBot: Bot, centerX: number, centerZ: number, radius: number): Promise<void>;
    stopFarm(domainBot: Bot): void;
}
//# sourceMappingURL=FarmBehavior.d.ts.map