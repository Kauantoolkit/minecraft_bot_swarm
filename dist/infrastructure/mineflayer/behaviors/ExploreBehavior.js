"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExploreBehavior = void 0;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const vec3_1 = require("vec3");
const BotState_1 = require("../../../domain/value-objects/BotState");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
const STEP = 200; // blocks per leg
const DIRECTION_VEC = {
    north: new vec3_1.Vec3(0, 0, -1),
    south: new vec3_1.Vec3(0, 0, 1),
    east: new vec3_1.Vec3(1, 0, 0),
    west: new vec3_1.Vec3(-1, 0, 0),
};
class ExploreBehavior {
    constructor(meta) {
        this.meta = meta;
    }
    async explore(domainBot, direction) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        const meta = this.meta.get(domainBot);
        meta.exploringActive = true;
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        domainBot.setState(BotState_1.BotState.MOVING);
        console.log(`[Explore] ${domainBot.username}: heading ${direction}`);
        while (meta.exploringActive && domainBot.isOnline()) {
            let dir;
            if (direction === 'auto') {
                // Walk toward lowest-chunk-load quadrant (simple: random cardinal)
                const dirs = Object.values(DIRECTION_VEC);
                dir = dirs[Math.floor(Math.random() * dirs.length)];
            }
            else {
                dir = DIRECTION_VEC[direction];
            }
            const target = mfBot.entity.position.plus(dir.scaled(STEP));
            await new Promise((res) => {
                let settled = false;
                const settle = () => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(legTimer);
                        mfBot.off('goal_reached', settle);
                        delete meta.resumeCallback;
                        res();
                    }
                };
                meta.resumeCallback = settle;
                // GoalXZ navigates to X,Z regardless of terrain height — avoids bots
                // getting stuck trying to reach an exact Y that doesn't exist in the terrain
                mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalXZ(Math.floor(target.x), Math.floor(target.z)));
                mfBot.once('goal_reached', settle);
                const legTimer = setTimeout(() => { mfBot.pathfinder.stop(); settle(); }, 30000); // 30 s timeout per leg
            });
        }
        domainBot.setState(BotState_1.BotState.CONNECTED);
    }
    stopExplore(domainBot) {
        const meta = this.meta.get(domainBot);
        meta.exploringActive = false;
        const mfBot = domainBot.handle;
        if (mfBot)
            mfBot.pathfinder.stop();
    }
}
exports.ExploreBehavior = ExploreBehavior;
//# sourceMappingURL=ExploreBehavior.js.map