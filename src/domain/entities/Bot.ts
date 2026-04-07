import { BotState } from '../value-objects/BotState';
import { ProxyConfig } from '../value-objects/ProxyConfig';

export interface BotOptions {
  id: string;
  username: string;
  proxy?: ProxyConfig;
}

export class Bot {
  readonly id: string;
  readonly username: string;
  readonly proxy?: ProxyConfig;

  private _state: BotState = BotState.IDLE;

  // Raw mineflayer bot handle — typed as unknown to keep domain clean.
  // The infrastructure layer casts it to the real mineflayer.Bot type.
  private _handle: unknown = null;

  constructor(options: BotOptions) {
    this.id = options.id;
    this.username = options.username;
    this.proxy = options.proxy;
  }

  get state(): BotState {
    return this._state;
  }

  get handle(): unknown {
    return this._handle;
  }

  setState(state: BotState): void {
    this._state = state;
  }

  attachHandle(handle: unknown): void {
    this._handle = handle;
  }

  isOnline(): boolean {
    return (
      this._state === BotState.CONNECTED ||
      this._state === BotState.MOVING ||
      this._state === BotState.CHATTING
    );
  }

  toString(): string {
    return `Bot[${this.id}](${this.username}) — ${this._state}${this.proxy ? ' via proxy' : ''}`;
  }
}
