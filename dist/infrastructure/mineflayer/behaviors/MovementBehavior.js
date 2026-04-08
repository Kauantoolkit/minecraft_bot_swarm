"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovementBehavior = void 0;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const BotState_1 = require("../../../domain/value-objects/BotState");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
const utils_1 = require("../utils");
class MovementBehavior {
    constructor(meta) {
        this.meta = meta;
    }
    async moveTo(domainBot, x, y, z) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        mfBot.pathfinder.stop();
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        domainBot.setState(BotState_1.BotState.MOVING);
        console.log(`[Move] ${domainBot.username} → (${x}, ${y}, ${z})`);
        try {
            await new Promise((resolve, reject) => {
                mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalNear(x, y, z, 2));
                const onReached = () => { cleanup(); resolve(); };
                const onNoPath = (r) => {
                    if (r.status === 'noPath') {
                        cleanup();
                        reject(new Error('noPath'));
                    }
                };
                const onStopped = () => { cleanup(); resolve(); };
                const cleanup = () => {
                    mfBot.removeListener('goal_reached', onReached);
                    mfBot.removeListener('path_update', onNoPath);
                    mfBot.removeListener('path_stop', onStopped);
                };
                mfBot.once('goal_reached', onReached);
                mfBot.on('path_update', onNoPath);
                mfBot.once('path_stop', onStopped);
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`${domainBot.username}: move failed — ${msg}`);
        }
        finally {
            domainBot.setState(BotState_1.BotState.CONNECTED);
        }
    }
    /**
     * Follows a player indefinitely.
     *
     * Internally stores its tick in meta.pvpListener (shared slot with pvp).
     * Starting pvp() after follow() will silently replace this listener.
     * stopPvp() / stop() cleans up both.
     */
    follow(domainBot, targetUsername) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        const meta = this.meta.get(domainBot);
        if (meta.pvpListener)
            mfBot.removeListener('physicsTick', meta.pvpListener);
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        let currentEntityRef = null;
        let noPathRetry = 0;
        let scanTick = 0;
        let wasVisible = false;
        const setFollowGoal = (entity) => {
            currentEntityRef = entity;
            noPathRetry = 0;
            mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
            mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalFollow(entity, 2), true);
            console.log(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: GoalFollow(${targetUsername}) issued`);
        };
        const onPathUpdate = (r) => {
            if (r.status === 'noPath') {
                if (++noPathRetry <= 5) {
                    const delay = 3000 * noPathRetry;
                    console.warn(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: noPath → retry ${noPathRetry}/5 in ${delay / 1000}s`);
                    setTimeout(() => {
                        const entity = mfBot.players[targetUsername]?.entity;
                        if (entity) {
                            console.log(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: retrying GoalFollow after noPath`);
                            setFollowGoal(entity);
                        }
                        else {
                            console.warn(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: retry ${noPathRetry} — target still not visible`);
                        }
                    }, delay);
                }
                else {
                    console.error(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: noPath — max retries reached, giving up`);
                }
            }
            else if (r.status !== 'success' && r.status !== 'partialSuccess') {
                console.log(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: path_update status=${r.status}`);
            }
        };
        mfBot.on('path_update', onPathUpdate);
        meta.followPathUpdateListener = onPathUpdate;
        mfBot.on('goal_reached', () => console.log(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: goal_reached (within 2 of ${targetUsername})`));
        mfBot.on('path_stop', () => console.log(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: path_stop event fired`));
        const tick = () => {
            if (++scanTick % 10 !== 0)
                return; // check at 2 Hz
            const entity = mfBot.players[targetUsername]?.entity;
            if (!entity) {
                if (wasVisible) {
                    wasVisible = false;
                    console.warn(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: "${targetUsername}" left render range — waiting`);
                }
                return;
            }
            if (!wasVisible) {
                wasVisible = true;
                console.log(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: "${targetUsername}" came into range`);
            }
            if (entity !== currentEntityRef) {
                console.log(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: entity ref changed (teleport/respawn?) → re-issuing goal`);
                setFollowGoal(entity);
            }
        };
        mfBot.on('physicsTick', tick);
        meta.pvpListener = tick;
        domainBot.setState(BotState_1.BotState.MOVING);
        console.log(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: starting follow of "${targetUsername}"`);
        const entity = mfBot.players[targetUsername]?.entity;
        if (entity) {
            wasVisible = true;
            setFollowGoal(entity);
        }
        else {
            console.warn(`[${(0, utils_1.ts)()}][Follow] ${domainBot.username}: "${targetUsername}" not visible yet — will engage on first sight`);
        }
    }
}
exports.MovementBehavior = MovementBehavior;
//# sourceMappingURL=MovementBehavior.js.map