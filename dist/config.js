"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function requireEnv(key, fallback) {
    const value = process.env[key] ?? fallback;
    if (value === undefined) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}
exports.config = {
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
        mode: requireEnv('CONNECTION_MODE', 'direct'),
        proxyFile: path_1.default.resolve(process.cwd(), requireEnv('PROXY_FILE', 'proxies.txt')),
    },
    master: {
        username: requireEnv('MASTER_USERNAME', 'Herobrine'),
    },
    web: {
        port: parseInt(requireEnv('WEB_PORT', '3000'), 10),
    },
};
//# sourceMappingURL=config.js.map