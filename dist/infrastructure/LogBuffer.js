"use strict";
/**
 * Ring-buffer that captures all console output.
 * Call install() once at startup; after that every console.log/warn/error
 * is both printed to stdout AND stored for the web debug UI.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.install = install;
exports.recent = recent;
const MAX_ENTRIES = 300;
const entries = [];
function push(level, args) {
    const text = args
        .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
    entries.push({ level, text, time: Date.now() });
    if (entries.length > MAX_ENTRIES)
        entries.shift();
}
function install() {
    const orig = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };
    console.log = (...args) => { push('info', args); orig.log(...args); };
    console.warn = (...args) => { push('warn', args); orig.warn(...args); };
    console.error = (...args) => { push('error', args); orig.error(...args); };
}
/** Returns the most recent `n` entries, newest last. */
function recent(n = 100) {
    return entries.slice(-n);
}
//# sourceMappingURL=LogBuffer.js.map