import type { BotSnapshot, TaskDescriptor } from '../ipc/messages';

/**
 * What the Orchestrator needs from the adapter layer.
 * Decouples the Orchestrator from WorkerCommandAdapter concretely.
 */
export interface IOrchestratorAdapter {
  on(event: 'state_update', cb: (botId: string, snap: BotSnapshot) => void): this;
  on(event: 'task_complete', cb: (botId: string, taskId: string) => void): this;
  on(event: 'task_failed',   cb: (botId: string, taskId: string, error: string, retryable: boolean) => void): this;
  on(event: 'disconnected',  cb: (botId: string, reason: string) => void): this;
  assignTask(botId: string, task: TaskDescriptor): void;
}
