import { BotState } from '../value-objects/BotState';
import { ProxyConfig } from '../value-objects/ProxyConfig';
export interface BotOptions {
    id: string;
    username: string;
    proxy?: ProxyConfig;
}
export declare class Bot {
    readonly id: string;
    readonly username: string;
    readonly proxy?: ProxyConfig;
    private _state;
    private _handle;
    constructor(options: BotOptions);
    get state(): BotState;
    get handle(): unknown;
    setState(state: BotState): void;
    attachHandle(handle: unknown): void;
    isOnline(): boolean;
    toString(): string;
}
//# sourceMappingURL=Bot.d.ts.map