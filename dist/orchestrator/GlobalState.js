"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGlobalState = createGlobalState;
exports.applySnapshot = applySnapshot;
function createGlobalState() {
    return {
        bots: new Map(),
        basePos: null,
        storagePos: null,
        resources: new Map(),
        threats: new Set(),
        phase: 'bootstrap',
    };
}
/** Merge a fresh BotSnapshot into an existing BotRecord, preserving role/failCount. */
function applySnapshot(record, snap) {
    // Preserve orchestrator-owned fields — the worker always sends role:'unassigned'
    // and Object.assign would overwrite the role the orchestrator just assigned.
    const { role, failCount, lastTaskAt } = record;
    Object.assign(record, snap);
    record.role = role;
    record.failCount = failCount;
    record.lastTaskAt = lastTaskAt;
}
//# sourceMappingURL=GlobalState.js.map