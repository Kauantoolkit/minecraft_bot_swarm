import { Bot as MineflayerBot } from 'mineflayer';
import { Entity } from 'prismarine-entity';
import { goals } from 'mineflayer-pathfinder';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { MetaStore } from '../BotMeta';
import { createMovements } from '../physics/PhysicsPatch';
import { ts } from '../utils';

export class MovementBehavior {
  constructor(private readonly meta: MetaStore) {}

  async moveTo(domainBot: Bot, x: number, y: number, z: number): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    mfBot.pathfinder.stop();
    mfBot.pathfinder.setMovements(createMovements(mfBot));

    domainBot.setState(BotState.MOVING);
    console.log(`[Move] ${domainBot.username} → (${x}, ${y}, ${z})`);
    try {
      await new Promise<void>((resolve, reject) => {
        mfBot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 2));
        const onReached = () => { cleanup(); resolve(); };
        const onNoPath = (r: { status: string }) => {
          if (r.status === 'noPath') { cleanup(); reject(new Error('noPath')); }
        };
        const onStopped = () => { cleanup(); resolve(); };
        const cleanup = () => {
          mfBot.removeListener('goal_reached', onReached);
          (mfBot as NodeJS.EventEmitter).removeListener('path_update', onNoPath);
          (mfBot as NodeJS.EventEmitter).removeListener('path_stop', onStopped);
        };
        mfBot.once('goal_reached', onReached);
        (mfBot as NodeJS.EventEmitter).on('path_update', onNoPath);
        (mfBot as NodeJS.EventEmitter).once('path_stop', onStopped);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${domainBot.username}: move failed — ${msg}`);
    } finally {
      domainBot.setState(BotState.CONNECTED);
    }
  }

  /**
   * Follows a player indefinitely.
   *
   * Internally stores its tick in meta.pvpListener (shared slot with pvp).
   * Starting pvp() after follow() will silently replace this listener.
   * stopPvp() / stop() cleans up both.
   */
  follow(domainBot: Bot, targetUsername: string): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.meta.get(domainBot);
    if (meta.pvpListener) mfBot.removeListener('physicsTick', meta.pvpListener);

    mfBot.pathfinder.setMovements(createMovements(mfBot));

    let currentEntityRef: Entity | null = null;
    let noPathRetry = 0;
    let scanTick = 0;
    let wasVisible = false;

    const setFollowGoal = (entity: Entity) => {
      currentEntityRef = entity;
      noPathRetry = 0;
      mfBot.pathfinder.setMovements(createMovements(mfBot));
      mfBot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
      console.log(`[${ts()}][Follow] ${domainBot.username}: GoalFollow(${targetUsername}) issued`);
    };

    const onPathUpdate = (r: { status: string }) => {
      if (r.status === 'noPath') {
        if (++noPathRetry <= 5) {
          const delay = 3000 * noPathRetry;
          console.warn(`[${ts()}][Follow] ${domainBot.username}: noPath → retry ${noPathRetry}/5 in ${delay / 1000}s`);
          setTimeout(() => {
            const entity = mfBot.players[targetUsername]?.entity;
            if (entity) {
              console.log(`[${ts()}][Follow] ${domainBot.username}: retrying GoalFollow after noPath`);
              setFollowGoal(entity);
            } else {
              console.warn(`[${ts()}][Follow] ${domainBot.username}: retry ${noPathRetry} — target still not visible`);
            }
          }, delay);
        } else {
          console.error(`[${ts()}][Follow] ${domainBot.username}: noPath — max retries reached, giving up`);
        }
      } else if (r.status !== 'success' && r.status !== 'partialSuccess') {
        console.log(`[${ts()}][Follow] ${domainBot.username}: path_update status=${r.status}`);
      }
    };
    (mfBot as NodeJS.EventEmitter).on('path_update', onPathUpdate);
    meta.followPathUpdateListener = onPathUpdate;

    mfBot.on('goal_reached', () =>
      console.log(`[${ts()}][Follow] ${domainBot.username}: goal_reached (within 2 of ${targetUsername})`));
    mfBot.on('path_stop', () =>
      console.log(`[${ts()}][Follow] ${domainBot.username}: path_stop event fired`));

    const tick = (): void => {
      if (++scanTick % 10 !== 0) return; // check at 2 Hz

      const entity = mfBot.players[targetUsername]?.entity;
      if (!entity) {
        if (wasVisible) {
          wasVisible = false;
          console.warn(`[${ts()}][Follow] ${domainBot.username}: "${targetUsername}" left render range — waiting`);
        }
        return;
      }

      if (!wasVisible) {
        wasVisible = true;
        console.log(`[${ts()}][Follow] ${domainBot.username}: "${targetUsername}" came into range`);
      }

      if (entity !== currentEntityRef) {
        console.log(`[${ts()}][Follow] ${domainBot.username}: entity ref changed (teleport/respawn?) → re-issuing goal`);
        setFollowGoal(entity);
      }
    };

    mfBot.on('physicsTick', tick);
    meta.pvpListener = tick;

    domainBot.setState(BotState.MOVING);
    console.log(`[${ts()}][Follow] ${domainBot.username}: starting follow of "${targetUsername}"`);

    const entity = mfBot.players[targetUsername]?.entity;
    if (entity) {
      wasVisible = true;
      setFollowGoal(entity);
    } else {
      console.warn(`[${ts()}][Follow] ${domainBot.username}: "${targetUsername}" not visible yet — will engage on first sight`);
    }
  }
}
