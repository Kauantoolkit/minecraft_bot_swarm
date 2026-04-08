"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaStore = void 0;
/**
 * Thin wrapper around WeakMap<Bot, BotMeta> with lazy initialisation.
 *
 * Behaviors receive this store via the adapter and call `store.get(bot)` to
 * read/write their fields without needing to reach into the adapter's internals.
 */
class MetaStore {
    constructor() {
        this.map = new WeakMap();
    }
    get(bot) {
        if (!this.map.has(bot))
            this.map.set(bot, { activeMode: 'idle' });
        return this.map.get(bot);
    }
    /** Returns the mineflayer bot handle typed correctly, or null if not set. */
    static mfBot(bot) {
        return bot.handle ?? null;
    }
}
exports.MetaStore = MetaStore;
//# sourceMappingURL=BotMeta.js.map