import { Bot } from '../../../domain/entities/Bot';
import { MetaStore } from '../BotMeta';
export declare class AvoidBehavior {
    private readonly meta;
    constructor(meta: MetaStore);
    avoid(domainBot: Bot, targetUsernames: string[], triggerRadius: number): void;
    stopAvoid(domainBot: Bot): void;
}
//# sourceMappingURL=AvoidBehavior.d.ts.map