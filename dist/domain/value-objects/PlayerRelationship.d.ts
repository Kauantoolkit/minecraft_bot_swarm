export type Relationship = 'friend' | 'enemy' | 'neutral';
/**
 * How to treat neutral players (not in friend or enemy list):
 *   ignore     — never attack neutrals
 *   attack     — treat neutrals like enemies (full open-pvp)
 *   armed      — attack neutrals that are visibly holding a weapon
 */
export type NeutralBehavior = 'ignore' | 'attack' | 'armed';
export declare class PlayerRelationshipStore {
    private friends;
    private enemies;
    private neutralBehavior;
    constructor();
    addFriend(username: string): void;
    addEnemy(username: string): void;
    remove(username: string): void;
    setNeutralBehavior(behavior: NeutralBehavior): void;
    getRelationship(username: string): Relationship;
    /**
     * Should the swarm attack this player right now?
     * @param heldItemName optional — the item name the player is holding (for 'armed' mode)
     */
    shouldAttackPlayer(username: string, heldItemName?: string): boolean;
    getFriends(): string[];
    getEnemies(): string[];
    getNeutralBehavior(): NeutralBehavior;
    print(): void;
    private save;
    private load;
}
//# sourceMappingURL=PlayerRelationship.d.ts.map