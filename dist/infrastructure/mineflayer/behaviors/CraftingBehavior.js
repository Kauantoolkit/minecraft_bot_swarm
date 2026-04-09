"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CraftingBehavior = void 0;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const vec3_1 = require("vec3");
const BotMeta_1 = require("../BotMeta");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
/**
 * CraftingBehavior
 *
 * Wraps mineflayer's craft API with automatic crafting-table management:
 *   - 2×2 recipes craft in-hand (no table needed)
 *   - 3×3 recipes find a nearby table, or place one from inventory,
 *     or craft a table first if none is available
 */
class CraftingBehavior {
    /**
     * Craft `count` of `itemName`.
     * Throws if the bot lacks ingredients or if no recipe exists.
     */
    async craft(domainBot, itemName, count) {
        const mfBot = BotMeta_1.MetaStore.mfBot(domainBot);
        if (!mfBot)
            throw new Error('Bot not connected');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const itemDef = mcData.itemsByName[itemName]
            ?? mcData.blocksByName[itemName];
        if (!itemDef)
            throw new Error(`Unknown item: ${itemName}`);
        // Try 2×2 (no table)
        const simple = mfBot.recipesFor(itemDef.id, null, 1, null);
        if (simple.length > 0) {
            await mfBot.craft(simple[0], count, null);
            return;
        }
        // 3×3 — need a crafting table
        const tableBlock = await this.ensureCraftingTable(domainBot, mfBot);
        const recipes = mfBot.recipesFor(itemDef.id, null, 1, tableBlock);
        if (recipes.length === 0)
            throw new Error(`No recipe for "${itemName}" — missing ingredients?`);
        await mfBot.craft(recipes[0], count, tableBlock);
    }
    /**
     * Return how many of `itemName` the bot can currently craft
     * (considering only available ingredients, ignoring table).
     */
    canCraftCount(domainBot, itemName) {
        const mfBot = BotMeta_1.MetaStore.mfBot(domainBot);
        if (!mfBot)
            return 0;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const itemDef = mcData.itemsByName[itemName]
            ?? mcData.blocksByName[itemName];
        if (!itemDef)
            return 0;
        const recipes = mfBot.recipesFor(itemDef.id, null, 1, null);
        return recipes.length > 0 ? 999 : 0; // simplified — real count needs ingredient checking
    }
    // ── Private helpers ──────────────────────────────────────────────────────
    async ensureCraftingTable(domainBot, mfBot) {
        // 1. Look for nearby table
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const tableId = mcData.blocksByName['crafting_table']?.id;
        const existing = mfBot.findBlock({
            matching: tableId,
            maxDistance: 6,
        });
        if (existing) {
            await this.navigateTo(mfBot, existing.position, 3);
            return existing;
        }
        // 2. Need to place one — craft it first if not in inventory
        const hasTable = mfBot.inventory.items().some(i => i.name === 'crafting_table');
        if (!hasTable) {
            // Craft from planks (2×2, no table needed)
            await this.craft(domainBot, 'crafting_table', 1);
        }
        // 3. Place the table on the block in front of the bot
        return this.placeCraftingTable(domainBot, mfBot);
    }
    async placeCraftingTable(domainBot, mfBot) {
        const tableItem = mfBot.inventory.items().find(i => i.name === 'crafting_table');
        if (!tableItem)
            throw new Error('No crafting_table in inventory');
        await mfBot.equip(tableItem, 'hand');
        // Place on the block directly below the bot's feet (stand on top)
        const feetPos = mfBot.entity.position.floored();
        const belowPos = feetPos.offset(0, -1, 0);
        const below = mfBot.blockAt(belowPos);
        if (!below)
            throw new Error('No solid block to place crafting table on');
        await mfBot.placeBlock(below, new vec3_1.Vec3(0, 1, 0));
        const placed = mfBot.blockAt(feetPos);
        if (!placed)
            throw new Error('Crafting table was not placed');
        return placed;
    }
    navigateTo(mfBot, pos, radius) {
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        return new Promise(res => {
            mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalNear(pos.x, pos.y, pos.z, radius));
            mfBot.once('goal_reached', res);
            setTimeout(res, 15000);
        });
    }
}
exports.CraftingBehavior = CraftingBehavior;
//# sourceMappingURL=CraftingBehavior.js.map