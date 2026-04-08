import { Bot as MineflayerBot } from 'mineflayer';
import { Bot } from '../../domain/entities/Bot';
/**
 * Per-bot runtime metadata.
 *
 * Each behavior module owns a subset of these fields.
 * Fields are grouped by owning module in comments to make it clear
 * which behavior is responsible for setting/clearing each one.
 */
export interface BotMeta {
    /** Installed by follow() and pvp(). Starting either removes the other. */
    pvpListener?: () => void;
    /** Companion path_update listener installed alongside pvpListener by follow(). */
    followPathUpdateListener?: (r: {
        status: string;
    }) => void;
    /** Installed by guard() and bodyguard(). Starting either removes the other. */
    guardListener?: () => void;
    defendListener?: () => void;
    _defendHurtListener?: (e: unknown) => void;
    _defendPathUpdateListener?: (r: {
        status: string;
    }) => void;
    avoidListener?: () => void;
    farmingActive?: boolean;
    exploringActive?: boolean;
    /**
     * Populated by async loop modes (explore, farm) at the start of each leg/cycle.
     * Defend calls this when returning to idle so the mode resumes immediately
     * instead of waiting for the 30 s leg timeout.
     */
    resumeCallback?: () => void;
    /** Human-readable active mode shown in the debug status UI. */
    activeMode: string;
}
/**
 * Thin wrapper around WeakMap<Bot, BotMeta> with lazy initialisation.
 *
 * Behaviors receive this store via the adapter and call `store.get(bot)` to
 * read/write their fields without needing to reach into the adapter's internals.
 */
export declare class MetaStore {
    private readonly map;
    get(bot: Bot): BotMeta;
    /** Returns the mineflayer bot handle typed correctly, or null if not set. */
    static mfBot(bot: Bot): MineflayerBot | null;
}
//# sourceMappingURL=BotMeta.d.ts.map