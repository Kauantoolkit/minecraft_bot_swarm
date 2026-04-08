/**
 * Manages named bot groups.
 * Groups persist across restarts via groups.json.
 */
export declare class BotGroupStore {
    private groups;
    constructor();
    create(name: string): void;
    delete(name: string): void;
    add(groupName: string, ...usernames: string[]): void;
    remove(groupName: string, ...usernames: string[]): void;
    /** Returns the usernames in the group, or undefined if the group doesn't exist. */
    resolve(name: string): string[] | undefined;
    list(): void;
    members(name: string): void;
    private save;
    private load;
}
//# sourceMappingURL=BotGroupStore.d.ts.map