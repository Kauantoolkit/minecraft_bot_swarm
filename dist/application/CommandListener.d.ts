import { SwarmController } from './SwarmController';
import { BotManager } from './BotManager';
import { BotGroupStore } from './BotGroupStore';
import { IBotRepository } from '../domain/repositories/IBotRepository';
import { IBotAdapter } from '../infrastructure/mineflayer/IBotAdapter';
export declare class CommandListener {
    private readonly controller;
    private readonly repository;
    private readonly adapter;
    private readonly botManager;
    private readonly groups;
    private rl?;
    private lastChat;
    constructor(controller: SwarmController, repository: IBotRepository, adapter: IBotAdapter, botManager: BotManager, groups: BotGroupStore);
    startConsole(): void;
    attachChatListeners(): void;
    private parseTarget;
    dispatch(input: string): void;
}
//# sourceMappingURL=CommandListener.d.ts.map