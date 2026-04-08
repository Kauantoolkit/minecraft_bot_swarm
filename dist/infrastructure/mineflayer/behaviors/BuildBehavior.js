"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuildBehavior = void 0;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const vec3_1 = require("vec3");
const BotState_1 = require("../../../domain/value-objects/BotState");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
class BuildBehavior {
    /**
     * Pulls tasks from the shared BuildQueue and places blocks.
     *
     * If the required block is missing from inventory, the task is deferred
     * back to the queue so another bot (or a future restock) can handle it.
     * Up to 5 passes are run by the caller (SwarmController).
     */
    async buildFromQueue(domainBot, queue) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        domainBot.setState(BotState_1.BotState.MOVING);
        while (!queue.isEmpty()) {
            const task = queue.next();
            if (!task)
                break;
            const { x, y, z, blockName } = task;
            const shortName = blockName.includes(':') ? blockName.split(':')[1] : blockName;
            const itemDef = mcData.itemsByName[shortName] ?? mcData.blocksByName[shortName];
            if (!itemDef)
                continue; // unknown block — skip permanently
            const item = mfBot.inventory.items()
                .find(i => i.type === itemDef.id);
            if (!item) {
                queue.deferTask(task, shortName);
                continue;
            }
            await mfBot.equip(item, 'hand');
            await new Promise((res) => {
                mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalNear(x, y, z, 4));
                mfBot.once('goal_reached', res);
                setTimeout(res, 6000);
            });
            // Try each face until placement succeeds
            const faceVectors = [
                new vec3_1.Vec3(0, -1, 0), new vec3_1.Vec3(0, 1, 0),
                new vec3_1.Vec3(-1, 0, 0), new vec3_1.Vec3(1, 0, 0),
                new vec3_1.Vec3(0, 0, -1), new vec3_1.Vec3(0, 0, 1),
            ];
            for (const face of faceVectors) {
                const refPos = new vec3_1.Vec3(x, y, z).plus(face);
                const refBlock = mfBot.blockAt(refPos);
                if (refBlock && refBlock.name !== 'air') {
                    try {
                        await mfBot.placeBlock(refBlock, face.scaled(-1));
                        console.log(`[Build] ${domainBot.username}: placed ${shortName} @ ${x},${y},${z} [${queue.progress}]`);
                        break;
                    }
                    catch {
                        continue;
                    }
                }
            }
        }
        domainBot.setState(BotState_1.BotState.CONNECTED);
    }
}
exports.BuildBehavior = BuildBehavior;
//# sourceMappingURL=BuildBehavior.js.map