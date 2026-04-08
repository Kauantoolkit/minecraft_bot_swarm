import { Bot } from '../../../domain/entities/Bot';
import { MetaStore } from '../BotMeta';
export declare class DefendBehavior {
    private readonly meta;
    constructor(meta: MetaStore);
    /**
     * Background self-defense mode.
     *
     * Runs independently of the primary mode (does not change activeMode).
     * Priority order:
     *   1. Creeper within CREEPER_FLEE_RADIUS → flee
     *   2. Hostile mob within radius → chase + attack
     *   3. Nothing → leave pathfinder untouched
     *
     * When returning to idle, calls meta.resumeCallback() so async modes
     * (explore, farm) can restart their current leg immediately instead of
     * waiting for their 30-second timeout.
     */
    start(domainBot: Bot, radius: number): void;
    stop(domainBot: Bot): void;
}
//# sourceMappingURL=DefendBehavior.d.ts.map