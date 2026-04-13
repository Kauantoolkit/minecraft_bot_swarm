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
    // 1. Look for nearby table
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const tableId = (mcData.blocksByName as Record<string, { id: number }>)['crafting_table']?.id;

    const existing = (mfBot.findBlock as Function)({
      matching: tableId,
      maxDistance: 6,
    }) as Block | null;

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

  private async placeCraftingTable(domainBot: Bot, mfBot: MineflayerBot): Promise<Block> {
    const tableItem = mfBot.inventory.items().find(i => i.name === 'crafting_table');
    if (!tableItem) throw new Error('No crafting_table in inventory');
    await mfBot.equip(tableItem as Parameters<MineflayerBot['equip']>[0], 'hand');

    // Place on the block directly below the bot's feet (stand on top)
    const feetPos  = mfBot.entity.position.floored();
    const belowPos = feetPos.offset(0, -1, 0);
    const below    = mfBot.blockAt(belowPos);
    if (!below) throw new Error('No solid block to place crafting table on');

    if (below.boundingBox !== 'block') throw new Error('Block below bot is not solid — cannot place crafting table');

    // If the target position already has a crafting table (e.g. from a previous session), reuse it.
    const alreadyThere = mfBot.blockAt(feetPos);
    if (alreadyThere?.name === 'crafting_table') return alreadyThere;

    try {
      await mfBot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
      // placeBlock may time out even when placement succeeded (server lag or missed blockUpdate).
      // Fall through and verify the block state directly.
    }

    // Give the server a moment to confirm the placement before reading world state.
    await new Promise(r => setTimeout(r, 400));

    const placed = mfBot.blockAt(feetPos);
    if (!placed || placed.name !== 'crafting_table') throw new Error('Crafting table was not placed');
    return placed;
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
