"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGlobalState = createGlobalState;
exports.applySnapshot = applySnapshot;
function createGlobalState() {
    return {
        bots: new Map(),
        storagePos: null,
        resources: new Map(),
        threats: new Set(),
        phase: 'bootstrap',
    };
}
/** Merge a fresh BotSnapshot into an existing BotRecord, preserving role/failCount. */
function applySnapshot(record, snap) {
    Object.assign(record, snap);
}
//# sourceMappingURL=GlobalState.js.map