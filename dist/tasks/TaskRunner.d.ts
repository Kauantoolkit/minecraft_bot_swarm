import { MineflayerAdapter } from '../infrastructure/mineflayer/MineflayerAdapter';
import { Bot } from '../domain/entities/Bot';
import { TaskDescriptor, TaskStatus, SerializedVec3 } from '../ipc/messages';
/**
 * Per-worker task executor.
 *
 * Runs inside the bot's worker thread. Receives serialisable TaskDescriptors
 * from the Orchestrator and executes them via the local MineflayerAdapter.
 * Supports cancellation: calling cancel() stops the adapter and causes the
 * running promise to reject with 'cancelled'.
 */
export declare class TaskRunner {
    private readonly adapter;
    private readonly bot;
    /** Called when a build_storage task places chests — main thread registers them. */
    private readonly onChestsPlaced?;
    private _currentTaskId;
    private _status;
    private _cancelled;
    private _cancelResolve;
    constructor(adapter: MineflayerAdapter, bot: Bot, 
    /** Called when a build_storage task places chests — main thread registers them. */
    onChestsPlaced?: ((label: string, positions: SerializedVec3[]) => void) | undefined);
    get currentTaskId(): string | null;
    get status(): TaskStatus;
    /**
     * Cancel the currently running task. The active execute() promise will
     * reject with Error('cancelled').
     */
    cancel(): void;
    run(descriptor: TaskDescriptor): Promise<void>;
    private checkCancelled;
    /** Returns a promise that resolves when cancel() is called. */
    private cancellationToken;
    private execute;
    private ensureWoodLogs;
    private craftPlanks;
    private depositCallback;
}
//# sourceMappingURL=TaskRunner.d.ts.map