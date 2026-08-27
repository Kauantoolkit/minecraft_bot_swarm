import { Bot as MineflayerBot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { MetaStore } from '../BotMeta';
import { createMovements } from '../physics/PhysicsPatch';

/**
 * CraftingBehavior
 *
 * Wraps mineflayer's craft API with automatic crafting-table management:
 *   - 2×2 recipes craft in-hand (no table needed)
 *   - 3×3 recipes find a nearby table, or place one from inventory,
 *     or craft a table first if none is available
 */
export class CraftingBehavior {

  /**
   * Craft `count` of `itemName`.
   * Throws if the bot lacks ingredients or if no recipe exists.
   */
  async craft(domainBot: Bot, itemName: string, count: number): Promise<void> {
    const mfBot = MetaStore.mfBot(domainBot);
    if (!mfBot) throw new Error('Bot not connected');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const itemDef = (mcData.itemsByName as Record<string, { id: number }>)[itemName]
                 ?? (mcData.blocksByName as Record<string, { id: number }>)[itemName];
    if (!itemDef) throw new Error(`Unknown item: ${itemName}`);

    // Try 2×2 (no table)
    const simple = (mfBot.recipesFor as Function)(itemDef.id, null, 1, null) as unknown[];
    if (simple.length > 0) {
      await (mfBot.craft as Function)(simple[0], count, null);
      return;
    }

    // 3×3 — need a crafting table
    const tableBlock = await this.ensureCraftingTable(domainBot, mfBot);
    const recipes = (mfBot.recipesFor as Function)(itemDef.id, null, 1, tableBlock) as unknown[];
    if (recipes.length === 0) throw new Error(`No recipe for "${itemName}" — missing ingredients?`);
    await (mfBot.craft as Function)(recipes[0], count, tableBlock);
  }

  /**
   * Return how many of `itemName` the bot can currently craft
   * (considering only available ingredients, ignoring table).
   */
  canCraftCount(domainBot: Bot, itemName: string): number {
    const mfBot = MetaStore.mfBot(domainBot);
    if (!mfBot) return 0;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const itemDef = (mcData.itemsByName as Record<string, { id: number }>)[itemName]
                 ?? (mcData.blocksByName as Record<string, { id: number }>)[itemName];
    if (!itemDef) return 0;
    const recipes = (mfBot.recipesFor as Function)(itemDef.id, null, 1, null) as unknown[];
    return recipes.length > 0 ? 999 : 0; // simplified — real count needs ingredient checking
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async ensureCraftingTable(domainBot: Bot, mfBot: MineflayerBot): Promise<Block> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const tableId = (mcData.blocksByName as Record<string, { id: number }>)['crafting_table']?.id;

    // 1. Look for an existing table within 32 blocks — reuse if found.
    //    Large radius so placed tables near the base are found even after the bot wanders.
    const existing = (mfBot.findBlock as Function)({
      matching: tableId,
      maxDistance: 32,
    }) as Block | null;

    if (existing) {
      await this.navigateTo(mfBot, existing.position, 3);
      return existing;
    }

    // 2. Need to place one — craft it first if not in inventory
    const hasTable = mfBot.inventory.items().some(i => i.name === 'crafting_table');
    if (!hasTable) {
      await this.craft(domainBot, 'crafting_table', 1);
    }

    // 3. Find a clear surface and place the table there
    return this.placeCraftingTable(domainBot, mfBot);
  }

  /**
   * Find an exposed solid block nearby, navigate ADJACENT to it using
   * GoalGetToBlock (so the bot is never standing on the target position),
   * then place the crafting table on top of that block.
   *
   * This avoids the two main failure modes:
   *   a) Bot surrounded by tree trunks — findBlock skips those because
   *      they have no empty space above.
   *   b) Server rejects placement at bot's feet — GoalGetToBlock puts the
   *      bot NEXT TO the target, not on top of it.
   */
  private async placeCraftingTable(domainBot: Bot, mfBot: MineflayerBot): Promise<Block> {
    const tableItem = mfBot.inventory.items().find(i => i.name === 'crafting_table');
    if (!tableItem) throw new Error('No crafting_table in inventory');

    // The block directly below the bot's feet — we cannot place the table here
    // because the server considers it occupied by the bot's hitbox.
    const botFloor = mfBot.entity.position.floored().offset(0, -1, 0);

    // Find an exposed solid block: solid floor with empty/replaceable air above.
    // useExtraInfo=true lets the callback read block data via mfBot.blockAt().
    const floorBlock = (mfBot.findBlock as Function)({
      matching: (b: Block) => {
        if (b.boundingBox !== 'block') return false;
        // Skip the block the bot is standing on — placing above it = bot's feet position
        if (b.position.x === botFloor.x &&
            b.position.y === botFloor.y &&
            b.position.z === botFloor.z) return false;
        // The slot directly above must be empty (where the crafting table will land)
        const above = mfBot.blockAt(b.position.offset(0, 1, 0));
        return !above || above.boundingBox !== 'block';
      },
      maxDistance: 16,
      useExtraInfo: true,
    }) as Block | null;

    if (!floorBlock) {
      throw new Error('No suitable surface found for crafting table within 16 blocks');
    }

    const targetPos = floorBlock.position.offset(0, 1, 0);

    // Reuse if another bot or a previous attempt already placed a table here
    const alreadyThere = mfBot.blockAt(targetPos);
    if (alreadyThere?.name === 'crafting_table') return alreadyThere;

    // GoalGetToBlock navigates the bot to a position adjacent to the target block,
    // never ON TOP of it — exactly what we need so the server accepts the placement.
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    await new Promise<void>(res => {
      mfBot.pathfinder.setGoal(new goals.GoalGetToBlock(targetPos.x, targetPos.y, targetPos.z));
      mfBot.once('goal_reached', res);
      setTimeout(res, 15_000);
    });

    // Re-equip after navigation (slot order may have shifted)
    const freshItem = mfBot.inventory.items().find(i => i.name === 'crafting_table');
    if (!freshItem) throw new Error('Lost crafting table during navigation');
    await mfBot.equip(freshItem as Parameters<MineflayerBot['equip']>[0], 'hand');

    // Verify the floor block is still solid (could have changed)
    const freshFloor = mfBot.blockAt(floorBlock.position);
    if (!freshFloor || freshFloor.boundingBox !== 'block') {
      throw new Error('Floor block changed during navigation');
    }

    try {
      await mfBot.placeBlock(freshFloor, new Vec3(0, 1, 0));
    } catch {
      // placeBlock rejects with a timeout even when the placement succeeds on the server.
      // Fall through and verify world state.
    }

    await new Promise(r => setTimeout(r, 800));

    const placed = mfBot.blockAt(targetPos);
    if (placed?.name === 'crafting_table') return placed;

    throw new Error('Crafting table was not placed');
  }

  private navigateTo(mfBot: MineflayerBot, pos: Vec3, radius: number): Promise<void> {
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    return new Promise<void>(res => {
      mfBot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, radius));
      mfBot.once('goal_reached', res);
      setTimeout(res, 15_000);
    });
  }
}
