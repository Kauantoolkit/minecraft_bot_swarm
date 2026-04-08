import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { MetaStore } from '../BotMeta';
import { createMovements } from '../physics/PhysicsPatch';

export class AvoidBehavior {
  constructor(private readonly meta: MetaStore) {}

  avoid(domainBot: Bot, targetUsernames: string[], triggerRadius: number): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.meta.get(domainBot);
    if (meta.avoidListener) mfBot.removeListener('physicsTick', meta.avoidListener);

    mfBot.pathfinder.setMovements(createMovements(mfBot));

    let avoiding = false;
    let scanTick = 0;

    // Scan every 10 ticks (2 Hz) — only update goal when state changes
    const tick = (): void => {
      if (++scanTick % 10 !== 0) return;

      let threat: MineflayerBot['entity'] | null = null;
      for (const username of targetUsernames) {
        const entity = mfBot.players[username]?.entity;
        if (entity && entity.position.distanceTo(mfBot.entity.position) < triggerRadius) {
          threat = entity;
          break;
        }
      }

      if (threat && !avoiding) {
        avoiding = true;
        const away = mfBot.entity.position.minus(threat.position).normalize().scaled(30);
        const ft = mfBot.entity.position.plus(away);
        mfBot.pathfinder.setGoal(new goals.GoalBlock(Math.floor(ft.x), Math.floor(ft.y), Math.floor(ft.z)));
      } else if (!threat && avoiding) {
        avoiding = false;
        mfBot.pathfinder.stop();
      }
    };

    mfBot.on('physicsTick', tick);
    meta.avoidListener = tick;
    domainBot.setState(BotState.MOVING);
    console.log(`[MineflayerAdapter] ${domainBot.username}: avoiding [${targetUsernames.join(', ')}]`);
  }

  stopAvoid(domainBot: Bot): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const meta = this.meta.get(domainBot);
    if (meta.avoidListener) {
      mfBot.removeListener('physicsTick', meta.avoidListener);
      delete meta.avoidListener;
    }
  }
}
