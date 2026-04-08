import { Bot as MineflayerBot } from 'mineflayer';
import { Bot } from '../../../domain/entities/Bot';

export class InventoryBehavior {
  async equip(domainBot: Bot, itemName: string): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const itemDef = mcData.itemsByName[itemName] ?? mcData.blocksByName[itemName];
    if (!itemDef) {
      console.warn(`[Inventory] ${domainBot.username}: unknown item "${itemName}"`);
      return;
    }

    const item = (mfBot.inventory.items() as Array<{ type: number }>).find(i => i.type === itemDef.id);
    if (!item) {
      console.warn(`[Inventory] ${domainBot.username}: "${itemName}" not in inventory`);
      return;
    }

    await mfBot.equip(item as Parameters<MineflayerBot['equip']>[0], 'hand');
  }

  async eat(domainBot: Bot): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);

    const foodItem = (mfBot.inventory.items() as Array<{ type: number }>)
      .filter(i => mcData.foods[i.type])
      .sort((a, b) => (mcData.foods[b.type]?.foodPoints ?? 0) - (mcData.foods[a.type]?.foodPoints ?? 0))[0];

    if (!foodItem) {
      console.warn(`[Inventory] ${domainBot.username}: no food`);
      return;
    }

    await mfBot.equip(foodItem as Parameters<MineflayerBot['equip']>[0], 'hand');
    await mfBot.consume();
  }
}
