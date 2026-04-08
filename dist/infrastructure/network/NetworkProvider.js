"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetworkProvider = void 0;
const socks_proxy_agent_1 = require("socks-proxy-agent");
const config_1 = require("../../config");
class NetworkProvider {
    buildConnectionOptions(username, proxy) {
        const rawVersion = config_1.config.server.version;
        const version = rawVersion === 'auto' ? false : rawVersion;
        const base = {
            host: config_1.config.server.host,
            port: config_1.config.server.port,
            version,
            username,
        };
        if (proxy) {
            console.log(`[NetworkProvider] ${username} -> PROXY ${proxy.url}`);
            base.agent = new socks_proxy_agent_1.SocksProxyAgent(proxy.url);
        }
        else {
            console.log(`[NetworkProvider] ${username} -> DIRECT ${base.host}:${base.port}`);
        }
        return base;
    }
}
exports.NetworkProvider = NetworkProvider;
//# sourceMappingURL=NetworkProvider.js.map