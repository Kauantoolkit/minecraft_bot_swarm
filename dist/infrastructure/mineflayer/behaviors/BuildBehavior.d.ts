import { Bot } from '../../../domain/entities/Bot';
import { BuildQueue } from '../../schematic/BuildQueue';
export declare class BuildBehavior {
    /**
     * Pulls tasks from the shared BuildQueue and places blocks.
     *
     * If the required block is missing from inventory, the task is deferred
     * back to the queue so another bot (or a future restock) can handle it.
     * Up to 5 passes are run by the caller (SwarmController).
     */
    buildFromQueue(domainBot: Bot, queue: BuildQueue): Promise<void>;
}
//# sourceMappingURL=BuildBehavior.d.ts.map