import { Vec3 } from 'vec3';
/**
 * Registry of known storage containers (chests, barrels, etc.).
 *
 * Entries are registered by the operator via `store register <label> <x> <y> <z>`
 * and persisted to storages.json between restarts.
 *
 * Behaviors use getNearest() to find the closest chest to deposit into,
 * or getByLabel() when a specific storage is requested.
 */
export declare class StorageCache {
    private entries;
    constructor();
    register(label: string, pos: Vec3): void;
    remove(label: string): boolean;
    getByLabel(label: string): Vec3 | null;
    getNearest(botPos: Vec3): {
        label: string;
        pos: Vec3;
    } | null;
    list(): Array<{
        label: string;
        pos: Vec3;
    }>;
    /** Register multiple chests at once (from an auto-scan). Skips duplicates. */
    registerMany(prefix: string, positions: Array<{
        x: number;
        y: number;
        z: number;
    }>): number;
    private load;
    private save;
}
//# sourceMappingURL=StorageCache.d.ts.map