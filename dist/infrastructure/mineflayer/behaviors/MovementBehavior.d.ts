import { Bot } from '../../../domain/entities/Bot';
import { MetaStore } from '../BotMeta';
export declare class MovementBehavior {
    private readonly meta;
    constructor(meta: MetaStore);
    moveTo(domainBot: Bot, x: number, y: number, z: number): Promise<void>;
    /**
     * Follows a player indefinitely.
     *
     * Internally stores its tick in meta.pvpListener (shared slot with pvp).
     * Starting pvp() after follow() will silently replace this listener.
     * stopPvp() / stop() cleans up both.
     */
    follow(domainBot: Bot, targetUsername: string): void;
}
//# sourceMappingURL=MovementBehavior.d.ts.map