"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseProxyLine = parseProxyLine;
function parseProxyLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#'))
        return null;
    if (!trimmed.startsWith('socks5://'))
        return null;
    return { url: trimmed };
}
//# sourceMappingURL=ProxyConfig.js.map