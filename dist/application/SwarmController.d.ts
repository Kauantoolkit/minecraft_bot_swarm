import { IBotRepository } from '../domain/repositories/IBotRepository';
import { ISwarmService } from '../domain/services/ISwarmService';
import { IBotAdapter } from '../infrastructure/mineflayer/IBotAdapter';
import { StorageCache } from '../infrastructure/storage/StorageCache';
import { SwarmIntel } from './SwarmIntel';
import { PlayerRelationshipStore } from '../domain/value-objects/PlayerRelationship';
export type BotTarget = string[] | undefined;
export declare class SwarmController implements ISwarmService {
    private readonly repository;
    private readonly adapter;
    private readonly buildQueue;
    private readonly quarryQueue;
    readonly intel: SwarmIntel;
    readonly relations: PlayerRelationshipStore;
    readonly storage: StorageCache;
    constructor(repository: IBotRepository, adapter: IBotAdapter);
    /**
     * Resolve target to online bot list.
     * If target is undefined → all online bots.
     * If target is a string array → filter by username or id.
     */
    private resolve;
    private log;
    moveAllTo(x: number, y: number, z: number, target?: BotTarget): Promise<void>;
    followAll(targetUsername: string, target?: BotTarget): void;
    stopAll(target?: BotTarget): void;
    sayAll(message: string, target?: BotTarget): void;
    attackAll(targetUsername: string, target?: BotTarget): void;
    pvpAll(targetUsernames: string[], target?: BotTarget): void;
    bodyguardAll(protectedUsername: string, radius: number, target?: BotTarget): void;
    guardAll(x: number, y: number, z: number, radius: number, target?: BotTarget): void;
    defendAll(radius: number, target?: BotTarget): void;
    stopDefendAll(target?: BotTarget): void;
    avoidAll(targetUsernames: string[], radius: number, target?: BotTarget): void;
    collectAll(blockName: string, count: number, storageLabel?: string, target?: BotTarget): void;
    collectVeinAll(blockName: string, count: number, storageLabel?: string, target?: BotTarget): void;
    quarryAll(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, storageLabel?: string, target?: BotTarget): void;
    depositAll(storageLabel: string, target?: BotTarget): void;
    withdraw(storageLabel: string, itemName: string, count: number, target?: BotTarget): void;
    private resolveChestPos;
    private makeDepositFn;
    farmAll(centerX: number, centerZ: number, radius: number, target?: BotTarget): void;
    exploreAll(direction: 'north' | 'south' | 'east' | 'west' | 'auto', target?: BotTarget): void;
    buildAll(schematicPath: string, x: number, y: number, z: number, target?: BotTarget): Promise<void>;
    equipAll(itemName: string, target?: BotTarget): void;
    eatAll(target?: BotTarget): void;
    disconnectAll(target?: BotTarget): void;
    status(): void;
}
//# sourceMappingURL=SwarmController.d.ts.map