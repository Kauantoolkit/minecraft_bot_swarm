"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AvoidBehavior = void 0;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const BotState_1 = require("../../../domain/value-objects/BotState");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
class AvoidBehavior {
    constructor(meta) {
        this.meta = meta;
    }
    avoid(domainBot, targetUsernames, triggerRadius) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        const meta = this.meta.get(domainBot);
        if (meta.avoidListener)
            mfBot.removeListener('physicsTick', meta.avoidListener);
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        let avoiding = false;
        let scanTick = 0;
        // Scan every 10 ticks (2 Hz) — only update goal when state changes
        const tick = () => {
            if (++scanTick % 10 !== 0)
                return;
            let threat = null;
            for (const username of targetUsernames) {
                const entity = mfBot.players[username]?.entity;
                if (entity && entity.position.distanceTo(mfBot.entity.position) < triggerRadius) {
                    threat = entity;
                    break;
                }
            }
            if (threat && !avoiding) {
                avoiding = true;
                const away = mfBot.entity.position.minus(threat.position).normalize().scaled(30);
                const ft = mfBot.entity.position.plus(away);
                mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalBlock(Math.floor(ft.x), Math.floor(ft.y), Math.floor(ft.z)));
            }
            else if (!threat && avoiding) {
                avoiding = false;
                mfBot.pathfinder.stop();
            }
        };
        mfBot.on('physicsTick', tick);
        meta.avoidListener = tick;
        domainBot.setState(BotState_1.BotState.MOVING);
        console.log(`[MineflayerAdapter] ${domainBot.username}: avoiding [${targetUsernames.join(', ')}]`);
    }
    stopAvoid(domainBot) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        const meta = this.meta.get(domainBot);
        if (meta.avoidListener) {
            mfBot.removeListener('physicsTick', meta.avoidListener);
            delete meta.avoidListener;
        }
    }
}
exports.AvoidBehavior = AvoidBehavior;
//# sourceMappingURL=AvoidBehavior.js.map