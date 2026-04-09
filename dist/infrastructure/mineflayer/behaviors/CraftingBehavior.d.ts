import { Bot } from '../../../domain/entities/Bot';
/**
 * CraftingBehavior
 *
 * Wraps mineflayer's craft API with automatic crafting-table management:
 *   - 2×2 recipes craft in-hand (no table needed)
 *   - 3×3 recipes find a nearby table, or place one from inventory,
 *     or craft a table first if none is available
 */
export declare class CraftingBehavior {
    /**
     * Craft `count` of `itemName`.
     * Throws if the bot lacks ingredients or if no recipe exists.
     */
    craft(domainBot: Bot, itemName: string, count: number): Promise<void>;
    /**
     * Return how many of `itemName` the bot can currently craft
     * (considering only available ingredients, ignoring table).
     */
    canCraftCount(domainBot: Bot, itemName: string): number;
    private ensureCraftingTable;
    private placeCraftingTable;
    private navigateTo;
}
//# sourceMappingURL=CraftingBehavior.d.ts.map