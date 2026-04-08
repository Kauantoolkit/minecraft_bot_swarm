import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { BuildQueue } from '../../schematic/BuildQueue';
import { createMovements } from '../physics/PhysicsPatch';

export class BuildBehavior {
  /**
   * Pulls tasks from the shared BuildQueue and places blocks.
   *
   * If the required block is missing from inventory, the task is deferred
   * back to the queue so another bot (or a future restock) can handle it.
   * Up to 5 passes are run by the caller (SwarmController).
   */
  async buildFromQueue(domainBot: Bot, queue: BuildQueue): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    domainBot.setState(BotState.MOVING);

    while (!queue.isEmpty()) {
      const task = queue.next();
      if (!task) break;

      const { x, y, z, blockName } = task;
      const shortName = blockName.includes(':') ? blockName.split(':')[1] : blockName;
      const itemDef = mcData.itemsByName[shortName] ?? mcData.blocksByName[shortName];

      if (!itemDef) continue; // unknown block — skip permanently

      const item = (mfBot.inventory.items() as Array<{ type: number }>)
        .find(i => i.type === itemDef.id);

      if (!item) {
        queue.deferTask(task, shortName);
        continue;
      }

      await mfBot.equip(item as Parameters<MineflayerBot['equip']>[0], 'hand');

      await new Promise<void>((res) => {
        mfBot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 4));
        mfBot.once('goal_reached', res);
        setTimeout(res, 6000);
      });

      // Try each face until placement succeeds
      const faceVectors = [
        new Vec3(0, -1, 0), new Vec3(0, 1, 0),
        new Vec3(-1, 0, 0), new Vec3(1, 0, 0),
        new Vec3(0, 0, -1), new Vec3(0, 0, 1),
      ];

      for (const face of faceVectors) {
        const refPos = new Vec3(x, y, z).plus(face);
        const refBlock = mfBot.blockAt(refPos);
        if (refBlock && refBlock.name !== 'air') {
          try {
            await mfBot.placeBlock(refBlock, face.scaled(-1));
            console.log(`[Build] ${domainBot.username}: placed ${shortName} @ ${x},${y},${z} [${queue.progress}]`);
            break;
          } catch { continue; }
        }
      }
    }

    domainBot.setState(BotState.CONNECTED);
  }
}
