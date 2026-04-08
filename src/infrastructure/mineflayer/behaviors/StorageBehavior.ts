import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { createMovements } from '../physics/PhysicsPatch';

/** Minimum empty inventory slots before the bot considers itself "full". */
export const INVENTORY_FULL_THRESHOLD = 5;

export function isInventoryFull(mfBot: MineflayerBot): boolean {
  // emptySlotCount covers the 36 main slots (hotbar + inventory)
  const empty = (mfBot.inventory as unknown as { emptySlotCount(): number }).emptySlotCount?.() ?? 0;
  return empty < INVENTORY_FULL_THRESHOLD;
}

const CHEST_BLOCK_NAMES = ['chest', 'trapped_chest', 'barrel', 'shulker_box',
  'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box', 'light_blue_shulker_box',
  'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box', 'gray_shulker_box',
  'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
  'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
];

export class StorageBehavior {
  /**
   * Navigate to (x, y, z) and scan the surrounding area for chest/barrel blocks.
   * Returns their positions so the caller can register them in StorageCache.
   */
  async scanNearbyChests(
    domainBot: Bot,
    x: number, y: number, z: number,
    radius: number,
  ): Promise<Array<{ x: number; y: number; z: number }>> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return [];

    // Navigate to the scan centre
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    await new Promise<void>(res => {
      mfBot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 3));
      mfBot.once('goal_reached', res);
      setTimeout(res, 20_000);
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const validIds = new Set<number>(
      CHEST_BLOCK_NAMES.map((n: string) => (mcData.blocksByName[n] as { id: number } | undefined)?.id)
        .filter((id): id is number => id !== undefined),
    );

    const found = (mfBot as unknown as {
      findBlocks(opts: { matching: (b: { type: number }) => boolean; maxDistance: number; count: number }): Vec3[];
    }).findBlocks({
      matching: (b: { type: number }) => validIds.has(b.type),
      maxDistance: radius,
      count: 256,
    });

    console.log(`[Storage] ${domainBot.username}: found ${found.length} chest(s) within r=${radius} of (${x},${y},${z})`);
    return found.map((v: Vec3) => ({ x: v.x, y: v.y, z: v.z }));
  }


  /**
   * Navigate to a chest/barrel and deposit ALL items from the bot's inventory.
   * Skips tools (anything with durability) to avoid depositing equipped gear.
   */
  async depositAll(domainBot: Bot, chestPos: Vec3): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const chestBlock = mfBot.blockAt(chestPos);
    if (!chestBlock) {
      console.warn(`[Storage] ${domainBot.username}: no block at chest pos (${chestPos.x},${chestPos.y},${chestPos.z})`);
      return;
    }

    // Navigate adjacent to the chest
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    await new Promise<void>((res) => {
      mfBot.pathfinder.setGoal(new goals.GoalNear(chestPos.x, chestPos.y, chestPos.z, 3));
      mfBot.once('goal_reached', res);
      setTimeout(res, 15000);
    });

    // Re-fetch block after moving (chunk may have loaded)
    const block = mfBot.blockAt(chestPos);
    if (!block) {
      console.warn(`[Storage] ${domainBot.username}: chest block not loaded after navigation`);
      return;
    }

    type ChestWindow = { items(): Array<{ type: number; count: number; metadata: number; nbt?: { value?: { Damage?: { value?: number } } } }>; deposit(type: number, meta: number | null, count: number): Promise<void>; close(): void };
    let chest: ChestWindow | null = null;
    try {
      chest = await (mfBot as unknown as { openChest(b: unknown): Promise<ChestWindow> }).openChest(block);
      if (!chest) return;

      const items = mfBot.inventory.items() as Array<{ type: number; count: number; metadata: number; nbt?: { value?: { Damage?: { value?: number } } } } >;

      for (const item of items) {
        // Skip items with durability (tools, weapons, armor) to avoid depositing gear
        const hasDurability = (item.nbt?.value?.Damage?.value ?? 0) > 0;
        if (hasDurability) continue;

        try {
          await chest.deposit(item.type, item.metadata ?? null, item.count);
        } catch {
          // Item may have already been moved or slot changed — skip
        }
      }

      console.log(`[Storage] ${domainBot.username}: deposited inventory → (${chestPos.x},${chestPos.y},${chestPos.z})`);
    } catch (err) {
      console.warn(`[Storage] ${domainBot.username}: depositAll failed — ${err}`);
    } finally {
      chest?.close();
    }
  }

  /**
   * Navigate to a chest and withdraw a specific item by name.
   * Returns the number of items actually withdrawn.
   */
  async withdraw(domainBot: Bot, chestPos: Vec3, itemName: string, count: number): Promise<number> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return 0;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const itemDef = mcData.itemsByName[itemName] ?? mcData.blocksByName[itemName];
    if (!itemDef) {
      console.warn(`[Storage] ${domainBot.username}: unknown item "${itemName}"`);
      return 0;
    }

    const block = mfBot.blockAt(chestPos);
    if (!block) return 0;

    mfBot.pathfinder.setMovements(createMovements(mfBot));
    await new Promise<void>((res) => {
      mfBot.pathfinder.setGoal(new goals.GoalNear(chestPos.x, chestPos.y, chestPos.z, 3));
      mfBot.once('goal_reached', res);
      setTimeout(res, 15000);
    });

    const freshBlock = mfBot.blockAt(chestPos);
    if (!freshBlock) return 0;

    type Chest = { items(): Array<{ type: number; count: number; metadata: number }>; withdraw(type: number, meta: number | null, count: number): Promise<void>; close(): void };
    let chest: Chest | null = null;
    let withdrawn = 0;
    try {
      chest = await (mfBot as unknown as { openChest(b: unknown): Promise<Chest> }).openChest(freshBlock);
      if (!chest) return 0;

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
    } catch (err) {
      console.warn(`[Storage] ${domainBot.username}: withdraw failed — ${err}`);
    } finally {
      chest?.close();
    }
    return withdrawn;
  }
}
