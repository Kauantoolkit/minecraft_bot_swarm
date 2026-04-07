import { BlockTask } from './SchematicLoader';

export class BuildQueue {
  private pending: BlockTask[] = [];
  private deferred: BlockTask[] = [];
  private missingBlocks = new Set<string>();
  private completed = 0;
  private _total = 0;

  load(tasks: BlockTask[]): void {
    this.pending = [...tasks];
    this.deferred = [];
    this.missingBlocks.clear();
    this.completed = 0;
    this._total = tasks.length;
    console.log(`[BuildQueue] Loaded ${this._total} block tasks`);
  }

  next(): BlockTask | undefined {
    const task = this.pending.shift();
    if (task) this.completed++;
    return task;
  }

  /** Put a task back because the bot lacks the block — saves the missing type. */
  deferTask(task: BlockTask, missingBlockName: string): void {
    this.deferred.push(task);
    this.missingBlocks.add(missingBlockName);
    this.completed--; // undo the count from next()
  }

  /** Move deferred tasks back to pending for another pass. Returns count moved. */
  restoreDeferred(): number {
    const count = this.deferred.length;
    this.pending.push(...this.deferred);
    this.deferred = [];
    this.missingBlocks.clear();
    return count;
  }

  getMissingBlocks(): string[] {
    return Array.from(this.missingBlocks);
  }

  hasDeferredTasks(): boolean {
    return this.deferred.length > 0;
  }

  isEmpty(): boolean {
    return this.pending.length === 0;
  }

  clear(): void {
    this.pending = [];
    this.deferred = [];
  }

  get remaining(): number {
    return this.pending.length + this.deferred.length;
  }

  get total(): number {
    return this._total;
  }

  get progress(): string {
    return `${this.completed}/${this._total}`;
  }
}
