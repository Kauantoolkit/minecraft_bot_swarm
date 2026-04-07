import mineflayer, { Bot as MineflayerBot } from 'mineflayer';
import { Entity } from 'prismarine-entity';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loader: baritoneLoader, goals: barGoals } = require('@miner-org/mineflayer-baritone');

/** Typed handle for the ashfinder API attached by the baritone plugin. */
interface Ashfinder {
  goto(goal: unknown): Promise<void>;
  stop(): void;
  isPathing: boolean;
  enableBreaking(): void;
  config: { breakBlocks: boolean; parkour: boolean };
}
import { Bot } from '../../domain/entities/Bot';
import { BotState } from '../../domain/value-objects/BotState';
import { ConnectionOptions } from '../network/NetworkProvider';
import { BuildQueue } from '../schematic/BuildQueue';
import { QuarryQueue } from '../mining/QuarryQueue';
import { SwarmIntel } from '../../application/SwarmIntel';
import { PlayerRelationshipStore } from '../../domain/value-objects/PlayerRelationship';

// Hostile mobs the defend mode will react to
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'pillager', 'vindicator', 'ravager', 'phantom', 'drowned',
  'husk', 'stray', 'wither_skeleton', 'blaze', 'ghast', 'magma_cube',
  'slime', 'silverfish', 'endermite', 'guardian', 'elder_guardian',
  'shulker', 'vex', 'evoker', 'zombie_villager', 'piglin_brute',
  'zoglin', 'hoglin', 'warden',
]);

const CREEPER_FLEE_RADIUS = 7;

// Fully-grown age per crop type
const CROP_MAX_AGE: Record<string, number> = {
  wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3,
};

// Seed item name per crop block name
const CROP_SEED: Record<string, string> = {
  wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato',
  beetroots: 'beetroot_seeds', nether_wart: 'nether_wart',
};

interface BotMeta {
  pvpListener?: () => void;
  followPathUpdateListener?: (r: { status: string }) => void;  // companion to pvpListener when used by follow()
  guardListener?: () => void;  // used by both guard() and bodyguard()
  defendListener?: () => void;
  avoidListener?: () => void;
  farmingActive?: boolean;
  exploringActive?: boolean;
  /** Human-readable current mode for debug UI. */
  activeMode: string;
}

export class MineflayerAdapter {
  private readonly meta = new WeakMap<Bot, BotMeta>();

  private getMeta(bot: Bot): BotMeta {
    if (!this.meta.has(bot)) this.meta.set(bot, { activeMode: 'idle' });
    return this.meta.get(bot)!;
  }

  /** Returns the current active mode string for display in the debug UI. */
  getMode(bot: Bot): string {
    return this.meta.get(bot)?.activeMode ?? 'idle';
  }

  /** Central Movements factory — always enables sprinting + swimming. */
  private createMovements(mfBot: MineflayerBot): Movements {
    const movements = new Movements(mfBot);
    movements.allowSprinting = true;
    // liquidCost=0 makes water equal cost to land so the pathfinder takes
    // the direct swim path instead of routing far around rivers/lakes.
    // (Default is 1 which doubles the A* cost of every water block, causing
    //  bots to prefer 8-block detours over 5-block swims.)
    (movements as unknown as Record<string, unknown>)['liquidCost'] = 0;
    return movements;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  spawn(domainBot: Bot, options: ConnectionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      domainBot.setState(BotState.CONNECTING);

      const mfBot: MineflayerBot = mineflayer.createBot({
        host: options.host,
        port: options.port,
        ...(options.version !== false && { version: options.version }),
        username: options.username,
        agent: options.agent,
        hideErrors: false,
      });

      mfBot.loadPlugin(pathfinder);
      mfBot.loadPlugin(baritoneLoader);
      domainBot.attachHandle(mfBot);

      // ── Float / stuck detector ─────────────────────────────────────────────
      // Runs every 2 s. Fixes two symptoms:
      //   1. Floating: bot is airborne with near-zero vertical velocity
      //      (held jump key from a stuck pathfinder run) → clear jump.
      //   2. Genuinely stuck: bot hasn't moved >0.5 blocks in 5 s while a
      //      mode is active → clear all controls so gravity can take over.
      let lastStuckPos: Vec3 | null = null;
      let lastMoveTime = Date.now();
      let stuckTick = 0;
      // Consecutive ticks airborne with ~0 vertical velocity.
      // A normal jump peaks in ~5 ticks; we need 10+ to distinguish floating.
      let hoverTicks = 0;

      mfBot.on('physicsTick', () => {
        const entity = mfBot.entity;
        if (!entity?.position) return;

        // 1. Float fix — only after 10 consecutive hover-ticks (~0.5 s)
        //    This avoids interrupting the peak of a normal jump (which also has vel.y≈0).
        if (!entity.onGround) {
          const vel = (entity as unknown as { velocity?: Vec3 }).velocity;
          if (vel && Math.abs(vel.y) < 0.02) {
            if (++hoverTicks >= 10) {
              mfBot.setControlState('jump', false);
            }
          } else {
            hoverTicks = 0; // still rising or falling normally
          }
        } else {
          hoverTicks = 0;
        }

        // 2. Stuck check — every 40 ticks (2 s)
        if (++stuckTick % 40 !== 0) return;
        const pos = entity.position;
        if (lastStuckPos && pos.distanceTo(lastStuckPos) > 0.5) {
          lastStuckPos = pos.clone();
          lastMoveTime = Date.now();
          return;
        }
        lastStuckPos ??= pos.clone();
        if (Date.now() - lastMoveTime > 5000) {
          mfBot.clearControlStates();
          const ash = (mfBot as unknown as { ashfinder?: Ashfinder }).ashfinder;
          if (ash?.isPathing) ash.stop();
          lastMoveTime = Date.now();
          console.warn(`[Stuck] ${domainBot.username} unstuck`);
        }
      });

      let resolved = false;
      mfBot.on('spawn', () => {
        // Clear any stuck movement keys and active path from previous life
        mfBot.clearControlStates();
        mfBot.pathfinder.stop();
        const ash = (mfBot as unknown as { ashfinder?: Ashfinder }).ashfinder;
        if (ash?.isPathing) ash.stop();
        mfBot.pathfinder.setMovements(this.createMovements(mfBot));
        domainBot.setState(BotState.CONNECTED);
        if (!resolved) {
          resolved = true;
          console.log(`[MineflayerAdapter] ${domainBot.username} spawned`);
          resolve();
        } else {
          console.log(`[MineflayerAdapter] ${domainBot.username} respawned`);
          // Active listeners (pvp/bodyguard/follow) will naturally re-engage
          // via their per-tick logic once they see the target again
        }
      });

      // Auto-respawn when bot dies (sends the "Respawn" packet after 1.5 s)
      mfBot.on('death', () => {
        console.warn(`[MineflayerAdapter] ${domainBot.username} died — respawning in 1.5 s`);
        setTimeout(() => {
          try { mfBot.respawn(); } catch { /* ignore if already respawned */ }
        }, 1500);
      });

      mfBot.once('error', (err: Error) => {
        domainBot.setState(BotState.ERROR);
        console.error(`[MineflayerAdapter] ${domainBot.username} error: ${err.message}`);
        if (!resolved) { resolved = true; reject(err); }
      });

      mfBot.once('kicked', (reason: string) => {
        domainBot.setState(BotState.DISCONNECTED);
        console.warn(`[MineflayerAdapter] ${domainBot.username} kicked: ${reason}`);
      });

      mfBot.once('end', (reason: string) => {
        domainBot.setState(BotState.DISCONNECTED);
        console.warn(`[MineflayerAdapter] ${domainBot.username} disconnected: ${reason}`);
      });
    });
  }

  disconnect(domainBot: Bot): void {
    this.stop(domainBot);
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    mfBot.quit();
    domainBot.setState(BotState.DISCONNECTED);
  }

  // ─── Movement ─────────────────────────────────────────────────────────────

  async moveTo(domainBot: Bot, x: number, y: number, z: number): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const ash = (mfBot as unknown as { ashfinder?: Ashfinder }).ashfinder;
    if (!ash) throw new Error(`${domainBot.username}: ashfinder not loaded`);

    // Stop any ongoing navigation before issuing a new one
    if (ash.isPathing) ash.stop();
    mfBot.pathfinder.stop();

    domainBot.setState(BotState.MOVING);
    try {
      await ash.goto(new barGoals.GoalNear(x, y, z, 1));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${domainBot.username}: move failed — ${msg}`);
    } finally {
      domainBot.setState(BotState.CONNECTED);
    }
  }

  follow(domainBot: Bot, targetUsername: string): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // Cancel any previous follow listener stored in pvpListener slot (reuse field)
    const meta = this.getMeta(domainBot);
    if (meta.pvpListener) mfBot.removeListener('physicsTick', meta.pvpListener);

    mfBot.pathfinder.setMovements(this.createMovements(mfBot));

    let currentEntityRef: Entity | null = null;
    let noPathRetry = 0;
    let scanTick = 0;

    // Re-issue goal when entity reference changes or after a noPath recovery
    const setFollowGoal = (entity: Entity) => {
      currentEntityRef = entity;
      noPathRetry = 0;
      mfBot.pathfinder.setMovements(this.createMovements(mfBot));
      mfBot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
    };

    // Recover from noPath: wait a few seconds and re-issue goal
    const onPathUpdate = (r: { status: string }) => {
      if (r.status === 'noPath' && ++noPathRetry <= 5) {
        const delay = 3000 * noPathRetry;
        setTimeout(() => {
          const entity = mfBot.players[targetUsername]?.entity;
          if (entity) setFollowGoal(entity);
        }, delay);
      }
    };
    (mfBot as NodeJS.EventEmitter).on('path_update', onPathUpdate);
    meta.followPathUpdateListener = onPathUpdate;

    const tick = (): void => {
      if (++scanTick % 10 !== 0) return; // check at 2 Hz

      const entity = mfBot.players[targetUsername]?.entity;
      if (!entity) return; // player not in range yet — wait

      // Re-issue goal only when entity reference changes (e.g. teleport/respawn)
      if (entity !== currentEntityRef) setFollowGoal(entity);
    };

    mfBot.on('physicsTick', tick);
    meta.pvpListener = tick;

    domainBot.setState(BotState.MOVING);
    console.log(`[MineflayerAdapter] ${domainBot.username}: following ${targetUsername}`);

    // If player already visible, start immediately
    const entity = mfBot.players[targetUsername]?.entity;
    if (entity) setFollowGoal(entity);
  }

  stop(domainBot: Bot): void {
    this.stopPvp(domainBot);
    this.stopGuard(domainBot);
    this.stopDefend(domainBot);
    this.stopAvoid(domainBot);
    this.stopFarm(domainBot);
    this.stopExplore(domainBot);
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    mfBot.pathfinder.stop();
    const ash = (mfBot as unknown as { ashfinder?: Ashfinder }).ashfinder;
    if (ash?.isPathing) ash.stop(); // also calls clearControlStates()
    domainBot.setState(BotState.CONNECTED);
    this.getMeta(domainBot).activeMode = 'idle';
  }

  // ─── Chat ─────────────────────────────────────────────────────────────────

  say(domainBot: Bot, message: string): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    mfBot.chat(message);
  }

  // ─── Combat — single hit ──────────────────────────────────────────────────

  attack(domainBot: Bot, targetUsername: string): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const entity = mfBot.players[targetUsername]?.entity;
    if (entity) mfBot.attack(entity);
  }

  // ─── Combat — PvP mode (continuous) ──────────────────────────────────────

  pvp(domainBot: Bot, targetUsernames: string[], intel?: SwarmIntel, relations?: PlayerRelationshipStore): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.getMeta(domainBot);
    if (meta.pvpListener) mfBot.removeListener('physicsTick', meta.pvpListener);

    mfBot.pathfinder.setMovements(this.createMovements(mfBot));

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
        if (intel) {
          intel.report(domainBot.username, found.username, found.entity.position);
        }

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
          // Another bot has eyes on the target — head there
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

  stopPvp(domainBot: Bot): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const meta = this.getMeta(domainBot);
    if (meta.pvpListener) {
      mfBot.removeListener('physicsTick', meta.pvpListener);
      delete meta.pvpListener;
      meta.activeMode = 'idle';
    }
    if (meta.followPathUpdateListener) {
      (mfBot as NodeJS.EventEmitter).removeListener('path_update', meta.followPathUpdateListener);
      delete meta.followPathUpdateListener;
    }
  }

  // ─── Combat — Guard position ──────────────────────────────────────────────

  guard(domainBot: Bot, x: number, y: number, z: number, radius: number, excludeUsernames: string[], relations?: PlayerRelationshipStore): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.getMeta(domainBot);
    if (meta.guardListener) mfBot.removeListener('physicsTick', meta.guardListener);

    mfBot.pathfinder.setMovements(this.createMovements(mfBot));
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
        if (!relations) return true; // no relations → attack all non-swarm players
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
        } else if (guardState === 'moving-to-post') {
          // Will become idle once goal_reached fires — nothing to do here
        }
      }
    };

    mfBot.on('physicsTick', tick);
    meta.guardListener = tick;
    domainBot.setState(BotState.MOVING);
  }

  stopGuard(domainBot: Bot): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const meta = this.getMeta(domainBot);
    if (meta.guardListener) {
      mfBot.removeListener('physicsTick', meta.guardListener);
      delete meta.guardListener;
    }
    const bgHurt = (meta as { _bgHurtListener?: () => void })._bgHurtListener;
    if (bgHurt) {
      (mfBot as NodeJS.EventEmitter).removeListener('entityHurt', bgHurt);
      delete (meta as { _bgHurtListener?: () => void })._bgHurtListener;
    }
  }

  // ─── Combat — Bodyguard mode ──────────────────────────────────────────────
  //
  // Bots follow a protected player and attack any mob or hostile player
  // that comes within radius of THAT player (not of themselves).

  bodyguard(domainBot: Bot, protectedUsername: string, radius: number, swarmUsernames: string[], relations?: PlayerRelationshipStore, intel?: SwarmIntel): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.getMeta(domainBot);
    if (meta.guardListener) mfBot.removeListener('physicsTick', meta.guardListener);
    const oldHurt = (meta as { _bgHurtListener?: () => void })._bgHurtListener;
    if (oldHurt) { (mfBot as NodeJS.EventEmitter).removeListener('entityHurt', oldHurt); }

    mfBot.pathfinder.setMovements(this.createMovements(mfBot));

    type BodyguardState = 'following' | 'heading-to-intel' | 'waiting' | 'attacking';
    let bgState: BodyguardState = 'following';
    let lastThreatId: number | null = null;
    let scanTick = 0;
    let currentFollowEntity: Entity | null = null;

    const setFollowWard = (ward: Entity) => {
      // Always report fresh position to intel so other bots have current coords
      intel?.report(domainBot.username, protectedUsername, ward.position);
      if (ward === currentFollowEntity && bgState === 'following') return;
      currentFollowEntity = ward;
      bgState = 'following';
      mfBot.pathfinder.setGoal(new goals.GoalFollow(ward, 2), true);
    };

    // Start following if already in range, otherwise use intel or wait
    const ward0 = mfBot.players[protectedUsername]?.entity;
    if (ward0) {
      setFollowWard(ward0);
    } else {
      const sighting = intel?.getLastSighting(protectedUsername);
      if (sighting) {
        bgState = 'heading-to-intel';
        mfBot.pathfinder.setGoal(new goals.GoalNear(sighting.position.x, sighting.position.y, sighting.position.z, 5));
        console.log(`[Bodyguard] ${domainBot.username}: heading to last known pos of ${protectedUsername}`);
      } else {
        bgState = 'waiting';
        console.warn(`[Bodyguard] ${domainBot.username}: "${protectedUsername}" not visible, waiting...`);
      }
    }

    // Immediate reaction when bot takes damage — trigger scan on next tick
    const onHurt = (entity: Entity) => {
      if (mfBot.entity && (entity as unknown as { id?: number }).id === mfBot.entity.id) {
        scanTick = 4; // next ++scanTick = 5, 5%5=0 → scan fires immediately
      }
    };
    mfBot.on('entityHurt', onHurt);
    (meta as { _bgHurtListener?: (e: Entity) => void })._bgHurtListener = onHurt;

    const tick = (): void => {
      // Safety guard during death/respawn transition
      if (!mfBot.entity?.position) return;

      type AnyEntity = MineflayerBot['entity'] & { username?: string; type?: string; name?: string };

      // Melee attack every tick while in combat
      if (bgState === 'attacking' && lastThreatId !== null) {
        const t = mfBot.entities[lastThreatId] as AnyEntity | undefined;
        if (t && t.position.distanceTo(mfBot.entity.position) < 4.0) mfBot.attack(t);
      }

      if (++scanTick % 5 !== 0) return;

      const ward = mfBot.players[protectedUsername]?.entity;
      if (!ward) {
        // Player out of range — navigate to latest intel sighting or wait
        if (bgState !== 'heading-to-intel') {
          const sighting = intel?.getLastSighting(protectedUsername);
          if (sighting) {
            bgState = 'heading-to-intel';
            lastThreatId = null;
            currentFollowEntity = null;
            mfBot.pathfinder.setGoal(new goals.GoalNear(sighting.position.x, sighting.position.y, sighting.position.z, 5));
          } else if (bgState !== 'waiting') {
            bgState = 'waiting';
            lastThreatId = null;
            currentFollowEntity = null;
            mfBot.pathfinder.stop();
          }
        }
        return;
      }

      // Player back in range — setFollowWard also broadcasts fresh intel
      setFollowWard(ward);

      const threat = Object.values(mfBot.entities).find((e) => {
        const entity = e as AnyEntity;
        if (entity.position.distanceTo(ward.position) >= radius) return false;
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
      }) as AnyEntity | undefined;

      if (threat) {
        if (bgState !== 'attacking' || lastThreatId !== threat.id) {
          bgState = 'attacking';
          lastThreatId = threat.id;
          mfBot.pathfinder.setGoal(new goals.GoalFollow(threat, 1), true);
        }
      } else if (bgState === 'attacking') {
        lastThreatId = null;
        setFollowWard(ward);
      }
    };

    mfBot.on('physicsTick', tick);
    meta.guardListener = tick;
    meta.activeMode = `bodyguard:${protectedUsername}`;
    domainBot.setState(BotState.MOVING);
    console.log(`[Bodyguard] ${domainBot.username}: protecting ${protectedUsername} (r=${radius})`);
  }

  // ─── Combat — Defend mode (passive background listener) ───────────────────
  //
  // Runs independently of other modes. Priority:
  //   1. Creeper within CREEPER_FLEE_RADIUS → flee in opposite direction
  //   2. Hostile mob within radius → chase + attack
  //   3. Nothing → do not touch pathfinder (lets other modes work normally)

  startDefend(domainBot: Bot, radius: number): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.getMeta(domainBot);
    if (meta.defendListener) mfBot.removeListener('physicsTick', meta.defendListener);
    if ((meta as { _defendHurtListener?: () => void })._defendHurtListener) {
      (mfBot as NodeJS.EventEmitter).removeListener('entityHurt',
        (meta as { _defendHurtListener?: () => void })._defendHurtListener!);
    }

    type DefendState = 'idle' | 'fleeing' | 'attacking';
    let defendState: DefendState = 'idle';
    let lastThreatId: number | null = null;
    let scanTick = 0;

    // Immediate reaction when bot itself takes damage — trigger scan on next tick
    const onHurt = (entity: Entity) => {
      if (mfBot.entity && (entity as unknown as { id?: number }).id === mfBot.entity.id) {
        scanTick = 4; // next ++scanTick=5, 5%5=0 → scan fires immediately
      }
    };
    mfBot.on('entityHurt', onHurt);
    (meta as { _defendHurtListener?: (e: Entity) => void })._defendHurtListener = onHurt;

    meta.activeMode = `defend:r${radius}`;

    const tick = (): void => {
      // Safety guard during death/respawn transition
      if (!mfBot.entity?.position) return;

      type AnyEntity = { type?: string; name?: string; position: Vec3; id: number };

      // Attack is cheap — every tick while in combat
      if (defendState === 'attacking' && lastThreatId !== null) {
        const threat = mfBot.entities[lastThreatId] as AnyEntity | undefined;
        if (threat && threat.position.distanceTo(mfBot.entity.position) < 3.5) {
          mfBot.attack(threat as Parameters<MineflayerBot['attack']>[0]);
        }
      }

      // Entity scan every 5 ticks (4 Hz)
      if (++scanTick % 5 !== 0) return;

      // Priority 1 — creeper
      const creeper = Object.values(mfBot.entities).find((e) => {
        const entity = e as AnyEntity;
        return entity.name === 'creeper' &&
          entity.position.distanceTo(mfBot.entity.position) < CREEPER_FLEE_RADIUS;
      }) as AnyEntity | undefined;

      if (creeper) {
        if (defendState !== 'fleeing' || lastThreatId !== creeper.id) {
          defendState = 'fleeing';
          lastThreatId = creeper.id;
          console.warn(`[Defend] ${domainBot.username} — FLEEING creeper`);
          const away = mfBot.entity.position.minus(creeper.position).normalize().scaled(20);
          const ft = mfBot.entity.position.plus(away);
          mfBot.pathfinder.setMovements(this.createMovements(mfBot));
          mfBot.pathfinder.setGoal(new goals.GoalBlock(Math.floor(ft.x), Math.floor(ft.y), Math.floor(ft.z)));
        }
        return;
      }

      if (defendState === 'fleeing') {
        defendState = 'idle';
        lastThreatId = null;
        mfBot.pathfinder.stop();
        console.log(`[Defend] ${domainBot.username} — creeper gone`);
      }

      // Priority 2 — hostile mob (name-based check, same as bodyguard)
      const mob = Object.values(mfBot.entities).find((e) => {
        const entity = e as AnyEntity;
        return entity.name !== undefined &&
          HOSTILE_MOBS.has((entity.name).toLowerCase()) &&
          entity.position.distanceTo(mfBot.entity.position) < radius;
      }) as AnyEntity | undefined;

      if (mob) {
        if (defendState !== 'attacking' || lastThreatId !== mob.id) {
          defendState = 'attacking';
          lastThreatId = mob.id;
          mfBot.pathfinder.setMovements(this.createMovements(mfBot));
          mfBot.pathfinder.setGoal(new goals.GoalFollow(mob as unknown as Entity, 1), true);
        }
      } else if (defendState === 'attacking') {
        defendState = 'idle';
        lastThreatId = null;
        mfBot.pathfinder.stop();
      }
    };

    mfBot.on('physicsTick', tick);
    meta.defendListener = tick;
    console.log(`[MineflayerAdapter] ${domainBot.username}: defend mode ON (radius=${radius})`);
  }

  stopDefend(domainBot: Bot): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    const meta = this.getMeta(domainBot);
    if (meta.defendListener) {
      mfBot.removeListener('physicsTick', meta.defendListener);
      delete meta.defendListener;
      meta.activeMode = 'idle';
    }
    const hurtListener = (meta as { _defendHurtListener?: () => void })._defendHurtListener;
    if (hurtListener) {
      (mfBot as NodeJS.EventEmitter).removeListener('entityHurt', hurtListener);
      delete (meta as { _defendHurtListener?: () => void })._defendHurtListener;
    }
    console.log(`[MineflayerAdapter] ${domainBot.username}: defend mode OFF`);
  }

  // ─── Resource collection ──────────────────────────────────────────────────

  /**
   * Navigate to a block, stop pathfinder, then dig with a fresh reference.
   * Returns true if the block was successfully mined, false if it was already
   * gone or out of reach.
   */
  private async safeDig(
    mfBot: MineflayerBot,
    pos: Vec3,
    expectedName: string,
    mcData: ReturnType<typeof require>,
  ): Promise<boolean> {
    // Navigate adjacent to the block
    await new Promise<void>((res) => {
      mfBot.pathfinder.setGoal(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
      mfBot.once('goal_reached', res);
      setTimeout(res, 8000); // fallback if path never resolves
    });

    // Fresh reference after arriving
    const block = mfBot.blockAt(pos);
    if (!block || block.name !== expectedName) return false; // already mined
    if (block.position.distanceTo(mfBot.entity.position) > 5) return false; // didn't get close enough

    // Auto-equip best tool before digging
    await this.autoEquipToolFor(mfBot, block, mcData);

    if (!mfBot.canDigBlock(block)) return false;

    // Stop pathfinder so bot stays still during dig
    mfBot.pathfinder.stop();
    mfBot.clearControlStates();

    try {
      await mfBot.dig(block, true); // forceLook=true keeps aim on block
      return true;
    } catch {
      // One retry after brief pause (bot may have drifted slightly)
      await new Promise(r => setTimeout(r, 300));
      const retry = mfBot.blockAt(pos);
      if (!retry || retry.name !== expectedName || !mfBot.canDigBlock(retry)) return false;
      mfBot.pathfinder.stop();
      mfBot.clearControlStates();
      try {
        await mfBot.dig(retry, true);
        return true;
      } catch { return false; }
    }
  }

  async collect(domainBot: Bot, blockName: string, count: number): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const blockType = mcData.blocksByName[blockName];
    if (!blockType) {
      console.warn(`[MineflayerAdapter] ${domainBot.username}: unknown block "${blockName}"`);
      return;
    }

    domainBot.setState(BotState.MOVING);
    mfBot.pathfinder.setMovements(this.createMovements(mfBot));

    let collected = 0;
    while (collected < count) {
      const block = mfBot.findBlock({ matching: blockType.id, maxDistance: 64 });
      if (!block) {
        console.warn(`[MineflayerAdapter] ${domainBot.username}: no "${blockName}" in range`);
        break;
      }

      const mined = await this.safeDig(mfBot, block.position, blockName, mcData);
      if (mined) {
        collected++;
        console.log(`[MineflayerAdapter] ${domainBot.username}: ${blockName} ${collected}/${count}`);
        mfBot.pathfinder.setMovements(this.createMovements(mfBot)); // re-enable after stop
      }
    }

    domainBot.setState(BotState.CONNECTED);
  }

  // ─── Building — smart queue consumer ─────────────────────────────────────
  //
  // Pulls tasks from the shared BuildQueue. If a required block is missing
  // from inventory, the task is deferred back to the queue so another bot
  // (or a future inventory restock) can handle it.

  async buildFromQueue(domainBot: Bot, queue: BuildQueue): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    mfBot.pathfinder.setMovements(this.createMovements(mfBot));
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
        // Defer — bot doesn't have this block right now
        queue.deferTask(task, shortName);
        continue;
      }

      await mfBot.equip(item as Parameters<MineflayerBot['equip']>[0], 'hand');

      // Navigate close enough to place
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

  // ─── Inventory ────────────────────────────────────────────────────────────

  async equip(domainBot: Bot, itemName: string): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const itemDef = mcData.itemsByName[itemName] ?? mcData.blocksByName[itemName];
    if (!itemDef) {
      console.warn(`[MineflayerAdapter] ${domainBot.username}: unknown item "${itemName}"`);
      return;
    }

    const item = (mfBot.inventory.items() as Array<{ type: number }>).find(i => i.type === itemDef.id);
    if (!item) {
      console.warn(`[MineflayerAdapter] ${domainBot.username}: "${itemName}" not in inventory`);
      return;
    }

    await mfBot.equip(item as Parameters<MineflayerBot['equip']>[0], 'hand');
  }

  async eat(domainBot: Bot): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);

    const foodItem = (mfBot.inventory.items() as Array<{ type: number }>)
      .filter(i => mcData.foods[i.type])
      .sort((a, b) => (mcData.foods[b.type]?.foodPoints ?? 0) - (mcData.foods[a.type]?.foodPoints ?? 0))[0];

    if (!foodItem) {
      console.warn(`[MineflayerAdapter] ${domainBot.username}: no food`);
      return;
    }

    await mfBot.equip(foodItem as Parameters<MineflayerBot['equip']>[0], 'hand');
    await mfBot.consume();
  }

  // ─── Vein mining (collect with connected-block chaining) ──────────────────

  async collectVein(domainBot: Bot, blockName: string, count: number): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const blockType = mcData.blocksByName[blockName];
    if (!blockType) {
      console.warn(`[MineflayerAdapter] ${domainBot.username}: unknown block "${blockName}"`);
      return;
    }

    domainBot.setState(BotState.MOVING);
    mfBot.pathfinder.setMovements(this.createMovements(mfBot));

    let collected = 0;
    // Local vein queue — positions added when adjacent ore is found
    const veinQueue: Vec3[] = [];

    const tryDigAt = async (pos: Vec3): Promise<boolean> => {
      const mined = await this.safeDig(mfBot, pos, blockName, mcData);
      if (!mined) return false;

      collected++;
      console.log(`[Vein] ${domainBot.username}: ${blockName} ${collected}/${count}`);
      mfBot.pathfinder.setMovements(this.createMovements(mfBot)); // re-enable after stop

      // Enqueue all 6 adjacent positions of same type
      const offsets = [
        new Vec3(1,0,0), new Vec3(-1,0,0),
        new Vec3(0,1,0), new Vec3(0,-1,0),
        new Vec3(0,0,1), new Vec3(0,0,-1),
      ];
      for (const off of offsets) {
        const adj = pos.plus(off);
        const adjBlock = mfBot.blockAt(adj);
        if (adjBlock?.type === blockType.id) veinQueue.push(adj);
      }
      return true;
    };

    while (collected < count) {
      // Drain vein queue first
      while (veinQueue.length > 0 && collected < count) {
        const pos = veinQueue.shift()!;
        await tryDigAt(pos);
      }
      if (collected >= count) break;

      // Find next vein seed
      const block = mfBot.findBlock({ matching: blockType.id, maxDistance: 64 });
      if (!block) {
        console.warn(`[MineflayerAdapter] ${domainBot.username}: no "${blockName}" in range`);
        break;
      }
      await tryDigAt(block.position);
    }

    domainBot.setState(BotState.CONNECTED);
  }

  // ─── Quarry ───────────────────────────────────────────────────────────────

  async quarryFromQueue(domainBot: Bot, queue: QuarryQueue): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    mfBot.pathfinder.setMovements(this.createMovements(mfBot));
    domainBot.setState(BotState.MOVING);

    while (!queue.isEmpty()) {
      const pos = queue.next();
      if (!pos) break;

      const block = mfBot.blockAt(pos);
      if (!block || block.name === 'air' || block.name === 'cave_air') continue;

      const mined = await this.safeDig(mfBot, pos, block.name, mcData);
      if (mined) {
        queue.markDone();
        console.log(`[Quarry] ${domainBot.username}: mined [${queue.progress}]`);
        mfBot.pathfinder.setMovements(this.createMovements(mfBot)); // re-enable after stop
      } else {
        queue.putBack(pos); // couldn't dig — another bot will retry
      }
    }

    domainBot.setState(BotState.CONNECTED);
  }

  // ─── Farm ─────────────────────────────────────────────────────────────────

  async farm(domainBot: Bot, centerX: number, centerZ: number, radius: number): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcData = require('minecraft-data')(mfBot.version);
    const meta = this.getMeta(domainBot);
    meta.farmingActive = true;
    mfBot.pathfinder.setMovements(this.createMovements(mfBot));
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
    const meta = this.getMeta(domainBot);
    meta.farmingActive = false;
  }

  // ─── Explore ──────────────────────────────────────────────────────────────

  async explore(domainBot: Bot, direction: 'north' | 'south' | 'east' | 'west' | 'auto'): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.getMeta(domainBot);
    meta.exploringActive = true;
    mfBot.pathfinder.setMovements(this.createMovements(mfBot));
    domainBot.setState(BotState.MOVING);

    const STEP = 200; // blocks per leg

    const directionVec: Record<string, Vec3> = {
      north: new Vec3(0, 0, -1),
      south: new Vec3(0, 0, 1),
      east:  new Vec3(1, 0, 0),
      west:  new Vec3(-1, 0, 0),
    };

    console.log(`[Explore] ${domainBot.username}: heading ${direction}`);

    while (meta.exploringActive && domainBot.isOnline()) {
      let dir: Vec3;

      if (direction === 'auto') {
        // Walk toward lowest-chunk-load quadrant (simple: random cardinal)
        const dirs = Object.values(directionVec);
        dir = dirs[Math.floor(Math.random() * dirs.length)];
      } else {
        dir = directionVec[direction];
      }

      const target = mfBot.entity.position.plus(dir.scaled(STEP));

      await new Promise<void>((res) => {
        mfBot.pathfinder.setGoal(
          new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)),
        );
        mfBot.once('goal_reached', res);
        setTimeout(res, 30000); // 30 s timeout per leg
      });
    }

    domainBot.setState(BotState.CONNECTED);
  }

  stopExplore(domainBot: Bot): void {
    const meta = this.getMeta(domainBot);
    meta.exploringActive = false;
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (mfBot) mfBot.pathfinder.stop();
  }

  // ─── Avoid player ─────────────────────────────────────────────────────────

  avoid(domainBot: Bot, targetUsernames: string[], triggerRadius: number): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    const meta = this.getMeta(domainBot);
    if (meta.avoidListener) mfBot.removeListener('physicsTick', meta.avoidListener);

    mfBot.pathfinder.setMovements(this.createMovements(mfBot));

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
    const meta = this.getMeta(domainBot);
    if (meta.avoidListener) {
      mfBot.removeListener('physicsTick', meta.avoidListener);
      delete meta.avoidListener;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async autoEquipToolFor(mfBot: MineflayerBot, block: ReturnType<MineflayerBot['blockAt']>, mcData: unknown): Promise<void> {
    if (!block) return;
    const md = mcData as Record<string, unknown>;

    // Tool preference order per harvest type
    const TOOL_PRIORITY: Record<string, string[]> = {
      pickaxe: ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe','golden_pickaxe'],
      axe:     ['netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe','golden_axe'],
      shovel:  ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel','golden_shovel'],
      hoe:     ['netherite_hoe','diamond_hoe','iron_hoe','stone_hoe','wooden_hoe','golden_hoe'],
      sword:   ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword'],
    };

    const blockDef = (md['blocks'] as Record<number, { harvestTools?: Record<string, boolean> }>)[block.type];
    if (!blockDef?.harvestTools) return;

    const validToolIds = new Set(Object.keys(blockDef.harvestTools).map(Number));

    for (const tools of Object.values(TOOL_PRIORITY)) {
      for (const toolName of tools) {
        const toolDef = (md['itemsByName'] as Record<string, { id: number }>)[toolName];
        if (!toolDef || !validToolIds.has(toolDef.id)) continue;
        const item = (mfBot.inventory.items() as Array<{ type: number }>).find(i => i.type === toolDef.id);
        if (item) {
          await mfBot.equip(item as Parameters<MineflayerBot['equip']>[0], 'hand');
          return;
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
