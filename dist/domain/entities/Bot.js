"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Bot = void 0;
const BotState_1 = require("../value-objects/BotState");
class Bot {
    constructor(options) {
        this._state = BotState_1.BotState.IDLE;
        // Raw mineflayer bot handle — typed as unknown to keep domain clean.
        // The infrastructure layer casts it to the real mineflayer.Bot type.
        this._handle = null;
        this.id = options.id;
        this.username = options.username;
        this.proxy = options.proxy;
    }
    get state() {
        return this._state;
    }
    get handle() {
        return this._handle;
    }
    setState(state) {
        this._state = state;
    }
    attachHandle(handle) {
        this._handle = handle;
    }
    isOnline() {
        return (this._state === BotState_1.BotState.CONNECTED ||
            this._state === BotState_1.BotState.MOVING ||
            this._state === BotState_1.BotState.CHATTING);
    }
    toString() {
        return `Bot[${this.id}](${this.username}) — ${this._state}${this.proxy ? ' via proxy' : ''}`;
    }
}
exports.Bot = Bot;
//# sourceMappingURL=Bot.js.map