"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageBehavior = exports.INVENTORY_FULL_THRESHOLD = void 0;
exports.isInventoryFull = isInventoryFull;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
/** Minimum empty inventory slots before the bot considers itself "full". */
exports.INVENTORY_FULL_THRESHOLD = 5;
function isInventoryFull(mfBot) {
    // emptySlotCount covers the 36 main slots (hotbar + inventory)
    const empty = mfBot.inventory.emptySlotCount?.() ?? 0;
    return empty < exports.INVENTORY_FULL_THRESHOLD;
}
class StorageBehavior {
    /**
     * Navigate to a chest/barrel and deposit ALL items from the bot's inventory.
     * Skips tools (anything with durability) to avoid depositing equipped gear.
     */
    async depositAll(domainBot, chestPos) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        const chestBlock = mfBot.blockAt(chestPos);
        if (!chestBlock) {
            console.warn(`[Storage] ${domainBot.username}: no block at chest pos (${chestPos.x},${chestPos.y},${chestPos.z})`);
            return;
        }
        // Navigate adjacent to the chest
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        await new Promise((res) => {
            mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalNear(chestPos.x, chestPos.y, chestPos.z, 3));
            mfBot.once('goal_reached', res);
            setTimeout(res, 15000);
        });
        // Re-fetch block after moving (chunk may have loaded)
        const block = mfBot.blockAt(chestPos);
        if (!block) {
            console.warn(`[Storage] ${domainBot.username}: chest block not loaded after navigation`);
            return;
        }
        let chest = null;
        try {
            chest = await mfBot.openChest(block);
            if (!chest)
                return;
            const items = mfBot.inventory.items();
            for (const item of items) {
                // Skip items with durability (tools, weapons, armor) to avoid depositing gear
                const hasDurability = (item.nbt?.value?.Damage?.value ?? 0) > 0;
                if (hasDurability)
                    continue;
                try {
                    await chest.deposit(item.type, item.metadata ?? null, item.count);
                }
                catch {
                    // Item may have already been moved or slot changed — skip
                }
            }
            console.log(`[Storage] ${domainBot.username}: deposited inventory → (${chestPos.x},${chestPos.y},${chestPos.z})`);
        }
        catch (err) {
            console.warn(`[Storage] ${domainBot.username}: depositAll failed — ${err}`);
        }
        finally {
            chest?.close();
        }
    }
    /**
     * Navigate to a chest and withdraw a specific item by name.
     * Returns the number of items actually withdrawn.
     */
    async withdraw(domainBot, chestPos, itemName, count) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return 0;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const itemDef = mcData.itemsByName[itemName] ?? mcData.blocksByName[itemName];
        if (!itemDef) {
            console.warn(`[Storage] ${domainBot.username}: unknown item "${itemName}"`);
            return 0;
        }
        const block = mfBot.blockAt(chestPos);
        if (!block)
            return 0;
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        await new Promise((res) => {
            mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalNear(chestPos.x, chestPos.y, chestPos.z, 3));
            mfBot.once('goal_reached', res);
            setTimeout(res, 15000);
        });
        const freshBlock = mfBot.blockAt(chestPos);
        if (!freshBlock)
            return 0;
        let chest = null;
        let withdrawn = 0;
        try {
            chest = await mfBot.openChest(freshBlock);
            if (!chest)
                return 0;
            const chestItems = chest.items().filter(i => i.type === itemDef.id);
            const available = chestItems.reduce((sum, i) => sum + i.count, 0);
            const toWithdraw = Math.min(count, available);
            if (toWithdraw === 0) {
                console.warn(`[Storage] ${domainBot.username}: "${itemName}" not in chest`);
                return 0;
            }
            await chest.withdraw(itemDef.id, null, toWithdraw);
            withdrawn = toWithdraw;
            console.log(`[Storage] ${domainBot.username}: withdrew ${toWithdraw}x ${itemName}`);
        }
        catch (err) {
            console.warn(`[Storage] ${domainBot.username}: withdraw failed — ${err}`);
        }
        finally {
            chest?.close();
        }
        return withdrawn;
    }
}
exports.StorageBehavior = StorageBehavior;
//# sourceMappingURL=StorageBehavior.js.map