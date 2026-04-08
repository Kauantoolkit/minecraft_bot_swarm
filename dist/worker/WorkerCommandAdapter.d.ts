import { EventEmitter } from 'events';
import { Bot } from '../domain/entities/Bot';
import { BuildQueue } from '../infrastructure/schematic/BuildQueue';
import { QuarryQueue } from '../infrastructure/mining/QuarryQueue';
import { SwarmIntel } from '../application/SwarmIntel';
import { PlayerRelationshipStore } from '../domain/value-objects/PlayerRelationship';
import { ConnectionOptions } from '../infrastructure/network/NetworkProvider';
import { IBotAdapter } from '../infrastructure/mineflayer/IBotAdapter';
import { Vec3 } from 'vec3';
import type { DepositFn } from '../infrastructure/mineflayer/behaviors/MiningBehavior';
import type { BotSnapshot, TaskDescriptor } from '../ipc/messages';
/**
 * WorkerCommandAdapter — main-thread half of the worker IPC bridge.
 *
 * Implements IBotAdapter by forwarding every call as a typed message to the
 * corresponding bot's Worker thread. Each bot gets its own Worker (and
 * therefore its own event loop + CPU slice) so pathfinding and physics for
 * one bot never stall another.
 *
 * Events emitted (for Orchestrator and CommandListener):
 *   'state_update'   (botId: string, snapshot: BotSnapshot)
 *   'task_complete'  (botId: string, taskId: string)
 *   'task_failed'    (botId: string, taskId: string, error: string, retryable: boolean)
 *   'player_spotted' (botId: string, target: string, position: SerializedVec3)
 *   'chat_msg'       (botId: string, username: string, message: string)
 *   'disconnected'   (botId: string, reason: string)
 */
export declare class WorkerCommandAdapter extends EventEmitter implements IBotAdapter {
    private readonly workers;
    private readonly snapshots;
    private reqCounter;
    private readonly pending;
    spawn(domainBot: Bot, options: ConnectionOptions): Promise<void>;
    private handleMessage;
    disconnect(domainBot: Bot): void;
    getMode(bot: Bot): string;
    getSnapshot(botId: string): BotSnapshot | undefined;
    private send;
    private nextReqId;
    private sendAsync;
    moveTo(bot: Bot, x: number, y: number, z: number): Promise<void>;
    follow(bot: Bot, targetUsername: string): void;
    stop(bot: Bot): void;
    say(bot: Bot, message: string): void;
    attack(bot: Bot, targetUsername: string): void;
    pvp(bot: Bot, targetUsernames: string[], _intel?: SwarmIntel, _rel?: PlayerRelationshipStore): void;
    stopPvp(bot: Bot): void;
    guard(bot: Bot, x: number, y: number, z: number, radius: number, excludeUsernames: string[], _rel?: PlayerRelationshipStore): void;
    stopGuard(bot: Bot): void;
    bodyguard(bot: Bot, protectedUsername: string, radius: number, swarmUsernames: string[], _rel?: PlayerRelationshipStore, _intel?: SwarmIntel): void;
    startDefend(bot: Bot, radius: number): void;
    stopDefend(bot: Bot): void;
    avoid(bot: Bot, targetUsernames: string[], triggerRadius: number): void;
    stopAvoid(bot: Bot): void;
    collect(bot: Bot, blockName: string, count: number, _onFull?: DepositFn): Promise<void>;
    collectVein(bot: Bot, blockName: string, count: number, _onFull?: DepositFn): Promise<void>;
    quarryFromQueue(_bot: Bot, _queue: QuarryQueue, _onFull?: DepositFn): Promise<void>;
    depositAll(bot: Bot, chestPos: Vec3): Promise<void>;
    withdraw(bot: Bot, chestPos: Vec3, itemName: string, count: number): Promise<number>;
    buildFromQueue(_bot: Bot, _queue: BuildQueue): Promise<void>;
    equip(bot: Bot, itemName: string): Promise<void>;
    eat(bot: Bot): Promise<void>;
    farm(bot: Bot, centerX: number, centerZ: number, radius: number): Promise<void>;
    stopFarm(bot: Bot): void;
    explore(bot: Bot, direction: 'north' | 'south' | 'east' | 'west' | 'auto'): Promise<void>;
    stopExplore(bot: Bot): void;
    assignTask(botId: string, descriptor: TaskDescriptor): void;
    cancelTask(botId: string): void;
    /** Push the current swarm username list to all workers (for bodyguard/guard exclusion). */
    broadcastSwarmUsernames(usernames: string[]): void;
}
//# sourceMappingURL=WorkerCommandAdapter.d.ts.map