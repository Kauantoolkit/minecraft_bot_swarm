import path from 'path';
import dotenv from 'dotenv';

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
    spawnDelayMs: parseInt(requireEnv('BOT_SPAWN_DELAY_MS', '1500'), 10),
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
