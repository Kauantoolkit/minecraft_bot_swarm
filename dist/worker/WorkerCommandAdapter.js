"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerCommandAdapter = void 0;
const path_1 = __importDefault(require("path"));
const worker_threads_1 = require("worker_threads");
const events_1 = require("events");
const BotState_1 = require("../domain/value-objects/BotState");
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
class WorkerCommandAdapter extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.workers = new Map();
        this.snapshots = new Map();
        this.reqCounter = 0;
        this.pending = new Map();
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    spawn(domainBot, options) {
        return new Promise((resolve, reject) => {
            // Support both ts-node (dev) and compiled (prod) environments
            const isTs = __filename.endsWith('.ts');
            const workerFile = isTs ? 'BotWorker.ts' : 'BotWorker.js';
            const workerPath = path_1.default.join(__dirname, workerFile);
            const workerOptions = {
                workerData: {
                    botId: domainBot.id,
                    username: domainBot.username,
                    proxyUrl: domainBot.proxy?.url,
                    server: {
                        host: options.host,
                        port: options.port,
                        version: options.version,
                    },
                },
                ...(isTs && { execArgv: ['--require', 'ts-node/register'] }),
            };
            const worker = new worker_threads_1.Worker(workerPath, workerOptions);
            this.workers.set(domainBot.id, worker);
            domainBot.setState(BotState_1.BotState.CONNECTING);
            let settled = false;
            const settle = (fn) => { if (!settled) {
                settled = true;
                fn();
            } };
            worker.on('message', (msg) => {
                // Route to the general handler for every message
                this.handleMessage(domainBot, msg);
                // Also handle the spawn promise
                if (!settled) {
                    if (msg.type === 'READY')
                        settle(resolve);
                    else if (msg.type === 'ERROR')
                        settle(() => reject(new Error(msg.error)));
                }
            });
            worker.on('error', err => {
                settle(() => reject(err));
                console.error(`[WorkerAdapter] Worker for ${domainBot.username} threw: ${err.message}`);
            });
            worker.on('exit', code => {
                this.workers.delete(domainBot.id);
                domainBot.setState(BotState_1.BotState.DISCONNECTED);
                if (code !== 0)
                    settle(() => reject(new Error(`Worker exited with code ${code}`)));
            });
        });
    }
    handleMessage(domainBot, msg) {
        switch (msg.type) {
            case 'STATE_UPDATE':
                this.snapshots.set(domainBot.id, msg.snapshot);
                domainBot.setState(msg.snapshot.connected ? BotState_1.BotState.CONNECTED : BotState_1.BotState.DISCONNECTED);
                this.emit('state_update', domainBot.id, msg.snapshot);
                break;
            case 'DISCONNECTED':
                domainBot.setState(BotState_1.BotState.DISCONNECTED);
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
                if (msg.level === 'error')
                    process.stderr.write(`${prefix} ${msg.message}\n`);
                else if (msg.level === 'warn')
                    process.stdout.write(`\x1b[33m${prefix} ${msg.message}\x1b[0m\n`);
                else
                    process.stdout.write(`${prefix} ${msg.message}\n`);
                break;
            }
        }
    }
    disconnect(domainBot) {
        this.send(domainBot.id, { type: 'STOP' });
        domainBot.setState(BotState_1.BotState.DISCONNECTED);
    }
    getMode(bot) {
        return this.snapshots.get(bot.id)?.mode ?? 'idle';
    }
    getSnapshot(botId) {
        return this.snapshots.get(botId);
    }
    // ── Internal send helpers ─────────────────────────────────────────────────
    send(botId, msg) {
        this.workers.get(botId)?.postMessage(msg);
    }
    nextReqId() {
        return `r${++this.reqCounter}`;
    }
    sendAsync(botId, buildMsg) {
        const reqId = this.nextReqId();
        return new Promise((resolve, reject) => {
            this.pending.set(reqId, { resolve: resolve, reject });
            this.send(botId, buildMsg(reqId));
        });
    }
    // ── Movement ──────────────────────────────────────────────────────────────
    moveTo(bot, x, y, z) {
        return this.sendAsync(bot.id, reqId => ({ type: 'CMD_MOVE_TO', reqId, x, y, z }));
    }
    follow(bot, targetUsername) {
        this.send(bot.id, { type: 'CMD_FOLLOW', username: targetUsername });
    }
    stop(bot) {
        this.send(bot.id, { type: 'CMD_STOP' });
    }
    // ── Chat ──────────────────────────────────────────────────────────────────
    say(bot, message) {
        this.send(bot.id, { type: 'CMD_SAY', message });
    }
    // ── Combat ────────────────────────────────────────────────────────────────
    attack(bot, targetUsername) {
        this.send(bot.id, { type: 'CMD_ATTACK', username: targetUsername });
    }
    pvp(bot, targetUsernames, _intel, _rel) {
        this.send(bot.id, { type: 'CMD_PVP', usernames: targetUsernames });
    }
    stopPvp(bot) {
        this.send(bot.id, { type: 'CMD_STOP_PVP' });
    }
    guard(bot, x, y, z, radius, excludeUsernames, _rel) {
        this.send(bot.id, { type: 'CMD_GUARD', x, y, z, radius, excludeUsernames });
    }
    stopGuard(bot) {
        this.send(bot.id, { type: 'CMD_STOP_GUARD' });
    }
    bodyguard(bot, protectedUsername, radius, swarmUsernames, _rel, _intel) {
        this.send(bot.id, { type: 'CMD_BODYGUARD', protectedUsername, radius, swarmUsernames });
    }
    startDefend(bot, radius) {
        this.send(bot.id, { type: 'CMD_DEFEND', radius });
    }
    stopDefend(bot) {
        this.send(bot.id, { type: 'CMD_STOP_DEFEND' });
    }
    avoid(bot, targetUsernames, triggerRadius) {
        this.send(bot.id, { type: 'CMD_AVOID', usernames: targetUsernames, radius: triggerRadius });
    }
    stopAvoid(bot) {
        this.send(bot.id, { type: 'CMD_STOP_AVOID' });
    }
    // ── Resources ─────────────────────────────────────────────────────────────
    collect(bot, blockName, count, _onFull) {
        return this.sendAsync(bot.id, reqId => ({ type: 'CMD_COLLECT', reqId, blockName, count }));
    }
    collectVein(bot, blockName, count, _onFull) {
        return this.sendAsync(bot.id, reqId => ({ type: 'CMD_COLLECT_VEIN', reqId, blockName, count }));
    }
    quarryFromQueue(_bot, _queue, _onFull) {
        // TODO: serialize quarry regions and dispatch
        return Promise.resolve();
    }
    depositAll(bot, chestPos) {
        return this.sendAsync(bot.id, reqId => ({
            type: 'CMD_DEPOSIT_ALL', reqId,
            chestPos: { x: chestPos.x, y: chestPos.y, z: chestPos.z },
        }));
    }
    withdraw(bot, chestPos, itemName, count) {
        return this.sendAsync(bot.id, reqId => ({
            type: 'CMD_WITHDRAW', reqId,
            chestPos: { x: chestPos.x, y: chestPos.y, z: chestPos.z },
            itemName, count,
        }));
    }
    // ── Building ──────────────────────────────────────────────────────────────
    buildFromQueue(_bot, _queue) {
        // TODO: serialize build blocks and dispatch
        return Promise.resolve();
    }
    // ── Inventory ─────────────────────────────────────────────────────────────
    equip(bot, itemName) {
        return this.sendAsync(bot.id, reqId => ({ type: 'CMD_EQUIP', reqId, itemName }));
    }
    eat(bot) {
        return this.sendAsync(bot.id, reqId => ({ type: 'CMD_EAT', reqId }));
    }
    // ── Farm / Explore ────────────────────────────────────────────────────────
    farm(bot, centerX, centerZ, radius) {
        this.send(bot.id, { type: 'CMD_FARM', centerX, centerZ, radius });
        return Promise.resolve();
    }
    stopFarm(bot) {
        this.send(bot.id, { type: 'CMD_STOP_FARM' });
    }
    explore(bot, direction) {
        this.send(bot.id, { type: 'CMD_EXPLORE', direction });
        return Promise.resolve();
    }
    stopExplore(bot) {
        this.send(bot.id, { type: 'CMD_STOP_EXPLORE' });
    }
    // ── Orchestrator API ──────────────────────────────────────────────────────
    assignTask(botId, descriptor) {
        this.send(botId, { type: 'ASSIGN_TASK', descriptor });
    }
    cancelTask(botId) {
        this.send(botId, { type: 'CANCEL_TASK' });
    }
    /**
     * Send one bot to a position, scan for nearby chest/barrel blocks, and return
     * their coordinates. The caller (CommandListener) then registers them in StorageCache.
     */
    scanStorage(botId, x, y, z, radius) {
        return this.sendAsync(botId, reqId => ({ type: 'CMD_SCAN_STORAGE', reqId, x, y, z, radius }));
    }
    /** Push the current swarm username list to all workers (for bodyguard/guard exclusion). */
    broadcastSwarmUsernames(usernames) {
        for (const botId of this.workers.keys()) {
            this.send(botId, { type: 'SWARM_USERNAMES', usernames });
        }
    }
}
exports.WorkerCommandAdapter = WorkerCommandAdapter;
//# sourceMappingURL=WorkerCommandAdapter.js.map