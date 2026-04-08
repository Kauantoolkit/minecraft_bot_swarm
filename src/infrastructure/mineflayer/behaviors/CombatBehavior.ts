import { Bot as MineflayerBot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { SwarmIntel } from '../../../application/SwarmIntel';
import { PlayerRelationshipStore } from '../../../domain/value-objects/PlayerRelationship';
import { MetaStore } from '../BotMeta';
import { createMovements } from '../physics/PhysicsPatch';

export class CombatBehavior {
  constructor(private readonly meta: MetaStore) {}

  /** Single melee hit — one-shot, no loop. */
  attack(domainBot: Bot, targetUsername: string): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const entity = mfBot.players[targetUsername]?.entity;
    if (entity) mfBot.attack(entity);
  }

  /**
   * Continuous PvP mode — chases and attacks targets.
   * Uses pvpListener slot (shared with follow; last writer wins).
   */
  pvp(
    domainBot: Bot,
    targetUsernames: string[],
    intel?: SwarmIntel,
    relations?: PlayerRelationshipStore,
  ): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.meta.get(domainBot);
    if (meta.pvpListener) mfBot.removeListener('physicsTick', meta.pvpListener);

    mfBot.pathfinder.setMovements(createMovements(mfBot));

    let currentTargetName: string | null = null;
    let headingToLastKnown = false;

    meta.activeMode = `pvp:[${targetUsernames.join(',')}]`;

    const tick = (): void => {
      if (!mfBot.entity?.position) return;

      // Find a visible target — skip friends
      let found: { username: string; entity: MineflayerBot['entity'] } | null = null;
      for (const username of targetUsernames) {
        if (relations?.getRelationship(username) === 'friend') continue;
        const entity = mfBot.players[username]?.entity;
        if (entity) { found = { username, entity }; break; }
      }

      if (found) {
        headingToLastKnown = false;

        // Report sighting to intel bus so other bots can converge
        if (intel) intel.report(domainBot.username, found.username, found.entity.position);

        // Update goal only when target changes
        if (found.username !== currentTargetName) {
          currentTargetName = found.username;
          mfBot.pathfinder.setGoal(new goals.GoalFollow(found.entity, 1), true);
        }

        if (found.entity.position.distanceTo(mfBot.entity.position) < 3.5) {
          mfBot.attack(found.entity);
        }
        return;
      }

      // Target not visible — navigate to last known position from intel
      if (intel && !headingToLastKnown) {
        for (const username of targetUsernames) {
          const sighting = intel.getLastSighting(username);
          if (!sighting || sighting.spottedBy === domainBot.username) continue;
          headingToLastKnown = true;
          currentTargetName = null;
          const p = sighting.position;
          mfBot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 5));
          console.log(
            `[Intel] ${domainBot.username}: heading to last known pos of ${username} ` +
            `(spotted by ${sighting.spottedBy})`,
          );
          break;
        }
      }

      // Nothing to do — stop if we were previously chasing
      if (!headingToLastKnown && currentTargetName !== null) {
        currentTargetName = null;
        mfBot.pathfinder.stop();
      }
    };

    mfBot.on('physicsTick', tick);
    meta.pvpListener = tick;
    domainBot.setState(BotState.MOVING);
  }

  /**
   * Stops pvp and follow (both share pvpListener slot).
   */
  stopPvp(domainBot: Bot): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const meta = this.meta.get(domainBot);
    if (meta.pvpListener) {
      mfBot.removeListener('physicsTick', meta.pvpListener);
      delete meta.pvpListener;
    }
    if (meta.followPathUpdateListener) {
      (mfBot as NodeJS.EventEmitter).removeListener('path_update', meta.followPathUpdateListener);
      delete meta.followPathUpdateListener;
    }
  }
}
