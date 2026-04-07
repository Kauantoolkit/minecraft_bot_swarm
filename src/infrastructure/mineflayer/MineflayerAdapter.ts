import mineflayer, { Bot as MineflayerBot } from 'mineflayer';
import { Entity } from 'prismarine-entity';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Bot } from '../../domain/entities/Bot';
import { BotState } from '../../domain/value-objects/BotState';
import { ConnectionOptions } from '../network/NetworkProvider';
import { BuildQueue } from '../schematic/BuildQueue';
import { QuarryQueue } from '../mining/QuarryQueue';
import { SwarmIntel } from '../../application/SwarmIntel';
import { PlayerRelationshipStore } from '../../domain/value-objects/PlayerRelationship';

/** Returns current time as HH:MM:SS.mmm for log messages. */
function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

// Hostile mobs the defend mode will react to
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'pillager', 'vindicator', 'ravager', 'phantom', 'drowned',
  'husk', 'stray', 'wither_skeleton', 'blaze', 'ghast', 'magma_cube',
  'slime', 'silverfish', 'endermite', 'guardian', 'elder_guardian',
  'shulker', 'vex', 'evoker', 'zombie_villager', 'piglin_brute',
  'zoglin', 'hoglin', 'warden',
]);

// Aerial mobs that cannot be reached by ground pathfinding.
// For these, the bot stays in place and only swings when they swoop close enough,
// instead of using GoalFollow which produces endless partial/noPath cycles and
// leaves the bot jumping in the air trying to reach an unreachable position.
const AERIAL_MOBS = new Set(['phantom', 'ghast', 'blaze', 'bat', 'bee', 'vex']);

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

  //talvez seja interessante logar o estado de cada um dos bots em um modo debug para que eu possa definir q exatamente esta deixando eles lentos ou stuck
}

export class MineflayerAdapter {
  private readonly meta = new WeakMap<Bot, BotMeta>();

  private getMeta(bot: Bot): BotMeta {
    if (!this.meta.has(bot)) this.meta.set(bot, { activeMode: 'idle' });
    return this.meta.get(bot)!;
  }

  /** Returns the current active mode string for display in the debug UI. */
  getMode(bot: Bot): string {
    const meta = this.meta.get(bot);
    if (!meta) return 'idle';
    const primary = meta.activeMode || 'idle';
    const hasDefend = !!(meta as { defendListener?: unknown }).defendListener;
    return hasDefend && !primary.startsWith('defend') ? `${primary}+defend` : primary;
  }

  /** Central Movements factory — always enables sprinting + swimming. */
  private createMovements(mfBot: MineflayerBot): Movements {
    const movements = new Movements(mfBot);
    movements.allowSprinting = true;
    // liquidCost=0 makes water equal cost to land so the pathfinder takes
    // the direct swim path instead of routing far around rivers/lakes.
    // (Default is 1 which doubles the A* cost of every water block, causing
    //  bots to prefer 8-block detours over 5-block swims.)
    (movements as unknown as Record<string, unknown>)['liquidCost'] = 1;
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
      domainBot.attachHandle(mfBot);

      // physicsTick is only emitted when physicsEnabled=true, so we can't use it as a watchdog.
      // Use setInterval instead — runs on the JS event loop regardless of physics state.
      const physicsGuard = setInterval(() => {
        if (!mfBot.physicsEnabled) {
          mfBot.physicsEnabled = true;
          console.warn(`[${domainBot.username}] physicsEnabled was false — forced true`);
        }
      }, 500);
      mfBot.once('end', () => clearInterval(physicsGuard));

      let resolved = false;
      mfBot.on('spawn', () => {
        // Ensure physics is always on — plugins like baritone can leave it disabled
        mfBot.physicsEnabled = true;
        // Limit A* CPU: default tickTimeout=40ms × 10 bots = 400ms blocked per tick
        mfBot.pathfinder.tickTimeout = 10;
        (mfBot.pathfinder as unknown as Record<string, unknown>).searchRadius = 64;
        // Clear any stuck movement keys and active path from previous life
        mfBot.clearControlStates();
        mfBot.pathfinder.stop();
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

    mfBot.pathfinder.stop();
    mfBot.pathfinder.setMovements(this.createMovements(mfBot));

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
    let wasVisible = false;

    const setFollowGoal = (entity: Entity) => {
      currentEntityRef = entity;
      noPathRetry = 0;
      mfBot.pathfinder.setMovements(this.createMovements(mfBot));
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

  stop(domainBot: Bot): void {
    this.stopPvp(domainBot);
    this.stopGuard(domainBot);
    this.stopDefend(domainBot);
    this.stopAvoid(domainBot);
    this.stopFarm(domainBot);
    this.stopExplore(domainBot);
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;
    mfBot.physicsEnabled = true;
    mfBot.pathfinder.stop();
    mfBot.clearControlStates();
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
    const bgPathUpdate = (meta as { _bgPathUpdateListener?: () => void })._bgPathUpdateListener;
    if (bgPathUpdate) {
      (mfBot as NodeJS.EventEmitter).removeListener('path_update', bgPathUpdate);
      delete (meta as { _bgPathUpdateListener?: () => void })._bgPathUpdateListener;
    }
  }

  // ─── Combat — Bodyguard mode ──────────────────────────────────────────────
  //
  // Bots follow a protected player and attack any mob or hostile player
  // that comes within radius of THAT player (not of themselves).

  bodyguard(domainBot: Bot, protectedUsername: string, radius: number, swarmUsernames: string[], relations?: PlayerRelationshipStore, intel?: SwarmIntel): void {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // A bot cannot bodyguard itself — following own entity produces NaN positions
    if (domainBot.username === protectedUsername) {
      console.warn(`[Bodyguard] ${domainBot.username}: cannot bodyguard itself — skipping`);
      return;
    }

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
      mfBot.pathfinder.setMovements(this.createMovements(mfBot));
      mfBot.pathfinder.setGoal(new goals.GoalFollow(ward, 2), true);
    };

    // path_update diagnostics — bodyguard needs to know when paths fail
    const onPathUpdate = (r: { status: string }) => {
      if (r.status === 'noPath') {
        console.warn(`[${ts()}][Bodyguard] ${domainBot.username}: noPath — state=${bgState} ward=${mfBot.players[protectedUsername]?.entity ? 'visible' : 'NOT_VISIBLE'}`);
        // Clear stuck keys — without this the bot may stay floating after a
        // failed attempt to reach an aerial mob (phantom, etc.)
        mfBot.clearControlStates();
      } else if (r.status !== 'success' && r.status !== 'partial') {
        // 'partial' is normal when chasing moving targets — suppress it to reduce spam
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

    // React to damage only when not already attacking — triggering a scan during
    // an active attack just causes target-switching noise with no benefit
    // const onHurt = (entity: Entity) => {
    //   if (mfBot.entity && (entity as unknown as { id?: number }).id === mfBot.entity.id) {
    //     if (bgState === 'attacking') {
    //       console.log(`[${ts()}][Bodyguard] ${domainBot.username}: took damage (state=attacking, scan suppressed)`);
    //       return;
    //     }
    //     console.log(`[${ts()}][Bodyguard] ${domainBot.username}: took damage — triggering immediate threat scan`);
    //     scanTick = 4; // next ++scanTick = 5, 5%5=0 → scan fires immediately
    //   }
    // };
    // mfBot.on('entityHurt', onHurt);
    // (meta as { _bgHurtListener?: (e: Entity) => void })._bgHurtListener = onHurt;

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

      // Log visibility changes immediately
      if (wardVisible !== lastWardVisible) {
        lastWardVisible = wardVisible;
        if (wardVisible) {
          console.log(`[${ts()}][Bodyguard] ${domainBot.username}: "${protectedUsername}" came into range (was ${bgState})`);
        } else {
          console.warn(`[${ts()}][Bodyguard] ${domainBot.username}: "${protectedUsername}" left render range (state=${bgState})`);
        }
      }

      // Periodic heartbeat every ~5 seconds so we can see the bot is alive
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

      // Broadcast fresh intel; only re-issue GoalFollow when not in combat
      // (aerial-threat code calls setFollowWard explicitly with currentFollowEntity=null)
      intel?.report(domainBot.username, protectedUsername, ward.position);
      if (bgState !== 'attacking') setFollowWard(ward);

      // Collect all threats within radius, split by ground vs aerial.
      // Ground threats are prioritised: GoalFollow lets the bot close in and swing.
      // Aerial threats are handled in-place (melee only, no pathfinding) so they
      // never cause partial/noPath loops that leave the bot floating.
      //
      // Threat zone: within radius of the ward OR within radius of the bot itself.
      // The ward may move ahead while mobs lag behind — those mobs fall outside the
      // ward radius but are still actively attacking the bot, so we must include them.
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

      // Sticky targeting: keep current target as long as it's still alive and in
      // radius. Only switch when it disappears — prevents target-flapping between
      // two mobs of the same type (e.g. 74 zombies) which causes noPath cascades.
      const currentTargetStillValid = lastThreatId !== null &&
        allThreats.some(e => e.id === lastThreatId);
      const groundThreat = allThreats.find(e => !AERIAL_MOBS.has((e.name ?? '').toLowerCase()));
      const primaryThreat = currentTargetStillValid
        ? allThreats.find(e => e.id === lastThreatId)!
        : (groundThreat ?? allThreats[0]);

      // Opportunity swing: hit any aerial mob that swoops within melee range,
      // regardless of what the primary focus is. This handles phantom+zombie
      // simultaneously without switching pathfinder goals.
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
            // Only aerial threats remain — navigate back to ward so the bot stays
            // on solid ground. GoalFollow a flying mob causes partial/noPath loops
            // and leaves the bot frozen wherever the previous path ended (mid-jump,
            // stuck block, etc.). bgState stays 'attacking' so the scan doesn't
            // call setFollowWard every tick and opportunity swings keep firing.
            mfBot.pathfinder.setMovements(this.createMovements(mfBot));
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
        // Restore physics before stopping in case the pathfinder disabled it
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

    // React to damage only when idle or fleeing — during an active attack the
    // regular scan already handles the threat list every 5 ticks
    const onHurt = (entity: Entity) => {
      if (mfBot.entity && (entity as unknown as { id?: number }).id === mfBot.entity.id) {
        if (defendState === 'attacking') {
          console.log(`[${ts()}][Defend] ${domainBot.username}: took damage (state=attacking, scan suppressed)`);
          return;
        }
        console.log(`[${ts()}][Defend] ${domainBot.username}: took damage — triggering immediate scan (state=${defendState})`);
        scanTick = 4;
      }
    };
    mfBot.on('entityHurt', onHurt);
    (meta as { _defendHurtListener?: (e: Entity) => void })._defendHurtListener = onHurt;

    // Clear stuck keys when pathfinder gives up — prevents bot floating in air
    const onDefendPathUpdate = (r: { status: string }) => {
      if (r.status === 'noPath') {
        console.warn(`[${ts()}][Defend] ${domainBot.username}: noPath (state=${defendState}) — clearing control states`);
        mfBot.clearControlStates();
      }
    };
    (mfBot as NodeJS.EventEmitter).on('path_update', onDefendPathUpdate);
    (meta as { _defendPathUpdateListener?: (r: { status: string }) => void })._defendPathUpdateListener = onDefendPathUpdate;

    // defend is a background mode — does not override the primary activeMode

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
          const prev = defendState;
          defendState = 'fleeing';
          lastThreatId = creeper.id;
          const dist = Math.floor(creeper.position.distanceTo(mfBot.entity.position));
          console.warn(`[${ts()}][Defend] ${domainBot.username}: ${prev}→fleeing creeper id=${creeper.id} dist=${dist}m`);
          const dx = mfBot.entity.position.x - creeper.position.x;
          const dz = mfBot.entity.position.z - creeper.position.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          const ft = mfBot.entity.position.plus(new Vec3((dx / len) * 20, 0, (dz / len) * 20));
          mfBot.pathfinder.setMovements(this.createMovements(mfBot));
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

      // Priority 2 — hostile mobs. Collect all, ground-first.
      const allMobs = Object.values(mfBot.entities).filter((e) => {
        const entity = e as AnyEntity;
        return entity.name !== undefined &&
          HOSTILE_MOBS.has(entity.name.toLowerCase()) &&
          entity.position.distanceTo(mfBot.entity.position) < radius;
      }) as AnyEntity[];

      // Opportunity swing: hit aerial mobs that swoop within melee range
      // without switching the primary pathfinding target
      for (const e of allMobs) {
        if (!AERIAL_MOBS.has((e.name ?? '').toLowerCase())) continue;
        if (e.position.distanceTo(mfBot.entity.position) < 3.5) {
          mfBot.attack(e as Parameters<MineflayerBot['attack']>[0]);
        }
      }

      const currentMobStillValid = lastThreatId !== null &&
        allMobs.some(e => e.id === lastThreatId);
      const groundMob = allMobs.find(e => !AERIAL_MOBS.has((e.name ?? '').toLowerCase()));
      const primaryMob = currentMobStillValid
        ? allMobs.find(e => e.id === lastThreatId)!
        : (groundMob ?? allMobs[0]);

      if (primaryMob) {
        if (defendState !== 'attacking' || lastThreatId !== primaryMob.id) {
          const prev = defendState;
          defendState = 'attacking';
          lastThreatId = primaryMob.id;
          const isAerial = AERIAL_MOBS.has((primaryMob.name ?? '').toLowerCase());
          if (isAerial) {
            mfBot.pathfinder.stop();
            mfBot.clearControlStates();
            console.log(`[${ts()}][Defend] ${domainBot.username}: ${prev}→attacking aerial "${primaryMob.name}" — holding ground`);
          } else {
            mfBot.pathfinder.setMovements(this.createMovements(mfBot));
            mfBot.pathfinder.setGoal(new goals.GoalFollow(primaryMob as unknown as Entity, 1), true);
            const aerialCount = allMobs.filter(e => AERIAL_MOBS.has((e.name ?? '').toLowerCase())).length;
            const extra = aerialCount > 0 ? ` (+${aerialCount} aerial)` : '';
            console.log(`[${ts()}][Defend] ${domainBot.username}: ${prev}→attacking "${primaryMob.name ?? primaryMob.id}" dist=${Math.floor(primaryMob.position.distanceTo(mfBot.entity.position))}m${extra}`);
          }
        }
      } else if (defendState === 'attacking') {
        const deadStillInEntities = lastThreatId !== null && !!mfBot.entities[lastThreatId];
        defendState = 'idle';
        lastThreatId = null;
        mfBot.physicsEnabled = true;
        mfBot.pathfinder.stop();
        mfBot.clearControlStates();
        console.log(`[${ts()}][Defend] ${domainBot.username}: attacking→idle (all mobs gone, entity still in world=${deadStillInEntities})`);
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
      // defend is background — don't clear the primary activeMode
    }
    const hurtListener = (meta as { _defendHurtListener?: () => void })._defendHurtListener;
    if (hurtListener) {
      (mfBot as NodeJS.EventEmitter).removeListener('entityHurt', hurtListener);
      delete (meta as { _defendHurtListener?: () => void })._defendHurtListener;
    }
    const defendPathUpdate = (meta as { _defendPathUpdateListener?: () => void })._defendPathUpdateListener;
    if (defendPathUpdate) {
      (mfBot as NodeJS.EventEmitter).removeListener('path_update', defendPathUpdate);
      delete (meta as { _defendPathUpdateListener?: () => void })._defendPathUpdateListener;
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
        // GoalXZ navigates to X,Z regardless of terrain height — avoids bots
        // getting stuck trying to reach an exact Y that doesn't exist in the terrain
        mfBot.pathfinder.setGoal(
          new goals.GoalXZ(Math.floor(target.x), Math.floor(target.z)),
        );
        mfBot.once('goal_reached', res);
        setTimeout(() => { mfBot.pathfinder.stop(); res(); }, 30000); // 30 s timeout per leg
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
