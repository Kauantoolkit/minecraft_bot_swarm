export interface ISwarmService {
    moveAllTo(x: number, y: number, z: number): Promise<void>;
    followAll(targetUsername: string): void;
    stopAll(): void;
    sayAll(message: string): void;
    attackAll(targetUsername: string): void;
    pvpAll(targetUsernames: string[]): void;
    guardAll(x: number, y: number, z: number, radius: number): void;
    defendAll(radius: number): void;
    stopDefendAll(): void;
    collectAll(blockName: string, count: number): void;
    buildAll(schematicPath: string, x: number, y: number, z: number): Promise<void>;
    equipAll(itemName: string): void;
    eatAll(): void;
    disconnectAll(): void;
    status(): void;
}
//# sourceMappingURL=ISwarmService.d.ts.map