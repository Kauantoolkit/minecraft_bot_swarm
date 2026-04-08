"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuildQueue = void 0;
class BuildQueue {
    constructor() {
        this.pending = [];
        this.deferred = [];
        this.missingBlocks = new Set();
        this.completed = 0;
        this._total = 0;
    }
    load(tasks) {
        this.pending = [...tasks];
        this.deferred = [];
        this.missingBlocks.clear();
        this.completed = 0;
        this._total = tasks.length;
        console.log(`[BuildQueue] Loaded ${this._total} block tasks`);
    }
    next() {
        const task = this.pending.shift();
        if (task)
            this.completed++;
        return task;
    }
    /** Put a task back because the bot lacks the block — saves the missing type. */
    deferTask(task, missingBlockName) {
        this.deferred.push(task);
        this.missingBlocks.add(missingBlockName);
        this.completed--; // undo the count from next()
    }
    /** Move deferred tasks back to pending for another pass. Returns count moved. */
    restoreDeferred() {
        const count = this.deferred.length;
        this.pending.push(...this.deferred);
        this.deferred = [];
        this.missingBlocks.clear();
        return count;
    }
    getMissingBlocks() {
        return Array.from(this.missingBlocks);
    }
    hasDeferredTasks() {
        return this.deferred.length > 0;
    }
    isEmpty() {
        return this.pending.length === 0;
    }
    clear() {
        this.pending = [];
        this.deferred = [];
    }
    get remaining() {
        return this.pending.length + this.deferred.length;
    }
    get total() {
        return this._total;
    }
    get progress() {
        return `${this.completed}/${this._total}`;
    }
}
exports.BuildQueue = BuildQueue;
//# sourceMappingURL=BuildQueue.js.map