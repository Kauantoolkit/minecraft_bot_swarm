import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
export interface PlayerSighting {
    spottedBy: string;
    targetUsername: string;
    position: Vec3;
    timestamp: number;
}
/**
 * Shared intelligence bus.
 * Bots report player sightings here; other bots subscribe to receive
 * last-known coordinates and converge on the target.
 */
export declare class SwarmIntel extends EventEmitter {
    private sightings;
    report(spottedBy: string, targetUsername: string, position: Vec3): void;
    getLastSighting(targetUsername: string): PlayerSighting | undefined;
    clearSighting(targetUsername: string): void;
    getAllSightings(): PlayerSighting[];
}
//# sourceMappingURL=SwarmIntel.d.ts.map