import { Vec3 } from 'vec3';

export class QuarryQueue {
  private positions: Vec3[] = [];
  private completed = 0;
  private _total = 0;

  /** Fill queue with every block position inside the bounding box. */
  load(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void {
    this.positions = [];
    this.completed = 0;

    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);

    // Layer-by-layer top-down so the bot never mines its own floor
    for (let y = maxY; y >= minY; y--) {
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          this.positions.push(new Vec3(x, y, z));
        }
      }
    }

    this._total = this.positions.length;
    console.log(`[QuarryQueue] ${this._total} blocks to mine (${maxX - minX + 1}x${maxY - minY + 1}x${maxZ - minZ + 1})`);
  }

  next(): Vec3 | undefined {
    return this.positions.shift();
  }

  /** Return a position to the front so another bot can retry it. */
  putBack(pos: Vec3): void {
    this.positions.unshift(pos);
  }

  /** Call after a block is successfully mined to advance progress counter. */
  markDone(): void {
    this.completed++;
  }

  isEmpty(): boolean { return this.positions.length === 0; }
  get remaining(): number { return this.positions.length; }
  get total(): number { return this._total; }
  get progress(): string { return `${this.completed}/${this._total}`; }
  clear(): void { this.positions = []; }
}
