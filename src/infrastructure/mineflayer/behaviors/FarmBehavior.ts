import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { MetaStore } from '../BotMeta';
import { createMovements } from '../physics/PhysicsPatch';
import { sleep } from '../utils';

// Fully-grown age per crop type
const CROP_MAX_AGE: Record<string, number> = {
  wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3,
};

// Seed item name per crop block name
const CROP_SEED: Record<string, string> = {
  wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato',
  beetroots: 'beetroot_seeds', nether_wart: 'nether_wart',
};

export class FarmBehavior {
  constructor(private readonly meta: MetaStore) {}

  async farm(domainBot: Bot, centerX: number, centerZ: number, radius: number): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const meta = this.meta.get(domainBot);
    meta.farmingActive = true;
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    domainBot.setState(BotState.MOVING);

    console.log(`[Farm] ${domainBot.username}: farming r=${radius} around (${centerX},${centerZ})`);

    while (meta.farmingActive && domainBot.isOnline()) {
      let harvested = 0;

      for (const [cropName, maxAge] of Object.entries(CROP_MAX_AGE)) {
        const blockDef = mcData.blocksByName[cropName];
        if (!blockDef) continue;

        while (meta.farmingActive) {
          const block = mfBot.findBlock({
            matching: (b) =>
              b.type === blockDef.id &&
              b.metadata === maxAge &&
              Math.abs(b.position.x - centerX) <= radius &&
              Math.abs(b.position.z - centerZ) <= radius,
            maxDistance: radius * 2 + 10,
          });
          if (!block) break;

          await new Promise<void>((res) => {
            mfBot.pathfinder.setGoal(
              new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z),
            );
            mfBot.once('goal_reached', res);
            setTimeout(res, 6000);
          });

          try {
            await mfBot.dig(block);
            harvested++;
            console.log(`[Farm] ${domainBot.username}: harvested ${cropName}`);

            // Replant: equip seed and place on farmland below
            const seedName = CROP_SEED[cropName];
            const seedDef = mcData.itemsByName[seedName];
            if (seedDef) {
              const seedItem = (mfBot.inventory.items() as Array<{ type: number }>)
                .find(i => i.type === seedDef.id);
              if (seedItem) {
                await mfBot.equip(seedItem as Parameters<MineflayerBot['equip']>[0], 'hand');
                const farmland = mfBot.blockAt(block.position.offset(0, -1, 0));
                if (farmland && (farmland.name === 'farmland' || farmland.name === 'soul_sand')) {
                  try {
                    await mfBot.placeBlock(farmland, new Vec3(0, 1, 0));
                    console.log(`[Farm] ${domainBot.username}: replanted ${cropName}`);
                  } catch { /* couldn't replant */ }
                }
              }
            }
          } catch { /* crop already gone */ }
        }
      }

      if (harvested === 0) {
        // Nothing ripe — wait before next scan
        await sleep(15000);
      }
    }

    domainBot.setState(BotState.CONNECTED);
  }

  stopFarm(domainBot: Bot): void {
    const meta = this.meta.get(domainBot);
    meta.farmingActive = false;
  }
}
