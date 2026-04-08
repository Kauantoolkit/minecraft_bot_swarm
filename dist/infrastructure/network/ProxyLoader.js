"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyLoader = void 0;
const fs_1 = __importDefault(require("fs"));
const ProxyConfig_1 = require("../../domain/value-objects/ProxyConfig");
class ProxyLoader {
    constructor() {
        this.proxies = [];
        this.cursor = 0;
    }
    load(filePath) {
        if (!fs_1.default.existsSync(filePath)) {
            console.warn(`[ProxyLoader] File not found: ${filePath}. Running without proxies.`);
            return;
        }
        const lines = fs_1.default.readFileSync(filePath, 'utf-8').split('\n');
        this.proxies = lines.map(ProxyConfig_1.parseProxyLine).filter((p) => p !== null);
        console.log(`[ProxyLoader] Loaded ${this.proxies.length} proxies from ${filePath}`);
    }
    next() {
        if (this.proxies.length === 0)
            return undefined;
        const proxy = this.proxies[this.cursor % this.proxies.length];
        this.cursor++;
        return proxy;
    }
    hasProxies() {
        return this.proxies.length > 0;
    }
    count() {
        return this.proxies.length;
    }
}
exports.ProxyLoader = ProxyLoader;
//# sourceMappingURL=ProxyLoader.js.map