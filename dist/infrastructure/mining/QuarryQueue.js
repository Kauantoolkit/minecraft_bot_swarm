"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuarryQueue = void 0;
const vec3_1 = require("vec3");
class QuarryQueue {
    constructor() {
        this.positions = [];
        this.completed = 0;
        this._total = 0;
    }
    /** Fill queue with every block position inside the bounding box. */
    load(x1, y1, z1, x2, y2, z2) {
        this.positions = [];
        this.completed = 0;
        const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
        const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
        // Layer-by-layer top-down so the bot never mines its own floor
        for (let y = maxY; y >= minY; y--) {
            for (let x = minX; x <= maxX; x++) {
                for (let z = minZ; z <= maxZ; z++) {
                    this.positions.push(new vec3_1.Vec3(x, y, z));
                }
            }
        }
        this._total = this.positions.length;
        console.log(`[QuarryQueue] ${this._total} blocks to mine (${maxX - minX + 1}x${maxY - minY + 1}x${maxZ - minZ + 1})`);
    }
    next() {
        return this.positions.shift();
    }
    /** Return a position to the front so another bot can retry it. */
    putBack(pos) {
        this.positions.unshift(pos);
    }
    /** Call after a block is successfully mined to advance progress counter. */
    markDone() {
        this.completed++;
    }
    isEmpty() { return this.positions.length === 0; }
    get remaining() { return this.positions.length; }
    get total() { return this._total; }
    get progress() { return `${this.completed}/${this._total}`; }
    clear() { this.positions = []; }
}
exports.QuarryQueue = QuarryQueue;
//# sourceMappingURL=QuarryQueue.js.map