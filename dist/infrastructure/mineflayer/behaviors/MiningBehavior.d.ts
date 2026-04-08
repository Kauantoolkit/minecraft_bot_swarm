import { Bot } from '../../../domain/entities/Bot';
import { QuarryQueue } from '../../mining/QuarryQueue';
/** Called by mining loops when the inventory is full. Implementations deposit to a chest. */
export type DepositFn = (bot: Bot) => Promise<void>;
export declare class MiningBehavior {
    /** Equips the best available tool for the given block. No-op if no tool found. */
    private autoEquipToolFor;
    /**
     * Navigate to a block, stop pathfinder, then dig with a fresh reference.
     * Returns true if the block was successfully mined, false if already gone or unreachable.
     */
    private safeDig;
    collect(domainBot: Bot, blockName: string, count: number, onFull?: DepositFn): Promise<void>;
    collectVein(domainBot: Bot, blockName: string, count: number, onFull?: DepositFn): Promise<void>;
    quarryFromQueue(domainBot: Bot, queue: QuarryQueue, onFull?: DepositFn): Promise<void>;
}
//# sourceMappingURL=MiningBehavior.d.ts.map