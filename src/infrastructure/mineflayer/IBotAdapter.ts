import { Bot } from '../../domain/entities/Bot';
import { BuildQueue } from '../schematic/BuildQueue';
import { QuarryQueue } from '../mining/QuarryQueue';
import { SwarmIntel } from '../../application/SwarmIntel';
import { PlayerRelationshipStore } from '../../domain/value-objects/PlayerRelationship';
import { ConnectionOptions } from '../network/NetworkProvider';
import { Vec3 } from 'vec3';
import type { DepositFn } from './behaviors/MiningBehavior';

/**
 * Abstraction over bot command dispatch.
 *
 * MineflayerAdapter (direct, single-thread) and WorkerCommandAdapter (per-bot
 * worker threads) both implement this interface, allowing the rest of the
 * application to remain unaware of the execution model.
 */
export interface IBotAdapter {
  // Lifecycle
  spawn(bot: Bot, options: ConnectionOptions): Promise<void>;
  disconnect(bot: Bot): void;
  getMode(bot: Bot): string;
  /** Returns the bot's current world position, or null if unavailable. */
  getPosition(bot: Bot): Vec3 | null;

  // Movement
  moveTo(bot: Bot, x: number, y: number, z: number): Promise<void>;
  follow(bot: Bot, targetUsername: string): void;
  stop(bot: Bot): void;

  // Chat
  say(bot: Bot, message: string): void;

  // Combat
  attack(bot: Bot, targetUsername: string): void;
  pvp(bot: Bot, targetUsernames: string[], intel?: SwarmIntel, relations?: PlayerRelationshipStore): void;
  stopPvp(bot: Bot): void;
  guard(bot: Bot, x: number, y: number, z: number, radius: number, excludeUsernames: string[], relations?: PlayerRelationshipStore): void;
  stopGuard(bot: Bot): void;
  bodyguard(bot: Bot, protectedUsername: string, radius: number, swarmUsernames: string[], relations?: PlayerRelationshipStore, intel?: SwarmIntel): void;
  startDefend(bot: Bot, radius: number): void;
  stopDefend(bot: Bot): void;
  avoid(bot: Bot, targetUsernames: string[], triggerRadius: number): void;
  stopAvoid(bot: Bot): void;

  // Resources
  collect(bot: Bot, blockName: string | string[], count: number, onFull?: DepositFn): Promise<void>;
  collectVein(bot: Bot, blockName: string, count: number, onFull?: DepositFn): Promise<void>;
  quarryFromQueue(bot: Bot, queue: QuarryQueue, onFull?: DepositFn): Promise<void>;
  depositAll(bot: Bot, chestPos: Vec3): Promise<void>;
  withdraw(bot: Bot, chestPos: Vec3, itemName: string, count: number): Promise<number>;

  // Building
  buildFromQueue(bot: Bot, queue: BuildQueue): Promise<void>;

  // Inventory
  equip(bot: Bot, itemName: string): Promise<void>;
  eat(bot: Bot): Promise<void>;

  // Farm / Explore
  farm(bot: Bot, centerX: number, centerZ: number, radius: number): Promise<void>;
  stopFarm(bot: Bot): void;
  explore(bot: Bot, direction: 'north' | 'south' | 'east' | 'west' | 'auto'): Promise<void>;
  stopExplore(bot: Bot): void;

  /**
   * Send one bot to scan for chest/barrel blocks near (x,y,z) within radius.
   * Returns an empty array in direct (single-thread) mode.
   */
  scanStorage(botId: string, x: number, y: number, z: number, radius: number): Promise<Array<{ x: number; y: number; z: number }>>;
}
