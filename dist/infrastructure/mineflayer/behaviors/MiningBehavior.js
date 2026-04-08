"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MiningBehavior = void 0;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const vec3_1 = require("vec3");
const BotState_1 = require("../../../domain/value-objects/BotState");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
const StorageBehavior_1 = require("./StorageBehavior");
/**
 * If the bot ended up in water after mining, navigate out before the next block.
 * Uses pathfinder to find the shortest path to a non-water position nearby.
 */
async function escapeWaterIfNeeded(mfBot, username) {
    const inWater = mfBot.entity.isInWater;
    if (!inWater)
        return;
    console.warn(`[Mining] ${username}: in water after dig — escaping`);
    const pos = mfBot.entity.position;
    mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
    await new Promise(res => {
        const onReach = () => { clearTimeout(timer); res(); };
        const timer = setTimeout(() => { mfBot.off('goal_reached', onReach); res(); }, 6000);
        mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y) + 3, Math.floor(pos.z), 2));
        mfBot.once('goal_reached', onReach);
    });
    mfBot.pathfinder.stop();
    mfBot.clearControlStates();
}
/**
 * Returns true if mining this block would require the bot to be submerged.
 * Checks whether the block itself or the block directly above it is water/waterlogged.
 */
const WATER_NAMES = new Set(['water', 'flowing_water']);
function isBlockUnderwater(mfBot, pos) {
    if (!pos)
        return false;
    const above = mfBot.blockAt(pos.offset(0, 1, 0));
    const self = mfBot.blockAt(pos);
    if (above && WATER_NAMES.has(above.name))
        return true;
    if (self && WATER_NAMES.has(self.name))
        return true;
    if (self?.getProperties?.()?.['waterlogged'] === true)
        return true;
    return false;
}
/**
 * Returns true if the bot can reach this block without digging down.
 * A block is "surface-accessible" when at least one face is exposed:
 * the block above it is not a full solid cube, or one of the 4 sides
 * has a non-solid neighbor at the same or adjacent Y level.
 * This prevents the bot from choosing buried blocks over nearby surface ones.
 */
function isBlockAccessible(mfBot, pos) {
    if (!pos)
        return false;
    // Top face exposed — most common case for surface collection
    const above = mfBot.blockAt(pos.offset(0, 1, 0));
    if (!above || above.boundingBox !== 'block')
        return true;
    // Any horizontal side exposed at the same Y (bot can stand next to it)
    const sides = [
        pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1), pos.offset(0, 0, -1),
    ];
    for (const side of sides) {
        const b = mfBot.blockAt(side);
        if (!b || b.boundingBox !== 'block')
            return true;
    }
    return false;
}
// Tool preference order per harvest type — highest tier first
const TOOL_PRIORITY = {
    pickaxe: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'],
    axe: ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'],
    shovel: ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel', 'golden_shovel'],
    hoe: ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'wooden_hoe', 'golden_hoe'],
    sword: ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'],
};
class MiningBehavior {
    // ─── Private helpers ───────────────────────────────────────────────────────
    /** Equips the best available tool for the given block. No-op if no tool found. */
    async autoEquipToolFor(mfBot, block, mcData) {
        if (!block)
            return;
        const md = mcData;
        const blockDef = md['blocks'][block.type];
        if (!blockDef?.harvestTools)
            return;
        const validToolIds = new Set(Object.keys(blockDef.harvestTools).map(Number));
        for (const tools of Object.values(TOOL_PRIORITY)) {
            for (const toolName of tools) {
                const toolDef = md['itemsByName'][toolName];
                if (!toolDef || !validToolIds.has(toolDef.id))
                    continue;
                const item = mfBot.inventory.items().find(i => i.type === toolDef.id);
                if (item) {
                    await mfBot.equip(item, 'hand');
                    return;
                }
            }
        }
    }
    /**
     * Navigate to a block, stop pathfinder, then dig with a fresh reference.
     * Returns true if the block was successfully mined, false if already gone or unreachable.
     */
    async safeDig(mfBot, pos, expectedName, mcData) {
        await new Promise((res) => {
            const onReach = () => { clearTimeout(timer); res(); };
            const timer = setTimeout(() => { mfBot.off('goal_reached', onReach); res(); }, 8000);
            mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalGetToBlock(pos.x, pos.y, pos.z));
            mfBot.once('goal_reached', onReach);
        });
        const block = mfBot.blockAt(pos);
        if (!block || block.name !== expectedName)
            return false;
        if (block.position.distanceTo(mfBot.entity.position) > 5)
            return false;
        await this.autoEquipToolFor(mfBot, block, mcData);
        if (!mfBot.canDigBlock(block))
            return false;
        mfBot.pathfinder.stop();
        mfBot.clearControlStates();
        try {
            await mfBot.dig(block, true);
            return true;
        }
        catch {
            await new Promise(r => setTimeout(r, 300));
            const retry = mfBot.blockAt(pos);
            if (!retry || retry.name !== expectedName || !mfBot.canDigBlock(retry))
                return false;
            mfBot.pathfinder.stop();
            mfBot.clearControlStates();
            try {
                await mfBot.dig(retry, true);
                return true;
            }
            catch {
                return false;
            }
        }
    }
    // ─── Public API ────────────────────────────────────────────────────────────
    async collect(domainBot, blockName, count, onFull) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const blockType = mcData.blocksByName[blockName];
        if (!blockType) {
            console.warn(`[Mining] ${domainBot.username}: unknown block "${blockName}"`);
            return;
        }
        domainBot.setState(BotState_1.BotState.MOVING);
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        let collected = 0;
        while (collected < count) {
            if (onFull && (0, StorageBehavior_1.isInventoryFull)(mfBot)) {
                console.log(`[Mining] ${domainBot.username}: inventory full — depositing`);
                await onFull(domainBot);
                mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
            }
            const block = mfBot.findBlock({
                matching: b => b.type === blockType.id
                    && !isBlockUnderwater(mfBot, b.position)
                    && isBlockAccessible(mfBot, b.position),
                maxDistance: 64,
            });
            if (!block) {
                console.warn(`[Mining] ${domainBot.username}: no accessible "${blockName}" in range`);
                break;
            }
            const mined = await this.safeDig(mfBot, block.position, blockName, mcData);
            if (mined) {
                collected++;
                console.log(`[Mining] ${domainBot.username}: ${blockName} ${collected}/${count}`);
                await escapeWaterIfNeeded(mfBot, domainBot.username);
                mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
            }
        }
        await escapeWaterIfNeeded(mfBot, domainBot.username);
        domainBot.setState(BotState_1.BotState.CONNECTED);
    }
    async collectVein(domainBot, blockName, count, onFull) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        const blockType = mcData.blocksByName[blockName];
        if (!blockType) {
            console.warn(`[Mining] ${domainBot.username}: unknown block "${blockName}"`);
            return;
        }
        domainBot.setState(BotState_1.BotState.MOVING);
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        let collected = 0;
        const veinQueue = [];
        const tryDigAt = async (pos) => {
            const mined = await this.safeDig(mfBot, pos, blockName, mcData);
            if (!mined)
                return false;
            collected++;
            console.log(`[Vein] ${domainBot.username}: ${blockName} ${collected}/${count}`);
            await escapeWaterIfNeeded(mfBot, domainBot.username);
            mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
            // Enqueue all 6 adjacent positions of the same type
            const offsets = [
                new vec3_1.Vec3(1, 0, 0), new vec3_1.Vec3(-1, 0, 0),
                new vec3_1.Vec3(0, 1, 0), new vec3_1.Vec3(0, -1, 0),
                new vec3_1.Vec3(0, 0, 1), new vec3_1.Vec3(0, 0, -1),
            ];
            for (const off of offsets) {
                const adj = pos.plus(off);
                const adjBlock = mfBot.blockAt(adj);
                if (adjBlock?.type === blockType.id)
                    veinQueue.push(adj);
            }
            return true;
        };
        while (collected < count) {
            if (onFull && (0, StorageBehavior_1.isInventoryFull)(mfBot)) {
                console.log(`[Mining] ${domainBot.username}: inventory full — depositing`);
                await onFull(domainBot);
                mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
            }
            while (veinQueue.length > 0 && collected < count) {
                await tryDigAt(veinQueue.shift());
            }
            if (collected >= count)
                break;
            const block = mfBot.findBlock({
                matching: b => b.type === blockType.id
                    && !isBlockUnderwater(mfBot, b.position)
                    && isBlockAccessible(mfBot, b.position),
                maxDistance: 64,
            });
            if (!block) {
                console.warn(`[Mining] ${domainBot.username}: no accessible "${blockName}" in range`);
                break;
            }
            await tryDigAt(block.position);
        }
        domainBot.setState(BotState_1.BotState.CONNECTED);
    }
    async quarryFromQueue(domainBot, queue, onFull) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mcData = require('minecraft-data')(mfBot.version);
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        domainBot.setState(BotState_1.BotState.MOVING);
        while (!queue.isEmpty()) {
            if (onFull && (0, StorageBehavior_1.isInventoryFull)(mfBot)) {
                console.log(`[Quarry] ${domainBot.username}: inventory full — depositing`);
                await onFull(domainBot);
                mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
            }
            const pos = queue.next();
            if (!pos)
                break;
            const block = mfBot.blockAt(pos);
            if (!block || block.name === 'air' || block.name === 'cave_air')
                continue;
            const mined = await this.safeDig(mfBot, pos, block.name, mcData);
            if (mined) {
                queue.markDone();
                console.log(`[Quarry] ${domainBot.username}: mined [${queue.progress}]`);
                mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
            }
            else {
                queue.putBack(pos);
            }
        }
        domainBot.setState(BotState_1.BotState.CONNECTED);
    }
}
exports.MiningBehavior = MiningBehavior;
//# sourceMappingURL=MiningBehavior.js.map