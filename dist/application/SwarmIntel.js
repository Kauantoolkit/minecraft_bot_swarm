"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwarmIntel = void 0;
const events_1 = require("events");
const SIGHTING_TTL_MS = 30000; // sightings expire after 30 s
/**
 * Shared intelligence bus.
 * Bots report player sightings here; other bots subscribe to receive
 * last-known coordinates and converge on the target.
 */
class SwarmIntel extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.sightings = new Map();
    }
    report(spottedBy, targetUsername, position) {
        const prev = this.sightings.get(targetUsername);
        // Only re-broadcast if position changed by >3 blocks or TTL passed
        const moved = !prev || position.distanceTo(prev.position) > 3;
        const expired = !prev || Date.now() - prev.timestamp > SIGHTING_TTL_MS;
        if (!moved && !expired)
            return;
        const sighting = {
            spottedBy,
            targetUsername,
            position: position.clone(),
            timestamp: Date.now(),
        };
        this.sightings.set(targetUsername, sighting);
        this.emit('playerSpotted', sighting);
        console.log(`[Intel] ${spottedBy} spotted ${targetUsername} @ ` +
            `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`);
    }
    getLastSighting(targetUsername) {
        const s = this.sightings.get(targetUsername);
        if (!s)
            return undefined;
        // Return null if too stale
        if (Date.now() - s.timestamp > SIGHTING_TTL_MS) {
            this.sightings.delete(targetUsername);
            return undefined;
        }
        return s;
    }
    clearSighting(targetUsername) {
        this.sightings.delete(targetUsername);
    }
    getAllSightings() {
        const now = Date.now();
        return [...this.sightings.values()].filter(s => now - s.timestamp <= SIGHTING_TTL_MS);
    }
}
exports.SwarmIntel = SwarmIntel;
//# sourceMappingURL=SwarmIntel.js.map