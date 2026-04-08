"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FarmBehavior = void 0;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const vec3_1 = require("vec3");
const BotState_1 = require("../../../domain/value-objects/BotState");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
const utils_1 = require("../utils");
// Fully-grown age per crop type
const CROP_MAX_AGE = {
    wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3,
};
// Seed item name per crop block name
const CROP_SEED = {
    wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato',
    beetroots: 'beetroot_seeds', nether_wart: 'nether_wart',
};
class FarmBehavior {
    constructor(meta) {
        this.meta = meta;
    }
    async farm(domainBot, centerX, centerZ, radius) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const meta = this.meta.get(domainBot);
        meta.farmingActive = true;
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        domainBot.setState(BotState_1.BotState.MOVING);
        console.log(`[Farm] ${domainBot.username}: farming r=${radius} around (${centerX},${centerZ})`);
        while (meta.farmingActive && domainBot.isOnline()) {
            let harvested = 0;
            for (const [cropName, maxAge] of Object.entries(CROP_MAX_AGE)) {
                const blockDef = mcData.blocksByName[cropName];
                if (!blockDef)
                    continue;
                while (meta.farmingActive) {
                    const block = mfBot.findBlock({
                        matching: (b) => b.type === blockDef.id &&
                            b.metadata === maxAge &&
                            Math.abs(b.position.x - centerX) <= radius &&
                            Math.abs(b.position.z - centerZ) <= radius,
                        maxDistance: radius * 2 + 10,
                    });
                    if (!block)
                        break;
                    await new Promise((res) => {
                        mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
                        mfBot.once('goal_reached', res);
                        setTimeout(res, 6000);
                    });
                    try {
                        await mfBot.dig(block);
                        harvested++;
                        console.log(`[Farm] ${domainBot.username}: harvested ${cropName}`);
                        // Replant: equip seed and place on farmland below
                        const seedName = CROP_SEED[cropName];
                        const seedDef = mcData.itemsByName[seedName];
                        if (seedDef) {
                            const seedItem = mfBot.inventory.items()
                                .find(i => i.type === seedDef.id);
                            if (seedItem) {
                                await mfBot.equip(seedItem, 'hand');
                                const farmland = mfBot.blockAt(block.position.offset(0, -1, 0));
                                if (farmland && (farmland.name === 'farmland' || farmland.name === 'soul_sand')) {
                                    try {
                                        await mfBot.placeBlock(farmland, new vec3_1.Vec3(0, 1, 0));
                                        console.log(`[Farm] ${domainBot.username}: replanted ${cropName}`);
                                    }
                                    catch { /* couldn't replant */ }
                                }
                            }
                        }
                    }
                    catch { /* crop already gone */ }
                }
            }
            if (harvested === 0) {
                // Nothing ripe — wait before next scan
                await (0, utils_1.sleep)(15000);
            }
        }
        domainBot.setState(BotState_1.BotState.CONNECTED);
    }
    stopFarm(domainBot) {
        const meta = this.meta.get(domainBot);
        meta.farmingActive = false;
    }
}
exports.FarmBehavior = FarmBehavior;
//# sourceMappingURL=FarmBehavior.js.map