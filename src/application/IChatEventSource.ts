/**
 * Anything that can deliver in-game chat messages to the application layer.
 * WorkerCommandAdapter implements this in worker mode.
 * In direct (single-thread) mode, CommandListener falls back to mfBot.on('chat').
 */
export interface IChatEventSource {
  on(event: 'chat_msg', cb: (botId: string, username: string, message: string) => void): this;
}
