import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { createMovements } from '../physics/PhysicsPatch';
import { isInventoryFull, getEmptySlots } from '../utils';

export { isInventoryFull, getEmptySlots };


const CHEST_BLOCK_NAMES = ['chest', 'trapped_chest', 'barrel', 'shulker_box',
  'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box', 'light_blue_shulker_box',
  'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box', 'gray_shulker_box',
  'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
  'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
];

/** TTL for the findChests result cache. Avoids repeated fs.readFileSync per deposit/withdraw. */
const CHEST_CACHE_TTL_MS = 30_000;

export class StorageBehavior {
  /** In-worker cache: last known chest list + timestamp. Invalidated when TTL expires. */
  private _chestCache: { chests: Vec3[]; ts: number } | null = null;

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

    // A scan is a reliable ground-truth refresh — bust the cache.
    this._chestCache = null;

    console.log(`[Storage] ${domainBot.username}: found ${found.length} chest(s) within r=${radius} of (${x},${y},${z})`);
    return found.map((v: Vec3) => ({ x: v.x, y: v.y, z: v.z }));
  }


  /**
   * Navigate to chest and deposit. Tries up to N nearest chests if first is full.
   * Stops when inventory is empty or no progress is made.
   */
  async depositAll(domainBot: Bot, chestPos: Vec3): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const initialEmpty = getEmptySlots(mfBot);

    console.log(`[Storage] ${domainBot.username}: depositAll (initial empty: ${initialEmpty})`);

    const botPos = mfBot.entity.position;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const chests = await this.findChests(mfBot, botPos, mcData, 64);
    if (chests.length === 0) {
      console.warn(`[Storage] ${domainBot.username}: no chests found — skip`);
      return;
    }

    let attempts = 0;
    const MAX_ATTEMPTS = chests.length;

    for (const tryChestPos of chests) {
      attempts++;
      console.log(`[Storage] ${domainBot.username}: tentativa ${attempts}/${MAX_ATTEMPTS} → ${tryChestPos.x}|${tryChestPos.y}|${tryChestPos.z}`);

      const emptyBefore = getEmptySlots(mfBot);

      try {
        await this.depositToChest(domainBot, tryChestPos);
        const emptyAfter = getEmptySlots(mfBot);

        if (emptyAfter > emptyBefore) {
          console.log(`[Storage] ${domainBot.username}: ✅ depositado (${emptyBefore}→${emptyAfter} empty slots)`);
          const remaining = mfBot.inventory.items().filter(
            (i: any) => (i.nbt?.value as any)?.Damage === undefined,
          );
          if (remaining.length === 0) return;
          // Still items left — try next chest
        } else {
          console.warn(`[Storage] ${domainBot.username}: ⚠️ baú cheio (no change ${emptyBefore}→${emptyAfter}) — próximo`);
        }
      } catch (err: any) {
        console.warn(`[Storage] ${domainBot.username}: ❌ tentativa ${attempts} falhou (${err.message}) — próximo`);
      }
    }
    const finalEmpty = getEmptySlots(mfBot);

    console.error(`[Storage] ${domainBot.username}: falhou esvaziar (${initialEmpty}→${finalEmpty} empty slots)`);
    if (finalEmpty === initialEmpty) {
      throw new Error(`Todos os baús cheios ou inválidos — nada depositado (${initialEmpty} slots livres)`);
    }
  }


  /**
   * Build the sorted chest list, using a TTL cache to avoid repeated fs.readFileSync
   * calls within the same operation (e.g. withdraw looping over 8 wood types).
   *
   * Cache is busted whenever:
   *   - TTL expires (30 s)
   *   - scanNearbyChests is called (ground-truth refresh)
   */
  private async findChests(mfBot: MineflayerBot, botPos: Vec3, mcData: any, radius: number): Promise<Vec3[]> {
    const now = Date.now();
    if (this._chestCache && now - this._chestCache.ts < CHEST_CACHE_TTL_MS) {
      // Return cached list re-sorted for the bot's current position
      return [...this._chestCache.chests].sort((a, b) => botPos.distanceTo(a) - botPos.distanceTo(b));
    }

    // Primary: scan the actual world for chest blocks within radius
    const validIds = new Set<number>(
      CHEST_BLOCK_NAMES.map(n => (mcData.blocksByName[n] as { id: number } | undefined)?.id)
        .filter((id): id is number => id !== undefined),
    );
    const worldFound: Vec3[] = (mfBot as any).findBlocks({
      matching: (b: { type: number }) => validIds.has(b.type),
      maxDistance: radius,
      count: 64,
    }).map((v: Vec3) => new Vec3(v.x, v.y, v.z));

    // Secondary: registered storages (may be outside scan radius or in unloaded chunks).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    const instanceKey = process.env.MC_INSTANCE?.trim() ||
      `${process.env.MC_HOST ?? 'localhost'}_${process.env.MC_PORT ?? '25565'}`;
    const STORAGE_PATH = nodePath.join(process.cwd(), 'data', instanceKey, 'storages.json');

    const result = new Map<string, Vec3>(
      worldFound.map(v => [`${v.x},${v.y},${v.z}`, v]),
    );

    try {
      const storagesData: Array<{ label: string; x: number; y: number; z: number }> =
        JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
      let changed = false;
      const kept: typeof storagesData = [];

      for (const entry of storagesData) {
        const pos = new Vec3(entry.x, entry.y, entry.z);
        const dist = botPos.distanceTo(pos);

        if (dist <= radius) {
          const block = mfBot.blockAt(pos);
          if (block && CHEST_BLOCK_NAMES.includes(block.name)) {
            result.set(`${entry.x},${entry.y},${entry.z}`, pos);
            kept.push(entry);
          } else {
            console.warn(`[Storage] Entrada inválida removida: (${entry.x}, ${entry.y}, ${entry.z}) — bloco="${block?.name ?? 'null'}"`);
            changed = true;
          }
        } else {
          kept.push(entry);
          result.set(`${entry.x},${entry.y},${entry.z}`, pos);
        }
      }

      if (changed) {
        fs.writeFileSync(STORAGE_PATH, JSON.stringify(kept, null, 2));
      }
    } catch {
      // storages.json absent or corrupt — use world scan only
    }

    const chests = Array.from(result.values());
    console.log(`[Storage] ${chests.length} baú(s) encontrado(s) dentro de r=${radius}`);

    // Populate cache before sorting (sort is positional, cache stores canonical set)
    this._chestCache = { chests, ts: now };

    return chests.sort((a, b) => botPos.distanceTo(a) - botPos.distanceTo(b));
  }


  private async depositToChest(domainBot: Bot, chestPos: Vec3): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) throw new Error('No bot');

    const block = mfBot.blockAt(chestPos);
    if (!block || !CHEST_BLOCK_NAMES.includes(block.name)) {
      throw new Error(`Invalid chest at ${chestPos}`);
    }

    mfBot.pathfinder.setMovements(createMovements(mfBot));
    await new Promise((res, rej) => {
      mfBot.pathfinder.setGoal(new goals.GoalNear(chestPos.x, chestPos.y, chestPos.z, 3));
      mfBot.once('goal_reached', res);
      setTimeout(() => rej(new Error('timeout')), 15000);
    });

    type ChestWindow = { items(): any[]; deposit(type: number, meta: number | null, count: number): Promise<void>; close(): void };
    const chest = await (mfBot as any).openChest(block);
    try {
      const items = mfBot.inventory.items();
      for (const item of items) {
        if ((item.nbt?.value as any)?.Damage !== undefined) continue;
        await chest.deposit(item.type, item.metadata ?? null, item.count).catch(() => {});
      }
    } finally {
      chest.close();
    }
  }


  /**
   * Search for `itemName` across all nearby chests and withdraw up to `count` units.
   *
   * The `hintPos` parameter (previously ignored as `_chestPos`) is now used as a
   * priority hint: the hinted chest is checked first before the full distance-sorted
   * scan. This matters for the builder's withdrawLogs flow, where `hintPos` is the
   * dedicated input chest that miners deposit to — checking it first avoids unnecessary
   * navigation to other chests that won't have logs.
   *
   * Returns the number of items actually withdrawn.
   */
  async withdraw(domainBot: Bot, hintPos: Vec3, itemName: string, count: number): Promise<number> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return 0;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const itemDef = mcData.itemsByName[itemName] ?? mcData.blocksByName[itemName];
    if (!itemDef) {
      console.warn(`[Storage] ${domainBot.username}: item desconhecido "${itemName}"`);
      return 0;
    }

    const botPos = mfBot.entity.position;
    const allChests = await this.findChests(mfBot, botPos, mcData, 64);
    if (allChests.length === 0) {
      console.warn(`[Storage] ${domainBot.username}: nenhum baú encontrado para retirar "${itemName}"`);
      return 0;
    }

    // Put hintPos first so callers that know the exact source chest skip unnecessary travel.
    const hintKey = `${Math.floor(hintPos.x)},${Math.floor(hintPos.y)},${Math.floor(hintPos.z)}`;
    const chests = [
      ...allChests.filter(c => `${c.x},${c.y},${c.z}` === hintKey),
      ...allChests.filter(c => `${c.x},${c.y},${c.z}` !== hintKey),
    ];

    type Chest = {
      items(): Array<{ type: number; count: number; metadata: number }>;
      withdraw(type: number, meta: number | null, count: number): Promise<void>;
      close(): void;
    };

    let remaining = count;
    let totalWithdrawn = 0;

    for (const pos of chests) {
      if (remaining <= 0) break;

      const block = mfBot.blockAt(pos);
      if (!block || !CHEST_BLOCK_NAMES.includes(block.name)) continue;

      mfBot.pathfinder.setMovements(createMovements(mfBot));
      await new Promise<void>(res => {
        mfBot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
        mfBot.once('goal_reached', res);
        setTimeout(res, 15_000);
      });

      const freshBlock = mfBot.blockAt(pos);
      if (!freshBlock || !CHEST_BLOCK_NAMES.includes(freshBlock.name)) continue;

      let chest: Chest | null = null;
      try {
        chest = await (mfBot as unknown as { openChest(b: unknown): Promise<Chest> }).openChest(freshBlock);
        if (!chest) continue;

        const available = chest.items()
          .filter(i => i.type === itemDef.id)
          .reduce((sum, i) => sum + i.count, 0);

        if (available === 0) { chest.close(); chest = null; continue; }

        const toWithdraw = Math.min(remaining, available);
        await chest.withdraw(itemDef.id, null, toWithdraw);
        totalWithdrawn += toWithdraw;
        remaining -= toWithdraw;
        console.log(`[Storage] ${domainBot.username}: retirou ${toWithdraw}x "${itemName}" de (${pos.x},${pos.y},${pos.z}) [total=${totalWithdrawn}/${count}]`);
      } catch (err) {
        console.warn(`[Storage] ${domainBot.username}: falha ao retirar de (${pos.x},${pos.y},${pos.z}): ${err}`);
      } finally {
        chest?.close();
      }
    }

    if (totalWithdrawn === 0) {
      console.warn(`[Storage] ${domainBot.username}: "${itemName}" não encontrado em nenhum baú`);
    }
    return totalWithdrawn;
  }
}
