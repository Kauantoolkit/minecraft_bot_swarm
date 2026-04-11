import path from 'path';
import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { Bot } from '../domain/entities/Bot';
import { BotState } from '../domain/value-objects/BotState';
import { BuildQueue } from '../infrastructure/schematic/BuildQueue';
import { QuarryQueue } from '../infrastructure/mining/QuarryQueue';
import { SwarmIntel } from '../application/SwarmIntel';
import { PlayerRelationshipStore } from '../domain/value-objects/PlayerRelationship';
import { ConnectionOptions } from '../infrastructure/network/NetworkProvider';
import { IBotAdapter } from '../infrastructure/mineflayer/IBotAdapter';
import { Vec3 } from 'vec3';
import type { DepositFn } from '../infrastructure/mineflayer/behaviors/MiningBehavior';
import type {
  MainToWorkerMsg,
  WorkerToMainMsg,
  BotSnapshot,
  TaskDescriptor,
} from '../ipc/messages';

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
export class WorkerCommandAdapter extends EventEmitter implements IBotAdapter {
  private static readonly CMD_TIMEOUT_MS = 30_000;
  private readonly workers   = new Map<string, Worker>();
  private readonly snapshots = new Map<string, BotSnapshot>();
  private reqCounter = 0;
  private readonly pending = new Map<
    string,
    {
      botId: string;
      timeout: ReturnType<typeof setTimeout>;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
    }
  >();

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  spawn(domainBot: Bot, options: ConnectionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // Support both ts-node (dev) and compiled (prod) environments
      const isTs = __filename.endsWith('.ts');
      const workerFile = isTs ? 'BotWorker.ts' : 'BotWorker.js';
      const workerPath = path.join(__dirname, workerFile);

      const workerOptions: import('worker_threads').WorkerOptions = {
        workerData: {
          botId:    domainBot.id,
          username: domainBot.username,
          proxyUrl: domainBot.proxy?.url,
          server: {
            host:    options.host,
            port:    options.port,
            version: options.version,
          },
        } satisfies import('../ipc/messages').BotWorkerData,
        ...(isTs && { execArgv: ['--require', 'ts-node/register'] }),
      };

      const worker = new Worker(workerPath, workerOptions);
      this.workers.set(domainBot.id, worker);
      domainBot.setState(BotState.CONNECTING);

      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      worker.on('message', (msg: WorkerToMainMsg) => {
        // Route to the general handler for every message
        this.handleMessage(domainBot, msg);

        // Also handle the spawn promise
        if (!settled) {
          if (msg.type === 'READY') settle(resolve);
          else if (msg.type === 'ERROR') settle(() => reject(new Error(msg.error)));
        }
      });

      worker.on('error', err => {
        settle(() => reject(err));
        this.rejectPendingForBot(domainBot.id, `worker error: ${err.message}`);
        this.emit('disconnected', domainBot.id, `worker error: ${err.message}`);
        console.error(`[WorkerAdapter] Worker for ${domainBot.username} threw: ${err.message}`);
      });

      worker.on('exit', code => {
        this.workers.delete(domainBot.id);
        domainBot.setState(BotState.DISCONNECTED);
        this.rejectPendingForBot(domainBot.id, `worker exited with code ${code}`);
        this.emit('disconnected', domainBot.id, `worker exited with code ${code}`);
        if (code !== 0) settle(() => reject(new Error(`Worker exited with code ${code}`)));
      });
    });
  }

  private rejectPendingForBot(botId: string, reason: string): void {
    for (const [reqId, pending] of this.pending.entries()) {
      if (pending.botId !== botId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(reqId);
      pending.reject(new Error(reason));
    }
  }

  private handleMessage(domainBot: Bot, msg: WorkerToMainMsg): void {
    switch (msg.type) {
      case 'ERROR':
        domainBot.setState(BotState.ERROR);
        this.rejectPendingForBot(domainBot.id, msg.error);
        console.error(`[WorkerAdapter] ${domainBot.username} error: ${msg.error}`);
        this.emit('disconnected', domainBot.id, msg.error);
        break;

      case 'STATE_UPDATE':
        this.snapshots.set(domainBot.id, msg.snapshot);
        domainBot.setState(msg.snapshot.connected ? BotState.CONNECTED : BotState.DISCONNECTED);
        this.emit('state_update', domainBot.id, msg.snapshot);
        break;

      case 'DISCONNECTED':
        domainBot.setState(BotState.DISCONNECTED);
        this.rejectPendingForBot(domainBot.id, msg.reason);
        this.emit('disconnected', domainBot.id, msg.reason);
        break;

      case 'TASK_COMPLETE':
        this.emit('task_complete', domainBot.id, msg.taskId);
        break;

      case 'TASK_FAILED':
        this.emit('task_failed', domainBot.id, msg.taskId, msg.error, msg.retryable);
        break;

      case 'CMD_RESULT': {
        const resolver = this.pending.get(msg.reqId);
        if (resolver) {
          clearTimeout(resolver.timeout);
          this.pending.delete(msg.reqId);
          msg.success ? resolver.resolve(msg.value ?? undefined) : resolver.reject(new Error(msg.error ?? 'cmd error'));
        }
        break;
      }

      case 'PLAYER_SPOTTED':
        this.emit('player_spotted', domainBot.id, msg.target, msg.position);
        break;

      case 'CHAT_MSG':
        this.emit('chat_msg', domainBot.id, msg.username, msg.message);
        break;

      case 'CHESTS_PLACED':
        this.emit('chests_placed', domainBot.id, msg.label, msg.positions);
        break;

      case 'LOG': {
        const prefix = `[${domainBot.username}]`;
        if (msg.level === 'error') process.stderr.write(`${prefix} ${msg.message}\n`);
        else if (msg.level === 'warn')  process.stdout.write(`\x1b[33m${prefix} ${msg.message}\x1b[0m\n`);
        else                            process.stdout.write(`${prefix} ${msg.message}\n`);
        break;
      }
    }
  }

  disconnect(domainBot: Bot): void {
    this.send(domainBot.id, { type: 'STOP' });
    domainBot.setState(BotState.DISCONNECTED);
  }

  getMode(bot: Bot): string {
    return this.snapshots.get(bot.id)?.mode ?? 'idle';
  }

  getSnapshot(botId: string): BotSnapshot | undefined {
    return this.snapshots.get(botId);
  }

  // ── Internal send helpers ─────────────────────────────────────────────────

  private send(botId: string, msg: MainToWorkerMsg): void {
    this.workers.get(botId)?.postMessage(msg);
  }

  private nextReqId(): string {
    return `r${++this.reqCounter}`;
  }

  private sendAsync<T = void>(botId: string, buildMsg: (reqId: string) => MainToWorkerMsg): Promise<T> {
    const reqId = this.nextReqId();
    return new Promise<T>((resolve, reject) => {
      const worker = this.workers.get(botId);
      if (!worker) {
        reject(new Error(`bot worker not found: ${botId}`));
        return;
      }

      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`command timeout after ${WorkerCommandAdapter.CMD_TIMEOUT_MS}ms`));
      }, WorkerCommandAdapter.CMD_TIMEOUT_MS);

      this.pending.set(reqId, {
        botId,
        timeout,
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      this.send(botId, buildMsg(reqId));
    });
  }

  // ── Movement ──────────────────────────────────────────────────────────────

  moveTo(bot: Bot, x: number, y: number, z: number): Promise<void> {
    return this.sendAsync(bot.id, reqId => ({ type: 'CMD_MOVE_TO', reqId, x, y, z }));
  }

  follow(bot: Bot, targetUsername: string): void {
    this.send(bot.id, { type: 'CMD_FOLLOW', username: targetUsername });
  }

  stop(bot: Bot): void {
    this.send(bot.id, { type: 'CMD_STOP' });
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  say(bot: Bot, message: string): void {
    this.send(bot.id, { type: 'CMD_SAY', message });
  }

  // ── Combat ────────────────────────────────────────────────────────────────

  attack(bot: Bot, targetUsername: string): void {
    this.send(bot.id, { type: 'CMD_ATTACK', username: targetUsername });
  }

  pvp(bot: Bot, targetUsernames: string[], _intel?: SwarmIntel, _rel?: PlayerRelationshipStore): void {
    this.send(bot.id, { type: 'CMD_PVP', usernames: targetUsernames });
  }

  stopPvp(bot: Bot): void {
    this.send(bot.id, { type: 'CMD_STOP_PVP' });
  }

  guard(bot: Bot, x: number, y: number, z: number, radius: number, excludeUsernames: string[], _rel?: PlayerRelationshipStore): void {
    this.send(bot.id, { type: 'CMD_GUARD', x, y, z, radius, excludeUsernames });
  }

  stopGuard(bot: Bot): void {
    this.send(bot.id, { type: 'CMD_STOP_GUARD' });
  }

  bodyguard(bot: Bot, protectedUsername: string, radius: number, swarmUsernames: string[], _rel?: PlayerRelationshipStore, _intel?: SwarmIntel): void {
    this.send(bot.id, { type: 'CMD_BODYGUARD', protectedUsername, radius, swarmUsernames });
  }

  startDefend(bot: Bot, radius: number): void {
    this.send(bot.id, { type: 'CMD_DEFEND', radius });
  }

  stopDefend(bot: Bot): void {
    this.send(bot.id, { type: 'CMD_STOP_DEFEND' });
  }

  avoid(bot: Bot, targetUsernames: string[], triggerRadius: number): void {
    this.send(bot.id, { type: 'CMD_AVOID', usernames: targetUsernames, radius: triggerRadius });
  }

  stopAvoid(bot: Bot): void {
    this.send(bot.id, { type: 'CMD_STOP_AVOID' });
  }

  // ── Resources ─────────────────────────────────────────────────────────────

  collect(bot: Bot, blockName: string, count: number, _onFull?: DepositFn): Promise<void> {
    return this.sendAsync(bot.id, reqId => ({ type: 'CMD_COLLECT', reqId, blockName, count }));
  }

  collectVein(bot: Bot, blockName: string, count: number, _onFull?: DepositFn): Promise<void> {
    return this.sendAsync(bot.id, reqId => ({ type: 'CMD_COLLECT_VEIN', reqId, blockName, count }));
  }

  quarryFromQueue(_bot: Bot, _queue: QuarryQueue, _onFull?: DepositFn): Promise<void> {
    // TODO: serialize quarry regions and dispatch
    return Promise.resolve();
  }

  depositAll(bot: Bot, chestPos: Vec3): Promise<void> {
    return this.sendAsync(bot.id, reqId => ({
      type: 'CMD_DEPOSIT_ALL', reqId,
      chestPos: { x: chestPos.x, y: chestPos.y, z: chestPos.z },
    }));
  }

  withdraw(bot: Bot, chestPos: Vec3, itemName: string, count: number): Promise<number> {
    return this.sendAsync<number>(bot.id, reqId => ({
      type: 'CMD_WITHDRAW', reqId,
      chestPos: { x: chestPos.x, y: chestPos.y, z: chestPos.z },
      itemName, count,
    }));
  }

  // ── Building ──────────────────────────────────────────────────────────────

  buildFromQueue(_bot: Bot, _queue: BuildQueue): Promise<void> {
    // TODO: serialize build blocks and dispatch
    return Promise.resolve();
  }

  // ── Inventory ─────────────────────────────────────────────────────────────

  equip(bot: Bot, itemName: string): Promise<void> {
    return this.sendAsync(bot.id, reqId => ({ type: 'CMD_EQUIP', reqId, itemName }));
  }

  eat(bot: Bot): Promise<void> {
    return this.sendAsync(bot.id, reqId => ({ type: 'CMD_EAT', reqId }));
  }

  // ── Farm / Explore ────────────────────────────────────────────────────────

  farm(bot: Bot, centerX: number, centerZ: number, radius: number): Promise<void> {
    this.send(bot.id, { type: 'CMD_FARM', centerX, centerZ, radius });
    return Promise.resolve();
  }

  stopFarm(bot: Bot): void {
    this.send(bot.id, { type: 'CMD_STOP_FARM' });
  }

  explore(bot: Bot, direction: 'north' | 'south' | 'east' | 'west' | 'auto'): Promise<void> {
    this.send(bot.id, { type: 'CMD_EXPLORE', direction });
    return Promise.resolve();
  }

  stopExplore(bot: Bot): void {
    this.send(bot.id, { type: 'CMD_STOP_EXPLORE' });
  }

  // ── Orchestrator API ──────────────────────────────────────────────────────

  assignTask(botId: string, descriptor: TaskDescriptor): void {
    this.send(botId, { type: 'ASSIGN_TASK', descriptor });
  }

  cancelTask(botId: string): void {
    this.send(botId, { type: 'CANCEL_TASK' });
  }

  /**
   * Send one bot to a position, scan for nearby chest/barrel blocks, and return
   * their coordinates. The caller (CommandListener) then registers them in StorageCache.
   */
  scanStorage(botId: string, x: number, y: number, z: number, radius: number): Promise<Array<{ x: number; y: number; z: number }>> {
    return this.sendAsync<Array<{ x: number; y: number; z: number }>>(
      botId,
      reqId => ({ type: 'CMD_SCAN_STORAGE', reqId, x, y, z, radius }),
    );
  }

  /** Push the current swarm username list to all workers (for bodyguard/guard exclusion). */
  broadcastSwarmUsernames(usernames: string[]): void {
    for (const botId of this.workers.keys()) {
      this.send(botId, { type: 'SWARM_USERNAMES', usernames });
    }
  }
}
