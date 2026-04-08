"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryBehavior = void 0;
class InventoryBehavior {
    async equip(domainBot, itemName) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const itemDef = mcData.itemsByName[itemName] ?? mcData.blocksByName[itemName];
        if (!itemDef) {
            console.warn(`[Inventory] ${domainBot.username}: unknown item "${itemName}"`);
            return;
        }
        const item = mfBot.inventory.items().find(i => i.type === itemDef.id);
        if (!item) {
            console.warn(`[Inventory] ${domainBot.username}: "${itemName}" not in inventory`);
            return;
        }
        await mfBot.equip(item, 'hand');
    }
    async eat(domainBot) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const foodItem = mfBot.inventory.items()
            .filter(i => mcData.foods[i.type])
            .sort((a, b) => (mcData.foods[b.type]?.foodPoints ?? 0) - (mcData.foods[a.type]?.foodPoints ?? 0))[0];
        if (!foodItem) {
            console.warn(`[Inventory] ${domainBot.username}: no food`);
            return;
        }
        await mfBot.equip(foodItem, 'hand');
        await mfBot.consume();
    }
}
exports.InventoryBehavior = InventoryBehavior;
//# sourceMappingURL=InventoryBehavior.js.map