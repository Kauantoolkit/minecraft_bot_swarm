"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = sleep;
exports.ts = ts;
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
/** Returns current time as HH:MM:SS.mmm — used in log messages across all behaviors. */
function ts() {
    const d = new Date();
    return (String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0') + '.' +
        String(d.getMilliseconds()).padStart(3, '0'));
}
//# sourceMappingURL=utils.js.map