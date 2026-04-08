import { Bot } from '../../../domain/entities/Bot';
import { SwarmIntel } from '../../../application/SwarmIntel';
import { PlayerRelationshipStore } from '../../../domain/value-objects/PlayerRelationship';
import { MetaStore } from '../BotMeta';
export declare class CombatBehavior {
    private readonly meta;
    constructor(meta: MetaStore);
    /** Single melee hit — one-shot, no loop. */
    attack(domainBot: Bot, targetUsername: string): void;
    /**
     * Continuous PvP mode — chases and attacks targets.
     * Uses pvpListener slot (shared with follow; last writer wins).
     */
    pvp(domainBot: Bot, targetUsernames: string[], intel?: SwarmIntel, relations?: PlayerRelationshipStore): void;
    /**
     * Stops pvp and follow (both share pvpListener slot).
     */
    stopPvp(domainBot: Bot): void;
}
//# sourceMappingURL=CombatBehavior.d.ts.map