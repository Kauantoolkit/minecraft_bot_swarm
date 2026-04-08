import { BlockTask } from './SchematicLoader';
export declare class BuildQueue {
    private pending;
    private deferred;
    private missingBlocks;
    private completed;
    private _total;
    load(tasks: BlockTask[]): void;
    next(): BlockTask | undefined;
    /** Put a task back because the bot lacks the block — saves the missing type. */
    deferTask(task: BlockTask, missingBlockName: string): void;
    /** Move deferred tasks back to pending for another pass. Returns count moved. */
    restoreDeferred(): number;
    getMissingBlocks(): string[];
    hasDeferredTasks(): boolean;
    isEmpty(): boolean;
    clear(): void;
    get remaining(): number;
    get total(): number;
    get progress(): string;
}
//# sourceMappingURL=BuildQueue.d.ts.map