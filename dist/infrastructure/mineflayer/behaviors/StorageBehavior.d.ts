import { Bot as MineflayerBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { Bot } from '../../../domain/entities/Bot';
/** Minimum empty inventory slots before the bot considers itself "full". */
export declare const INVENTORY_FULL_THRESHOLD = 5;
export declare function isInventoryFull(mfBot: MineflayerBot): boolean;
export declare class StorageBehavior {
    /**
     * Navigate to (x, y, z) and scan the surrounding area for chest/barrel blocks.
     * Returns their positions so the caller can register them in StorageCache.
     */
    scanNearbyChests(domainBot: Bot, x: number, y: number, z: number, radius: number): Promise<Array<{
        x: number;
        y: number;
        z: number;
    }>>;
    /**
     * Navigate to a chest/barrel and deposit ALL items from the bot's inventory.
     * Skips tools (anything with durability) to avoid depositing equipped gear.
     */
    depositAll(domainBot: Bot, chestPos: Vec3): Promise<void>;
    /**
     * Navigate to a chest and withdraw a specific item by name.
     * Returns the number of items actually withdrawn.
     */
    withdraw(domainBot: Bot, chestPos: Vec3, itemName: string, count: number): Promise<number>;
}
//# sourceMappingURL=StorageBehavior.d.ts.map