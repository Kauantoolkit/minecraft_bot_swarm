"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CombatBehavior = void 0;
const mineflayer_pathfinder_1 = require("mineflayer-pathfinder");
const BotState_1 = require("../../../domain/value-objects/BotState");
const PhysicsPatch_1 = require("../physics/PhysicsPatch");
class CombatBehavior {
    constructor(meta) {
        this.meta = meta;
    }
    /** Single melee hit — one-shot, no loop. */
    attack(domainBot, targetUsername) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        const entity = mfBot.players[targetUsername]?.entity;
        if (entity)
            mfBot.attack(entity);
    }
    /**
     * Continuous PvP mode — chases and attacks targets.
     * Uses pvpListener slot (shared with follow; last writer wins).
     */
    pvp(domainBot, targetUsernames, intel, relations) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        const meta = this.meta.get(domainBot);
        if (meta.pvpListener)
            mfBot.removeListener('physicsTick', meta.pvpListener);
        mfBot.pathfinder.setMovements((0, PhysicsPatch_1.createMovements)(mfBot));
        let currentTargetName = null;
        let headingToLastKnown = false;
        meta.activeMode = `pvp:[${targetUsernames.join(',')}]`;
        const tick = () => {
            if (!mfBot.entity?.position)
                return;
            // Find a visible target — skip friends
            let found = null;
            for (const username of targetUsernames) {
                if (relations?.getRelationship(username) === 'friend')
                    continue;
                const entity = mfBot.players[username]?.entity;
                if (entity) {
                    found = { username, entity };
                    break;
                }
            }
            if (found) {
                headingToLastKnown = false;
                // Report sighting to intel bus so other bots can converge
                if (intel)
                    intel.report(domainBot.username, found.username, found.entity.position);
                // Update goal only when target changes
                if (found.username !== currentTargetName) {
                    currentTargetName = found.username;
                    mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalFollow(found.entity, 1), true);
                }
                if (found.entity.position.distanceTo(mfBot.entity.position) < 3.5) {
                    mfBot.attack(found.entity);
                }
                return;
            }
            // Target not visible — navigate to last known position from intel
            if (intel && !headingToLastKnown) {
                for (const username of targetUsernames) {
                    const sighting = intel.getLastSighting(username);
                    if (!sighting || sighting.spottedBy === domainBot.username)
                        continue;
                    headingToLastKnown = true;
                    currentTargetName = null;
                    const p = sighting.position;
                    mfBot.pathfinder.setGoal(new mineflayer_pathfinder_1.goals.GoalNear(p.x, p.y, p.z, 5));
                    console.log(`[Intel] ${domainBot.username}: heading to last known pos of ${username} ` +
                        `(spotted by ${sighting.spottedBy})`);
                    break;
                }
            }
            // Nothing to do — stop if we were previously chasing
            if (!headingToLastKnown && currentTargetName !== null) {
                currentTargetName = null;
                mfBot.pathfinder.stop();
            }
        };
        mfBot.on('physicsTick', tick);
        meta.pvpListener = tick;
        domainBot.setState(BotState_1.BotState.MOVING);
    }
    /**
     * Stops pvp and follow (both share pvpListener slot).
     */
    stopPvp(domainBot) {
        const mfBot = domainBot.handle;
        if (!mfBot)
            return;
        const meta = this.meta.get(domainBot);
        if (meta.pvpListener) {
            mfBot.removeListener('physicsTick', meta.pvpListener);
            delete meta.pvpListener;
        }
        if (meta.followPathUpdateListener) {
            mfBot.removeListener('path_update', meta.followPathUpdateListener);
            delete meta.followPathUpdateListener;
        }
    }
}
exports.CombatBehavior = CombatBehavior;
//# sourceMappingURL=CombatBehavior.js.map