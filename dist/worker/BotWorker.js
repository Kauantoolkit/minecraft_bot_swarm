"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * BotWorker — runs inside a Node.js worker_thread.
 *
 * One instance per bot. Owns:
 *   - The mineflayer connection
 *   - A local MineflayerAdapter
 *   - A TaskRunner for Orchestrator-assigned tasks
 *
 * Communicates with the main thread via parentPort using the typed
 * message protocol defined in src/ipc/messages.ts.
 */
const worker_threads_1 = require("worker_threads");
const socks_proxy_agent_1 = require("socks-proxy-agent");
const Bot_1 = require("../domain/entities/Bot");
const MineflayerAdapter_1 = require("../infrastructure/mineflayer/MineflayerAdapter");
const StorageBehavior_1 = require("../infrastructure/mineflayer/behaviors/StorageBehavior");
const TaskRunner_1 = require("../tasks/TaskRunner");
const vec3_1 = require("vec3");
if (worker_threads_1.isMainThread) {
    throw new Error('BotWorker must be loaded as a Worker thread, not in the main thread.');
}
const data = worker_threads_1.workerData;
const port = worker_threads_1.parentPort;
// ── Helpers ───────────────────────────────────────────────────────────────────
function send(msg) {
    port.postMessage(msg);
}
// Route console output through the log channel so the main thread can prefix
// lines with the bot username and keep stdout coherent.
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);
console.log = (...args) => send({ type: 'LOG', level: 'info', message: args.join(' ') });
console.warn = (...args) => send({ type: 'LOG', level: 'warn', message: args.join(' ') });
console.error = (...args) => send({ type: 'LOG', level: 'error', message: args.join(' ') });
// ── Bot state ─────────────────────────────────────────────────────────────────
const domainBot = new Bot_1.Bot({ id: data.botId, username: data.username, proxy: data.proxyUrl ? { url: data.proxyUrl } : undefined });
const adapter = new MineflayerAdapter_1.MineflayerAdapter();
const storageBehavior = new StorageBehavior_1.StorageBehavior();
// When a build_storage task finishes placing chests, report positions to main
// thread so it can register them in StorageCache.
const tasks = new TaskRunner_1.TaskRunner(adapter, domainBot, (label, positions) => {
    send({ type: 'CHESTS_PLACED', label, positions });
});
// ── Snapshot helper ───────────────────────────────────────────────────────────
function snapshot() {
    const mfBot = domainBot.handle;
    const inventory = [];
    if (mfBot) {
        for (const item of mfBot.inventory.items()) {
            const existing = inventory.find(i => i.name === item.name);
            if (existing)
                existing.count += item.count;
            else
                inventory.push({ name: item.name, count: item.count });
        }
    }
    const pos = mfBot?.entity?.position;
    return {
        botId: data.botId,
        username: data.username,
        health: mfBot?.health ?? 0,
        food: mfBot?.food ?? 0,
        position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
        inventory,
        mode: adapter.getMode(domainBot),
        role: 'unassigned', // Orchestrator overrides this in GlobalState
        currentTaskId: tasks.currentTaskId,
        taskStatus: tasks.status,
        connected: domainBot.isOnline(),
    };
}
// ── Spawn ─────────────────────────────────────────────────────────────────────
async function boot() {
    try {
        let agent;
        if (data.proxyUrl) {
            agent = new socks_proxy_agent_1.SocksProxyAgent(data.proxyUrl);
        }
        await adapter.spawn(domainBot, {
            host: data.server.host,
            port: data.server.port,
            version: data.server.version,
            username: data.username,
            agent,
        });
        // Attach in-game chat forwarding
        const mfBot = domainBot.handle;
        mfBot.on('chat', (username, message) => {
            send({ type: 'CHAT_MSG', username, message });
        });
        send({ type: 'READY' });
        // Periodic state push (~1 Hz)
        setInterval(() => {
            if (domainBot.isOnline())
                send({ type: 'STATE_UPDATE', snapshot: snapshot() });
        }, 1000);
    }
    catch (err) {
        send({ type: 'ERROR', error: err.message });
    }
}
// ── Message dispatch ──────────────────────────────────────────────────────────
port.on('message', async (msg) => {
    switch (msg.type) {
        // ── Lifecycle ────────────────────────────────────────────────────────────
        case 'STOP':
            adapter.disconnect(domainBot);
            process.exit(0);
            break;
        // ── Operator commands — fire and forget ───────────────────────────────────
        case 'CMD_FOLLOW':
            adapter.follow(domainBot, msg.username);
            break;
        case 'CMD_STOP':
            tasks.cancel();
            adapter.stop(domainBot);
            break;
        case 'CMD_SAY':
            adapter.say(domainBot, msg.message);
            break;
        case 'CMD_ATTACK':
            adapter.attack(domainBot, msg.username);
            break;
        case 'CMD_PVP':
            adapter.pvp(domainBot, msg.usernames);
            break;
        case 'CMD_STOP_PVP':
            adapter.stopPvp(domainBot);
            break;
        case 'CMD_STOP_GUARD':
            adapter.stopGuard(domainBot);
            break;
        case 'CMD_DEFEND':
            adapter.startDefend(domainBot, msg.radius);
            break;
        case 'CMD_STOP_DEFEND':
            adapter.stopDefend(domainBot);
            break;
        case 'CMD_AVOID':
            adapter.avoid(domainBot, msg.usernames, msg.radius);
            break;
        case 'CMD_STOP_AVOID':
            adapter.stopAvoid(domainBot);
            break;
        case 'CMD_STOP_FARM':
            adapter.stopFarm(domainBot);
            break;
        case 'CMD_STOP_EXPLORE':
            adapter.stopExplore(domainBot);
            break;
        case 'CMD_GUARD':
            adapter.guard(domainBot, msg.x, msg.y, msg.z, msg.radius, msg.excludeUsernames);
            break;
        case 'CMD_BODYGUARD':
            adapter.bodyguard(domainBot, msg.protectedUsername, msg.radius, msg.swarmUsernames);
            break;
        case 'CMD_FARM':
            adapter.farm(domainBot, msg.centerX, msg.centerZ, msg.radius).catch(() => { });
            break;
        case 'CMD_EXPLORE':
            adapter.explore(domainBot, msg.direction).catch(() => { });
            break;
        // ── Operator commands — async (reply with CMD_RESULT) ─────────────────────
        case 'CMD_MOVE_TO':
            adapter.moveTo(domainBot, msg.x, msg.y, msg.z)
                .then(() => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true }))
                .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
            break;
        case 'CMD_COLLECT': {
            const chestPos = msg.chestPos;
            const onFull = chestPos
                ? async () => { await adapter.depositAll(domainBot, new vec3_1.Vec3(chestPos.x, chestPos.y, chestPos.z)); }
                : undefined;
            adapter.collect(domainBot, msg.blockName, msg.count, onFull)
                .then(() => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true }))
                .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
            break;
        }
        case 'CMD_COLLECT_VEIN': {
            const chestPos = msg.chestPos;
            const onFull = chestPos
                ? async () => { await adapter.depositAll(domainBot, new vec3_1.Vec3(chestPos.x, chestPos.y, chestPos.z)); }
                : undefined;
            adapter.collectVein(domainBot, msg.blockName, msg.count, onFull)
                .then(() => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true }))
                .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
            break;
        }
        case 'CMD_DEPOSIT_ALL':
            adapter.depositAll(domainBot, new vec3_1.Vec3(msg.chestPos.x, msg.chestPos.y, msg.chestPos.z))
                .then(() => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true }))
                .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
            break;
        case 'CMD_WITHDRAW':
            adapter.withdraw(domainBot, new vec3_1.Vec3(msg.chestPos.x, msg.chestPos.y, msg.chestPos.z), msg.itemName, msg.count)
                .then(n => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true, value: n }))
                .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
            break;
        case 'CMD_EQUIP':
            adapter.equip(domainBot, msg.itemName)
                .then(() => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true }))
                .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
            break;
        case 'CMD_EAT':
            adapter.eat(domainBot)
                .then(() => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true }))
                .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
            break;
        // ── Task assignments from Orchestrator ────────────────────────────────────
        case 'ASSIGN_TASK':
            tasks.run(msg.descriptor)
                .then(() => send({ type: 'TASK_COMPLETE', taskId: msg.descriptor.id }))
                .catch(err => {
                if (err.message !== 'cancelled') {
                    send({ type: 'TASK_FAILED', taskId: msg.descriptor.id, error: err.message, retryable: true });
                }
            });
            break;
        case 'CANCEL_TASK':
            tasks.cancel();
            break;
        // ── Intel ──────────────────────────────────────────────────────────────────
        case 'SWARM_USERNAMES':
            // Stored locally for future use (e.g. guard exclusion lists)
            break;
        case 'PLAYER_SPOTTED':
            // No-op for now — workers react to their own perception
            break;
        case 'CMD_SCAN_STORAGE':
            storageBehavior.scanNearbyChests(domainBot, msg.x, msg.y, msg.z, msg.radius)
                .then(positions => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true, value: positions }))
                .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
            break;
    }
});
// ── Entry ─────────────────────────────────────────────────────────────────────
boot();
//# sourceMappingURL=BotWorker.js.map