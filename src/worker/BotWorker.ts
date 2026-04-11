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
import { parentPort, workerData, isMainThread } from 'worker_threads';
import { Bot as MineflayerBot } from 'mineflayer';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Bot } from '../domain/entities/Bot';
import { MineflayerAdapter } from '../infrastructure/mineflayer/MineflayerAdapter';
import { StorageBehavior } from '../infrastructure/mineflayer/behaviors/StorageBehavior';
import { TaskRunner } from '../tasks/TaskRunner';
import { Vec3 } from 'vec3';
import type {
  BotWorkerData,
  MainToWorkerMsg,
  WorkerToMainMsg,
  BotSnapshot,
  ItemSummary,
} from '../ipc/messages';

if (isMainThread) {
  throw new Error('BotWorker must be loaded as a Worker thread, not in the main thread.');
}

const data = workerData as BotWorkerData;
const port = parentPort!;

function send(msg: WorkerToMainMsg): void {
  port.postMessage(msg);
}

// Route console output through the log channel so the main thread can prefix
// lines with the bot username and keep stdout coherent.
const origError = console.error.bind(console);

console.log = (...args: unknown[]) =>
  send({ type: 'LOG', level: 'info', message: args.join(' ') });
console.warn = (...args: unknown[]) =>
  send({ type: 'LOG', level: 'warn', message: args.join(' ') });
console.error = (...args: unknown[]) =>
  send({ type: 'LOG', level: 'error', message: args.join(' ') });

const domainBot = new Bot({
  id: data.botId,
  username: data.username,
  proxy: data.proxyUrl ? { url: data.proxyUrl } : undefined,
});
const adapter = new MineflayerAdapter();
const storageBehavior = new StorageBehavior();
const tasks = new TaskRunner(adapter, domainBot, (label, positions) => {
  send({ type: 'CHESTS_PLACED', label, positions });
});

let readySent = false;
let hasConnectedOnce = false;
let shuttingDown = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(): BotSnapshot {
  const mfBot = domainBot.handle as MineflayerBot | null;

  const inventory: ItemSummary[] = [];
  if (mfBot) {
    for (const item of mfBot.inventory.items() as Array<{ name: string; count: number }>) {
      const existing = inventory.find(i => i.name === item.name);
      if (existing) existing.count += item.count;
      else inventory.push({ name: item.name, count: item.count });
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
    role: 'unassigned',
    currentTaskId: tasks.currentTaskId,
    taskStatus: tasks.status,
    connected: domainBot.isOnline(),
  };
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(reason: string): void {
  if (shuttingDown || reconnectTimer) return;

  reconnectAttempt++;
  const delayMs = Math.min(30_000, reconnectAttempt * 2000);

  send({
    type: 'LOG',
    level: 'warn',
    message: `Disconnected (${reason}) - reconnect in ${delayMs}ms (attempt ${reconnectAttempt})`,
  });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
}

function attachRuntimeListeners(mfBot: MineflayerBot): void {
  mfBot.on('chat', (username: string, message: string) => {
    send({ type: 'CHAT_MSG', username, message });
  });

  mfBot.once('kicked', (reason: string) => {
    send({ type: 'DISCONNECTED', reason: `kicked: ${reason}` });
    scheduleReconnect(`kicked: ${reason}`);
  });

  mfBot.once('end', (reason: string) => {
    send({ type: 'DISCONNECTED', reason: `end: ${reason}` });
    scheduleReconnect(`end: ${reason}`);
  });

  mfBot.on('error', (err: Error) => {
    send({ type: 'LOG', level: 'warn', message: `runtime error: ${err.message}` });
  });
}

async function connect(): Promise<void> {
  try {
    let agent: SocksProxyAgent | undefined;
    if (data.proxyUrl) {
      agent = new SocksProxyAgent(data.proxyUrl);
    }

    await adapter.spawn(domainBot, {
      host: data.server.host,
      port: data.server.port,
      version: data.server.version,
      username: data.username,
      agent,
    });

    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) throw new Error('spawned without mineflayer handle');

    attachRuntimeListeners(mfBot);

    reconnectAttempt = 0;
    hasConnectedOnce = true;

    if (!readySent) {
      readySent = true;
      send({ type: 'READY' });
    } else {
      send({ type: 'LOG', level: 'info', message: 'Reconnected to server' });
    }
  } catch (err) {
    const message = (err as Error).message;
    if (!hasConnectedOnce) {
      send({ type: 'ERROR', error: message });
      return;
    }
    scheduleReconnect(message);
  }
}

function runAsyncCommand(reqId: string, fn: () => Promise<unknown>): void {
  if (!domainBot.isOnline()) {
    send({ type: 'CMD_RESULT', reqId, success: false, error: 'bot offline' });
    return;
  }
  fn()
    .then(value => send({ type: 'CMD_RESULT', reqId, success: true, value }))
    .catch((e: Error) =>
      send({ type: 'CMD_RESULT', reqId, success: false, error: e.message }),
    );
}

// Periodic state push even while offline so the main thread can react.
setInterval(() => {
  send({ type: 'STATE_UPDATE', snapshot: snapshot() });
}, 1000);

port.on('message', (msg: MainToWorkerMsg) => {
  switch (msg.type) {
    case 'STOP':
      shuttingDown = true;
      clearReconnectTimer();
      tasks.cancel();
      adapter.disconnect(domainBot);
      process.exit(0);
      break;

    // Operator commands — fire and forget
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
      adapter.farm(domainBot, msg.centerX, msg.centerZ, msg.radius).catch(() => {});
      break;
    case 'CMD_EXPLORE':
      adapter.explore(domainBot, msg.direction).catch(() => {});
      break;

    // Operator commands — async
    case 'CMD_MOVE_TO':
      runAsyncCommand(msg.reqId, () => adapter.moveTo(domainBot, msg.x, msg.y, msg.z));
      break;

    case 'CMD_COLLECT': {
      const chestPos = msg.chestPos;
      const onFull = chestPos
        ? async () =>
            adapter.depositAll(domainBot, new Vec3(chestPos.x, chestPos.y, chestPos.z))
        : undefined;
      runAsyncCommand(msg.reqId, () =>
        adapter.collect(domainBot, msg.blockName, msg.count, onFull),
      );
      break;
    }

    case 'CMD_COLLECT_VEIN': {
      const chestPos = msg.chestPos;
      const onFull = chestPos
        ? async () =>
            adapter.depositAll(domainBot, new Vec3(chestPos.x, chestPos.y, chestPos.z))
        : undefined;
      runAsyncCommand(msg.reqId, () =>
        adapter.collectVein(domainBot, msg.blockName, msg.count, onFull),
      );
      break;
    }

    case 'CMD_DEPOSIT_ALL':
      runAsyncCommand(msg.reqId, () =>
        adapter.depositAll(domainBot, new Vec3(msg.chestPos.x, msg.chestPos.y, msg.chestPos.z)),
      );
      break;

    case 'CMD_WITHDRAW':
      runAsyncCommand(msg.reqId, () =>
        adapter.withdraw(
          domainBot,
          new Vec3(msg.chestPos.x, msg.chestPos.y, msg.chestPos.z),
          msg.itemName,
          msg.count,
        ),
      );
      break;

    case 'CMD_EQUIP':
      runAsyncCommand(msg.reqId, () => adapter.equip(domainBot, msg.itemName));
      break;

    case 'CMD_EAT':
      runAsyncCommand(msg.reqId, () => adapter.eat(domainBot));
      break;

    // Task assignments from Orchestrator
    case 'ASSIGN_TASK':
      if (!domainBot.isOnline()) {
        send({
          type: 'TASK_FAILED',
          taskId: msg.descriptor.id,
          error: 'bot offline',
          retryable: true,
        });
        break;
      }
      tasks
        .run(msg.descriptor)
        .then(() => send({ type: 'TASK_COMPLETE', taskId: msg.descriptor.id }))
        .catch(err => {
          if ((err as Error).message !== 'cancelled') {
            send({
              type: 'TASK_FAILED',
              taskId: msg.descriptor.id,
              error: (err as Error).message,
              retryable: true,
            });
          }
        });
      break;

    case 'CANCEL_TASK':
      tasks.cancel();
      break;

    // Intel
    case 'SWARM_USERNAMES':
      // Stored locally for future use (e.g. guard exclusion lists)
      break;

    case 'PLAYER_SPOTTED':
      // No-op for now — workers react to their own perception
      break;

    case 'CMD_SCAN_STORAGE':
      runAsyncCommand(msg.reqId, () =>
        storageBehavior.scanNearbyChests(domainBot, msg.x, msg.y, msg.z, msg.radius),
      );
      break;
  }
});

process.on('uncaughtException', err => {
  origError(`[BotWorker] uncaughtException: ${err.message}`);
  send({ type: 'ERROR', error: err.message });
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  origError(`[BotWorker] unhandledRejection: ${message}`);
  send({ type: 'ERROR', error: message });
  process.exit(1);
});

void connect();
