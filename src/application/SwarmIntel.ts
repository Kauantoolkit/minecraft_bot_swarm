import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';

export interface PlayerSighting {
  spottedBy: string;
  targetUsername: string;
  position: Vec3;
  timestamp: number;
}

const SIGHTING_TTL_MS = 30_000; // sightings expire after 30 s

/**
 * Shared intelligence bus.
 * Bots report player sightings here; other bots subscribe to receive
 * last-known coordinates and converge on the target.
 */
export class SwarmIntel extends EventEmitter {
  private sightings = new Map<string, PlayerSighting>();

  report(spottedBy: string, targetUsername: string, position: Vec3): void {
    const prev = this.sightings.get(targetUsername);

    // Only re-broadcast if position changed by >3 blocks or TTL passed
    const moved = !prev || position.distanceTo(prev.position) > 3;
    const expired = !prev || Date.now() - prev.timestamp > SIGHTING_TTL_MS;

    if (!moved && !expired) return;

    const sighting: PlayerSighting = {
      spottedBy,
      targetUsername,
      position: position.clone(),
      timestamp: Date.now(),
    };

    this.sightings.set(targetUsername, sighting);
    this.emit('playerSpotted', sighting);

    console.log(
      `[Intel] ${spottedBy} spotted ${targetUsername} @ ` +
      `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`,
    );
  }

  getLastSighting(targetUsername: string): PlayerSighting | undefined {
    const s = this.sightings.get(targetUsername);
    if (!s) return undefined;
    // Return null if too stale
    if (Date.now() - s.timestamp > SIGHTING_TTL_MS) {
      this.sightings.delete(targetUsername);
      return undefined;
    }
    return s;
  }

  clearSighting(targetUsername: string): void {
    this.sightings.delete(targetUsername);
  }

  getAllSightings(): PlayerSighting[] {
    const now = Date.now();
    return [...this.sightings.values()].filter(s => now - s.timestamp <= SIGHTING_TTL_MS);
  }
}
