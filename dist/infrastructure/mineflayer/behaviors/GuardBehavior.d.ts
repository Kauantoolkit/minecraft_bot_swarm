import { Bot } from '../../../domain/entities/Bot';
import { SwarmIntel } from '../../../application/SwarmIntel';
import { PlayerRelationshipStore } from '../../../domain/value-objects/PlayerRelationship';
import { MetaStore } from '../BotMeta';
export declare class GuardBehavior {
    private readonly meta;
    constructor(meta: MetaStore);
    guard(domainBot: Bot, x: number, y: number, z: number, radius: number, excludeUsernames: string[], relations?: PlayerRelationshipStore): void;
    bodyguard(domainBot: Bot, protectedUsername: string, radius: number, swarmUsernames: string[], relations?: PlayerRelationshipStore, intel?: SwarmIntel): void;
    stopGuard(domainBot: Bot): void;
}
//# sourceMappingURL=GuardBehavior.d.ts.map