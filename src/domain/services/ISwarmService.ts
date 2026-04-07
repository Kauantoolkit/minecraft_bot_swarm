export interface ISwarmService {
  // Movement
  moveAllTo(x: number, y: number, z: number): Promise<void>;
  followAll(targetUsername: string): void;
  stopAll(): void;

  // Chat
  sayAll(message: string): void;

  // Combat
  attackAll(targetUsername: string): void;
  pvpAll(targetUsernames: string[]): void;
  guardAll(x: number, y: number, z: number, radius: number): void;
  defendAll(radius: number): void;
  stopDefendAll(): void;

  // Resources
  collectAll(blockName: string, count: number): void;

  // Building
  buildAll(schematicPath: string, x: number, y: number, z: number): Promise<void>;

  // Inventory
  equipAll(itemName: string): void;
  eatAll(): void;

  // Lifecycle
  disconnectAll(): void;
  status(): void;
}
