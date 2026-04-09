import { Bot as MineflayerBot } from 'mineflayer';
import { Entity } from 'prismarine-entity';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { MetaStore } from '../BotMeta';
import { createMovements } from '../physics/PhysicsPatch';
import { ts } from '../utils';
import { HOSTILE_MOBS, AERIAL_MOBS, CREEPER_FLEE_RADIUS } from './constants';

export class DefendBehavior {
  constructor(private readonly meta: MetaStore) {}

  /**
   * Background self-defense mode.
   *
   * Runs independently of the primary mode (does not change activeMode).
   * Priority order:
   *   1. Creeper within CREEPER_FLEE_RADIUS → flee
   *   2. Hostile mob within radius → chase + attack
   *   3. Nothing → leave pathfinder untouched
   *
   * When returning to idle, calls meta.resumeCallback() so async modes
   * (explore, farm) can restart their current leg immediately instead of
   * waiting for their 30-second timeout.
   */
  start(domainBot: Bot, radius: number): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.meta.get(domainBot);
    if (meta.defendListener) mfBot.removeListener('physicsTick', meta.defendListener);
    if ((meta as { _defendHurtListener?: () => void })._defendHurtListener) {
      (mfBot as NodeJS.EventEmitter).removeListener(
        'entityHurt',
        (meta as { _defendHurtListener?: () => void })._defendHurtListener!,
      );
    }

    type DefendState = 'idle' | 'fleeing' | 'attacking';
    let defendState: DefendState = 'idle';
    let lastThreatId: number | null = null;
    let scanTick = 0;
    let lastHurtTime = 0;
    const HURT_COOLDOWN_MS = 1000;

    // Maximum distance the bot will chase a mob from where combat started.
    const MAX_CHASE_DIST = 24;
    // Position recorded when the first mob is engaged in this combat episode.
    let combatOrigin: Vec3 | null = null;

    // React to damage — scan immediately with 2× radius to catch mobs that
    // back away after attacking before the regular 10-tick scan fires.
    const onHurt = (entity: Entity) => {
      if (!mfBot.entity || (entity as unknown as { id?: number }).id !== mfBot.entity.id) return;
      const now = Date.now();
      if (now - lastHurtTime < HURT_COOLDOWN_MS || defendState === 'attacking') {
        console.log(`[${ts()}][Defend] ${domainBot.username}: hurt suppressed (cooldown/state=${defendState})`);
        return;
      }
      lastHurtTime = now;

      // Inline scan with 2× radius so we catch retreat-attackers
      const extendedRadius = radius * 2;
      type AnyEntity = { type?: string; name?: string; position: Vec3; id: number };
      const nearbyMob = (Object.values(mfBot.entities) as AnyEntity[]).find(e =>
        e.name !== undefined &&
        HOSTILE_MOBS.has(e.name.toLowerCase()) &&
        e.position.distanceTo(mfBot.entity.position) < extendedRadius,
      );

      if (nearbyMob) {
        const prev = defendState;
        defendState = 'attacking';
        lastThreatId = nearbyMob.id;
        const dist = Math.floor(nearbyMob.position.distanceTo(mfBot.entity.position));
        console.warn(`[${ts()}][Defend] ${domainBot.username}: hurt→attacking "${nearbyMob.name}" dist=${dist}m (extended scan)`);
        if (!AERIAL_MOBS.has((nearbyMob.name ?? '').toLowerCase())) {
          mfBot.pathfinder.setMovements(createMovements(mfBot));
          mfBot.pathfinder.setGoal(new goals.GoalFollow(nearbyMob as unknown as Entity, 1), true);
        }
        void prev;
        return;
      }

      console.log(`[${ts()}][Defend] ${domainBot.username}: hurt → no mob in ${extendedRadius}m (environmental damage?)`);
      scanTick = 9; // still trigger a regular scan next tick
    };
    mfBot.on('entityHurt', onHurt);
    (meta as { _defendHurtListener?: (e: Entity) => void })._defendHurtListener = onHurt;

    // Clear stuck keys when pathfinder gives up
    const onDefendPathUpdate = (r: { status: string }) => {
      if (r.status === 'noPath') {
        console.warn(`[${ts()}][Defend] ${domainBot.username}: noPath (state=${defendState}) — clearing control states`);
        mfBot.clearControlStates();
      }
    };
    (mfBot as NodeJS.EventEmitter).on('path_update', onDefendPathUpdate);
    (meta as { _defendPathUpdateListener?: (r: { status: string }) => void })._defendPathUpdateListener = onDefendPathUpdate;

    const tick = (): void => {
      if (!mfBot.entity?.position) return;

      type AnyEntity = { type?: string; name?: string; position: Vec3; id: number };

      // Attack every tick while in combat
      if (defendState === 'attacking' && lastThreatId !== null) {
        const threat = mfBot.entities[lastThreatId] as AnyEntity | undefined;
        if (threat && threat.position.distanceTo(mfBot.entity.position) < 3.5) {
          mfBot.attack(threat as Parameters<MineflayerBot['attack']>[0]);
        }
      }

      // Entity scan every 10 ticks (2 Hz baseline)
      if (++scanTick % 10 !== 0) return;

      // Priority 1 — creeper
      const creeper = Object.values(mfBot.entities).find((e) => {
        const entity = e as AnyEntity;
        return entity.name === 'creeper' &&
          entity.position.distanceTo(mfBot.entity.position) < CREEPER_FLEE_RADIUS;
      }) as AnyEntity | undefined;

      if (creeper) {
        if (defendState !== 'fleeing' || lastThreatId !== creeper.id) {
          const prev = defendState;
          defendState = 'fleeing';
          lastThreatId = creeper.id;
          const dist = Math.floor(creeper.position.distanceTo(mfBot.entity.position));
          console.warn(`[${ts()}][Defend] ${domainBot.username}: ${prev}→fleeing creeper id=${creeper.id} dist=${dist}m`);
          const dx = mfBot.entity.position.x - creeper.position.x;
          const dz = mfBot.entity.position.z - creeper.position.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          const ft = mfBot.entity.position.plus(new Vec3((dx / len) * 20, 0, (dz / len) * 20));
          mfBot.pathfinder.setMovements(createMovements(mfBot));
          mfBot.pathfinder.setGoal(new goals.GoalNear(Math.floor(ft.x), Math.floor(mfBot.entity.position.y), Math.floor(ft.z), 3));
        }
        return;
      }

      if (defendState === 'fleeing') {
        defendState = 'idle';
        lastThreatId = null;
        mfBot.pathfinder.stop();
        console.log(`[${ts()}][Defend] ${domainBot.username}: fleeing→idle (creeper gone)`);
      }

      // Priority 2 — hostile mobs
      const allMobs = Object.values(mfBot.entities).filter((e) => {
        const entity = e as AnyEntity;
        return entity.name !== undefined &&
          HOSTILE_MOBS.has(entity.name.toLowerCase()) &&
          entity.position.distanceTo(mfBot.entity.position) < radius;
      }) as AnyEntity[];

      // Opportunity swing: hit aerial mobs that swoop within melee range
      for (const e of allMobs) {
        if (!AERIAL_MOBS.has((e.name ?? '').toLowerCase())) continue;
        if (e.position.distanceTo(mfBot.entity.position) < 3.5) {
          mfBot.attack(e as Parameters<MineflayerBot['attack']>[0]);
        }
      }

      const currentMobStillValid = lastThreatId !== null && allMobs.some(e => e.id === lastThreatId);
      const groundMob = allMobs.find(e => !AERIAL_MOBS.has((e.name ?? '').toLowerCase()));
      const primaryMob = currentMobStillValid
        ? allMobs.find(e => e.id === lastThreatId)!
        : (groundMob ?? allMobs[0]);

      // Disengage if the bot has chased the mob too far from where combat started
      if (defendState === 'attacking' && combatOrigin) {
        const drift = mfBot.entity.position.distanceTo(combatOrigin);
        if (drift > MAX_CHASE_DIST) {
          console.warn(`[${ts()}][Defend] ${domainBot.username}: drifted ${Math.floor(drift)}m from origin — disengaging`);
          lastThreatId = null;
          combatOrigin = null;
          defendState = 'idle';
          mfBot.physicsEnabled = true;
          mfBot.pathfinder.stop();
          mfBot.clearControlStates();
          meta.resumeCallback?.();
          return;
        }
      }

      if (primaryMob) {
        if (defendState !== 'attacking' || lastThreatId !== primaryMob.id) {
          const prev = defendState;
          // Record origin only on the first transition into combat
          if (prev !== 'attacking') combatOrigin = mfBot.entity.position.clone();
          defendState = 'attacking';
          lastThreatId = primaryMob.id;
          const isAerial = AERIAL_MOBS.has((primaryMob.name ?? '').toLowerCase());
          if (isAerial) {
            mfBot.pathfinder.stop();
            mfBot.clearControlStates();
            console.log(`[${ts()}][Defend] ${domainBot.username}: ${prev}→attacking aerial "${primaryMob.name}" — holding ground`);
          } else {
            mfBot.pathfinder.setMovements(createMovements(mfBot));
            mfBot.pathfinder.setGoal(new goals.GoalFollow(primaryMob as unknown as Entity, 1), true);
            const aerialCount = allMobs.filter(e => AERIAL_MOBS.has((e.name ?? '').toLowerCase())).length;
            const extra = aerialCount > 0 ? ` (+${aerialCount} aerial)` : '';
            console.log(`[${ts()}][Defend] ${domainBot.username}: ${prev}→attacking "${primaryMob.name ?? primaryMob.id}" dist=${Math.floor(primaryMob.position.distanceTo(mfBot.entity.position))}m${extra}`);
          }
        }
      } else if (defendState === 'attacking') {
        const deadStillInEntities = lastThreatId !== null && !!mfBot.entities[lastThreatId];
        combatOrigin = null;
        defendState = 'idle';
        mfBot.physicsEnabled = true;
        mfBot.pathfinder.stop();
        mfBot.clearControlStates();
        console.log(`[${ts()}][Defend] ${domainBot.username}: attacking→idle (all mobs gone, entity still in world=${deadStillInEntities})`);
        meta.resumeCallback?.();
      }
    };

    mfBot.on('physicsTick', tick);
    meta.defendListener = tick;
    console.log(`[MineflayerAdapter] ${domainBot.username}: defend mode ON (radius=${radius})`);
  }

  stop(domainBot: Bot): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const meta = this.meta.get(domainBot);
    if (meta.defendListener) {
      mfBot.removeListener('physicsTick', meta.defendListener);
      delete meta.defendListener;
    }
    const hurtListener = (meta as { _defendHurtListener?: () => void })._defendHurtListener;
    if (hurtListener) {
      (mfBot as NodeJS.EventEmitter).removeListener('entityHurt', hurtListener);
      delete (meta as { _defendHurtListener?: () => void })._defendHurtListener;
    }
    const pathUpdateListener = (meta as { _defendPathUpdateListener?: () => void })._defendPathUpdateListener;
    if (pathUpdateListener) {
      (mfBot as NodeJS.EventEmitter).removeListener('path_update', pathUpdateListener);
      delete (meta as { _defendPathUpdateListener?: () => void })._defendPathUpdateListener;
    }
    console.log(`[MineflayerAdapter] ${domainBot.username}: defend mode OFF`);
  }
}
