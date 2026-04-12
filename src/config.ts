import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  server: {
    host: requireEnv('MC_HOST', 'localhost'),
    port: parseInt(requireEnv('MC_PORT', '25565'), 10),
    // 'auto' disables version-check and lets mineflayer negotiate automatically
    version: requireEnv('MC_VERSION', 'auto'),
  },
  swarm: {
    botCount: parseInt(requireEnv('BOT_COUNT', '10'), 10),
    usernamePrefix: requireEnv('BOT_USERNAME_PREFIX', 'SwarmBot'),
    spawnDelayMs: parseInt(requireEnv('BOT_SPAWN_DELAY_MS', '15'), 10),
  },
  connection: {
    mode: requireEnv('CONNECTION_MODE', 'direct') as 'direct' | 'proxy',
    proxyFile: path.resolve(process.cwd(), requireEnv('PROXY_FILE', 'proxies.txt')),
  },
  master: {
    username: requireEnv('MASTER_USERNAME', 'Herobrine'),
  },
  web: {
    port: parseInt(requireEnv('WEB_PORT', '3000'), 10),
  },
} as const;

/** Directory where all instance-specific data is persisted (storages, groups, relationships).
 *  Set MC_INSTANCE in .env to isolate data per world (e.g. MC_INSTANCE=survival).
 *  Falls back to host_port if not set. */
const instanceKey = process.env.MC_INSTANCE?.trim() || `${config.server.host}_${config.server.port}`;
export const instanceDataDir = path.resolve(process.cwd(), 'data', instanceKey);

fs.mkdirSync(instanceDataDir, { recursive: true });
