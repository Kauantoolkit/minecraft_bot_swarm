import { Vec3 } from 'vec3';
export declare class QuarryQueue {
    private positions;
    private completed;
    private _total;
    /** Fill queue with every block position inside the bounding box. */
    load(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void;
    next(): Vec3 | undefined;
    /** Return a position to the front so another bot can retry it. */
    putBack(pos: Vec3): void;
    /** Call after a block is successfully mined to advance progress counter. */
    markDone(): void;
    isEmpty(): boolean;
    get remaining(): number;
    get total(): number;
    get progress(): string;
    clear(): void;
}
//# sourceMappingURL=QuarryQueue.d.ts.map