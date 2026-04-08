import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { MetaStore } from '../BotMeta';
import { createMovements } from '../physics/PhysicsPatch';

const STEP = 200; // blocks per leg

const DIRECTION_VEC: Record<string, Vec3> = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0,  1),
  east:  new Vec3( 1, 0, 0),
  west:  new Vec3(-1, 0, 0),
};

export class ExploreBehavior {
  constructor(private readonly meta: MetaStore) {}

  async explore(domainBot: Bot, direction: 'north' | 'south' | 'east' | 'west' | 'auto'): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.meta.get(domainBot);
    meta.exploringActive = true;
    mfBot.pathfinder.setMovements(createMovements(mfBot));
    domainBot.setState(BotState.MOVING);

    console.log(`[Explore] ${domainBot.username}: heading ${direction}`);

    while (meta.exploringActive && domainBot.isOnline()) {
      let dir: Vec3;

      if (direction === 'auto') {
        // Walk toward lowest-chunk-load quadrant (simple: random cardinal)
        const dirs = Object.values(DIRECTION_VEC);
        dir = dirs[Math.floor(Math.random() * dirs.length)];
      } else {
        dir = DIRECTION_VEC[direction];
      }

      const target = mfBot.entity.position.plus(dir.scaled(STEP));

      await new Promise<void>((res) => {
        let settled = false;
        const settle = () => {
          if (!settled) {
            settled = true;
            clearTimeout(legTimer);
            mfBot.off('goal_reached', settle);
            delete meta.resumeCallback;
            res();
          }
        };
        meta.resumeCallback = settle;
        // GoalXZ navigates to X,Z regardless of terrain height — avoids bots
        // getting stuck trying to reach an exact Y that doesn't exist in the terrain
        mfBot.pathfinder.setGoal(
          new goals.GoalXZ(Math.floor(target.x), Math.floor(target.z)),
        );
        mfBot.once('goal_reached', settle);
        const legTimer = setTimeout(() => { mfBot.pathfinder.stop(); settle(); }, 30000); // 30 s timeout per leg
      });
    }

    domainBot.setState(BotState.CONNECTED);
  }

  stopExplore(domainBot: Bot): void {
    const meta = this.meta.get(domainBot);
    meta.exploringActive = false;
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (mfBot) mfBot.pathfinder.stop();
  }
}
