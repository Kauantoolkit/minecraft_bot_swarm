import { Bot as MineflayerBot } from 'mineflayer';
import { Entity } from 'prismarine-entity';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
import { BotState } from '../../../domain/value-objects/BotState';
import { SwarmIntel } from '../../../application/SwarmIntel';
import { PlayerRelationshipStore } from '../../../domain/value-objects/PlayerRelationship';
import { MetaStore } from '../BotMeta';
import { createMovements } from '../physics/PhysicsPatch';
import { ts } from '../utils';
import { HOSTILE_MOBS, AERIAL_MOBS } from './constants';

export class GuardBehavior {
  constructor(private readonly meta: MetaStore) {}

  // ─── Guard position ────────────────────────────────────────────────────────

  guard(
    domainBot: Bot,
    x: number,
    y: number,
    z: number,
    radius: number,
    excludeUsernames: string[],
    relations?: PlayerRelationshipStore,
  ): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.meta.get(domainBot);
    if (meta.guardListener) mfBot.removeListener('physicsTick', meta.guardListener);

    mfBot.pathfinder.setMovements(createMovements(mfBot));
    mfBot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));

    const guardPos = new Vec3(x, y, z);
    type GuardState = 'moving-to-post' | 'idle' | 'chasing';
    let guardState: GuardState = 'moving-to-post';
    let lastIntruderId: number | null = null;
    let scanTick = 0;

    meta.activeMode = `guard:(${x},${y},${z})`;

    const tick = (): void => {
      if (!mfBot.entity?.position) return;
      type AnyEntity = MineflayerBot['entity'] & { username?: string; type?: string };

      // Attack is cheap — check every tick when chasing
      if (guardState === 'chasing' && lastIntruderId !== null) {
        const e = mfBot.entities[lastIntruderId] as AnyEntity | undefined;
        if (e && e.position.distanceTo(mfBot.entity.position) < 3.5) mfBot.attack(e);
      }

      // Scan for threats every 10 ticks (2 Hz) — entity scan is expensive
      if (++scanTick % 10 !== 0) return;

      const intruder = Object.values(mfBot.entities).find((e) => {
        const entity = e as AnyEntity;
        if (!entity.username || entity.username === mfBot.username) return false;
        if (excludeUsernames.includes(entity.username)) return false;
        if (entity.position.distanceTo(guardPos) >= radius) return false;
        if (!relations) return true;
        const heldItem = (e as unknown as { equipment?: Array<{ name?: string } | null> })
          .equipment?.[0]?.name;
        return relations.shouldAttackPlayer(entity.username, heldItem);
      }) as AnyEntity | undefined;

      if (intruder) {
        if (guardState !== 'chasing' || intruder.id !== lastIntruderId) {
          guardState = 'chasing';
          lastIntruderId = intruder.id;
          mfBot.pathfinder.setGoal(new goals.GoalFollow(intruder, 1), true);
        }
      } else {
        if (guardState === 'chasing') {
          lastIntruderId = null;
          if (mfBot.entity.position.distanceTo(guardPos) > 3) {
            guardState = 'moving-to-post';
            mfBot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
          } else {
            guardState = 'idle';
            mfBot.pathfinder.stop();
          }
        }
        // guardState === 'moving-to-post': nothing to do, goal_reached handles it
      }
    };

    mfBot.on('physicsTick', tick);
    meta.guardListener = tick;
    domainBot.setState(BotState.MOVING);
  }

  // ─── Bodyguard ─────────────────────────────────────────────────────────────
  //
  // Follows a protected player and attacks mobs/hostile players within radius.

  bodyguard(
    domainBot: Bot,
    protectedUsername: string,
    radius: number,
    swarmUsernames: string[],
    relations?: PlayerRelationshipStore,
    intel?: SwarmIntel,
  ): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // A bot cannot bodyguard itself — following own entity produces NaN positions
    if (domainBot.username === protectedUsername) {
      console.warn(`[Bodyguard] ${domainBot.username}: cannot bodyguard itself — skipping`);
      return;
    }

    const meta = this.meta.get(domainBot);
    if (meta.guardListener) mfBot.removeListener('physicsTick', meta.guardListener);
    const oldHurt = (meta as { _bgHurtListener?: () => void })._bgHurtListener;
    if (oldHurt) (mfBot as NodeJS.EventEmitter).removeListener('entityHurt', oldHurt);

    mfBot.pathfinder.setMovements(createMovements(mfBot));

    type BodyguardState = 'following' | 'heading-to-intel' | 'waiting' | 'attacking';
    let bgState: BodyguardState = 'following';
    let lastThreatId: number | null = null;
    let scanTick = 0;
    let currentFollowEntity: Entity | null = null;

    const setFollowWard = (ward: Entity) => {
      if (isNaN(ward.position.x) || isNaN(ward.position.z)) {
        console.warn(`[${ts()}][Bodyguard] ${domainBot.username}: ward has NaN position — skipping GoalFollow`);
        return;
      }
      intel?.report(domainBot.username, protectedUsername, ward.position);
      if (ward === currentFollowEntity && bgState === 'following') return;

      const reason = currentFollowEntity === null ? 'previously null' : 'entity ref changed';
      console.log(`[${ts()}][Bodyguard] ${domainBot.username}: setFollowWard → GoalFollow (${reason}), stop+setGoal`);
      currentFollowEntity = ward;
      bgState = 'following';
      // Ensure physics are enabled before stopping — the pathfinder can leave
      // physicsEnabled=false mid-path, which freezes the bot in place on stop()
      mfBot.physicsEnabled = true;
      mfBot.pathfinder.stop();
      mfBot.clearControlStates();
      mfBot.pathfinder.setMovements(createMovements(mfBot));
      mfBot.pathfinder.setGoal(new goals.GoalFollow(ward, 2), true);
    };

    // path_update diagnostics — bodyguard needs to know when paths fail
    const onPathUpdate = (r: { status: string }) => {
      if (r.status === 'noPath') {
        console.warn(`[${ts()}][Bodyguard] ${domainBot.username}: noPath — state=${bgState} ward=${mfBot.players[protectedUsername]?.entity ? 'visible' : 'NOT_VISIBLE'}`);
        mfBot.clearControlStates();
      } else if (r.status !== 'success' && r.status !== 'partial') {
        console.log(`[${ts()}][Bodyguard] ${domainBot.username}: path_update status=${r.status} state=${bgState}`);
      }
    };
    (mfBot as NodeJS.EventEmitter).on('path_update', onPathUpdate);
    (meta as { _bgPathUpdateListener?: (r: { status: string }) => void })._bgPathUpdateListener = onPathUpdate;

    // Start following if already in range, otherwise use intel or wait
    const ward0 = mfBot.players[protectedUsername]?.entity;
    if (ward0) {
      setFollowWard(ward0);
    } else {
      const sighting = intel?.getLastSighting(protectedUsername);
      if (sighting) {
        bgState = 'heading-to-intel';
        mfBot.pathfinder.setGoal(new goals.GoalNear(sighting.position.x, sighting.position.y, sighting.position.z, 5));
        console.log(`[${ts()}][Bodyguard] ${domainBot.username}: "${protectedUsername}" not visible → heading to last known pos`);
      } else {
        bgState = 'waiting';
        console.warn(`[${ts()}][Bodyguard] ${domainBot.username}: "${protectedUsername}" not visible, no intel → waiting`);
      }
    }

    let heartbeatTick = 0;
    let lastWardVisible = !!ward0;

    const tick = (): void => {
      if (!mfBot.entity?.position) return;

      type AnyEntity = MineflayerBot['entity'] & { username?: string; type?: string; name?: string };

      // Melee attack every tick while in combat
      if (bgState === 'attacking' && lastThreatId !== null) {
        const t = mfBot.entities[lastThreatId] as AnyEntity | undefined;
        if (t && t.position.distanceTo(mfBot.entity.position) < 4.0) mfBot.attack(t);
      }

      if (++scanTick % 5 !== 0) return;

      const ward = mfBot.players[protectedUsername]?.entity;
      const wardVisible = !!ward;

      if (wardVisible !== lastWardVisible) {
        lastWardVisible = wardVisible;
        if (wardVisible) {
          console.log(`[${ts()}][Bodyguard] ${domainBot.username}: "${protectedUsername}" came into range (was ${bgState})`);
        } else {
          console.warn(`[${ts()}][Bodyguard] ${domainBot.username}: "${protectedUsername}" left render range (state=${bgState})`);
        }
      }

      // Periodic heartbeat ~every 5 seconds
      if (++heartbeatTick % 50 === 0) {
        const wardDist = ward ? Math.floor(ward.position.distanceTo(mfBot.entity.position)) : -1;
        const pos = mfBot.entity.position;
        let nearBot = 0, nearWard = 0;
        for (const e of Object.values(mfBot.entities)) {
          const en = e as AnyEntity;
          if (!en.name || !HOSTILE_MOBS.has(en.name.toLowerCase())) continue;
          if (ward && en.position.distanceTo(ward.position) < radius) nearWard++;
          else if (en.position.distanceTo(pos) < radius) nearBot++;
        }
        console.log(`[${ts()}][Bodyguard] ${domainBot.username}: ♥ state=${bgState} ward=${wardVisible ? `dist=${wardDist}` : 'NOT_VISIBLE'} threats(nearWard=${nearWard} nearBot=${nearBot})`);
      }

      if (!ward) {
        if (bgState !== 'heading-to-intel') {
          const sighting = intel?.getLastSighting(protectedUsername);
          if (sighting) {
            const prev = bgState;
            bgState = 'heading-to-intel';
            lastThreatId = null;
            currentFollowEntity = null;
            mfBot.pathfinder.setGoal(new goals.GoalNear(sighting.position.x, sighting.position.y, sighting.position.z, 5));
            console.log(`[${ts()}][Bodyguard] ${domainBot.username}: ${prev}→heading-to-intel @ (${Math.floor(sighting.position.x)},${Math.floor(sighting.position.y)},${Math.floor(sighting.position.z)}) age=${Math.floor((Date.now() - sighting.timestamp) / 1000)}s`);
          } else if (bgState !== 'waiting') {
            const prev = bgState;
            bgState = 'waiting';
            lastThreatId = null;
            currentFollowEntity = null;
            mfBot.pathfinder.stop();
            console.warn(`[${ts()}][Bodyguard] ${domainBot.username}: ${prev}→waiting (ward gone, no intel)`);
          }
        }
        return;
      }

      intel?.report(domainBot.username, protectedUsername, ward.position);
      if (bgState !== 'attacking') setFollowWard(ward);

      const botPos = mfBot.entity.position;
      const allThreats = Object.values(mfBot.entities).filter((e) => {
        const entity = e as AnyEntity;
        if (!mfBot.entity?.position) return false;
        const nearWard = entity.position.distanceTo(ward.position) < radius;
        const nearBot  = entity.position.distanceTo(botPos) < radius;
        if (!nearWard && !nearBot) return false;
        if (HOSTILE_MOBS.has((entity.name ?? '').toLowerCase())) return true;
        if (entity.username) {
          if (entity.username === mfBot.username) return false;
          if (entity.username === protectedUsername) return false;
          if (swarmUsernames.includes(entity.username)) return false;
          if (relations) {
            const heldItem = (e as unknown as { equipment?: Array<{ name?: string } | null> })
              .equipment?.[0]?.name;
            return relations.shouldAttackPlayer(entity.username, heldItem);
          }
          return false;
        }
        return false;
      }) as AnyEntity[];

      // Sticky targeting: keep current target as long as it's alive and in range
      const currentTargetStillValid = lastThreatId !== null && allThreats.some(e => e.id === lastThreatId);
      const groundThreat = allThreats.find(e => !AERIAL_MOBS.has((e.name ?? '').toLowerCase()));
      const primaryThreat = currentTargetStillValid
        ? allThreats.find(e => e.id === lastThreatId)!
        : (groundThreat ?? allThreats[0]);

      // Opportunity swing: hit any aerial mob that swoops within melee range
      if (mfBot.entity?.position) {
        for (const e of allThreats) {
          if (!AERIAL_MOBS.has((e.name ?? '').toLowerCase())) continue;
          if (e.position.distanceTo(mfBot.entity.position) < 3.5) {
            mfBot.attack(e as Parameters<MineflayerBot['attack']>[0]);
          }
        }
      }

      if (primaryThreat) {
        const isAerial = AERIAL_MOBS.has((primaryThreat.name ?? '').toLowerCase());
        if (bgState !== 'attacking' || lastThreatId !== primaryThreat.id) {
          const prev = bgState;
          bgState = 'attacking';
          lastThreatId = primaryThreat.id;
          if (isAerial) {
            mfBot.pathfinder.setMovements(createMovements(mfBot));
            mfBot.pathfinder.setGoal(new goals.GoalFollow(ward, 2), true);
            console.log(`[${ts()}][Bodyguard] ${domainBot.username}: ${prev}→attacking aerial "${primaryThreat.name}" — following ward, melee-only on swoop`);
          } else {
            mfBot.pathfinder.setGoal(new goals.GoalFollow(primaryThreat, 1), true);
            const aerialCount = allThreats.filter(e => AERIAL_MOBS.has((e.name ?? '').toLowerCase())).length;
            const extra = aerialCount > 0 ? ` (+${aerialCount} aerial)` : '';
            console.log(`[${ts()}][Bodyguard] ${domainBot.username}: ${prev}→attacking "${primaryThreat.name ?? primaryThreat.username ?? primaryThreat.id}" dist=${Math.floor(primaryThreat.position.distanceTo(ward.position))}m${extra}`);
          }
        }
      } else if (bgState === 'attacking') {
        lastThreatId = null;
        bgState = 'following';
        currentFollowEntity = null;
        mfBot.physicsEnabled = true;
        mfBot.pathfinder.stop();
        mfBot.clearControlStates();
        console.log(`[${ts()}][Bodyguard] ${domainBot.username}: attacking→following (all threats gone, stop+refollow)`);
        setFollowWard(ward);
      }
    };

    mfBot.on('physicsTick', tick);
    meta.guardListener = tick;
    meta.activeMode = `bodyguard:${protectedUsername}`;
    domainBot.setState(BotState.MOVING);
    console.log(`[Bodyguard] ${domainBot.username}: protecting ${protectedUsername} (r=${radius})`);
  }

  // ─── Shared stop ──────────────────────────────────────────────────────────

  stopGuard(domainBot: Bot): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const meta = this.meta.get(domainBot);
    if (meta.guardListener) {
      mfBot.removeListener('physicsTick', meta.guardListener);
      delete meta.guardListener;
    }
    const bgHurt = (meta as { _bgHurtListener?: () => void })._bgHurtListener;
    if (bgHurt) {
      (mfBot as NodeJS.EventEmitter).removeListener('entityHurt', bgHurt);
      delete (meta as { _bgHurtListener?: () => void })._bgHurtListener;
    }
    const bgPathUpdate = (meta as { _bgPathUpdateListener?: () => void })._bgPathUpdateListener;
    if (bgPathUpdate) {
      (mfBot as NodeJS.EventEmitter).removeListener('path_update', bgPathUpdate);
      delete (meta as { _bgPathUpdateListener?: () => void })._bgPathUpdateListener;
    }
  }
}
