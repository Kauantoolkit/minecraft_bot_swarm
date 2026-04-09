export interface SerializedVec3 {
    x: number;
    y: number;
    z: number;
}
export interface ItemSummary {
    name: string;
    count: number;
}
export type TaskStatus = 'idle' | 'running' | 'complete' | 'failed';
export interface BotSnapshot {
    botId: string;
    username: string;
    health: number;
    food: number;
    position: SerializedVec3 | null;
    inventory: ItemSummary[];
    mode: string;
    role: string;
    currentTaskId: string | null;
    taskStatus: TaskStatus;
    connected: boolean;
}
export interface BotWorkerData {
    botId: string;
    username: string;
    /** Proxy URL in socks5://[user:pass@]host:port format — matches ProxyConfig.url */
    proxyUrl?: string;
    server: {
        host: string;
        port: number;
        version: string | false;
    };
}
export type TaskDescriptor = {
    id: string;
    type: 'idle';
    params: {
        durationMs?: number;
    };
} | {
    id: string;
    type: 'mine';
    params: {
        blockName: string;
        count: number;
        chestPos?: SerializedVec3;
    };
} | {
    id: string;
    type: 'collect_wood';
    params: {
        count: number;
        chestPos?: SerializedVec3;
    };
} | {
    id: string;
    type: 'deposit';
    params: {
        chestPos: SerializedVec3;
    };
} | {
    id: string;
    type: 'guard';
    params: {
        x: number;
        y: number;
        z: number;
        radius: number;
    };
} | {
    id: string;
    type: 'farm';
    params: {
        centerX: number;
        centerZ: number;
        radius: number;
    };
} | {
    id: string;
    type: 'explore';
    params: {
        direction: 'north' | 'south' | 'east' | 'west' | 'auto';
    };
} | {
    id: string;
    type: 'craft';
    params: {
        itemName: string;
        count: number;
    };
} | {
    id: string;
    type: 'build_storage';
    params: {
        storageLabel: string;
        centerX: number;
        centerY: number;
        centerZ: number;
        chestCount: number;
    };
};
export type MainToWorkerMsg = {
    type: 'STOP';
} | {
    type: 'CMD_FOLLOW';
    username: string;
} | {
    type: 'CMD_STOP';
} | {
    type: 'CMD_SAY';
    message: string;
} | {
    type: 'CMD_ATTACK';
    username: string;
} | {
    type: 'CMD_PVP';
    usernames: string[];
} | {
    type: 'CMD_STOP_PVP';
} | {
    type: 'CMD_GUARD';
    x: number;
    y: number;
    z: number;
    radius: number;
    excludeUsernames: string[];
} | {
    type: 'CMD_STOP_GUARD';
} | {
    type: 'CMD_BODYGUARD';
    protectedUsername: string;
    radius: number;
    swarmUsernames: string[];
} | {
    type: 'CMD_DEFEND';
    radius: number;
} | {
    type: 'CMD_STOP_DEFEND';
} | {
    type: 'CMD_AVOID';
    usernames: string[];
    radius: number;
} | {
    type: 'CMD_STOP_AVOID';
} | {
    type: 'CMD_FARM';
    centerX: number;
    centerZ: number;
    radius: number;
} | {
    type: 'CMD_STOP_FARM';
} | {
    type: 'CMD_EXPLORE';
    direction: 'north' | 'south' | 'east' | 'west' | 'auto';
} | {
    type: 'CMD_STOP_EXPLORE';
} | {
    type: 'CMD_MOVE_TO';
    reqId: string;
    x: number;
    y: number;
    z: number;
} | {
    type: 'CMD_COLLECT';
    reqId: string;
    blockName: string;
    count: number;
    chestPos?: SerializedVec3;
} | {
    type: 'CMD_COLLECT_VEIN';
    reqId: string;
    blockName: string;
    count: number;
    chestPos?: SerializedVec3;
} | {
    type: 'CMD_DEPOSIT_ALL';
    reqId: string;
    chestPos: SerializedVec3;
} | {
    type: 'CMD_WITHDRAW';
    reqId: string;
    chestPos: SerializedVec3;
    itemName: string;
    count: number;
} | {
    type: 'CMD_EQUIP';
    reqId: string;
    itemName: string;
} | {
    type: 'CMD_EAT';
    reqId: string;
} | {
    type: 'ASSIGN_TASK';
    descriptor: TaskDescriptor;
} | {
    type: 'CANCEL_TASK';
} | {
    type: 'SWARM_USERNAMES';
    usernames: string[];
} | {
    type: 'PLAYER_SPOTTED';
    target: string;
    position: SerializedVec3;
    reportedBy: string;
} | {
    type: 'CMD_SCAN_STORAGE';
    reqId: string;
    x: number;
    y: number;
    z: number;
    radius: number;
};
export type WorkerToMainMsg = {
    type: 'READY';
} | {
    type: 'ERROR';
    error: string;
} | {
    type: 'DISCONNECTED';
    reason: string;
} | {
    type: 'STATE_UPDATE';
    snapshot: BotSnapshot;
} | {
    type: 'TASK_COMPLETE';
    taskId: string;
} | {
    type: 'TASK_FAILED';
    taskId: string;
    error: string;
    retryable: boolean;
} | {
    type: 'CMD_RESULT';
    reqId: string;
    success: boolean;
    error?: string;
    value?: unknown;
} | {
    type: 'PLAYER_SPOTTED';
    target: string;
    position: SerializedVec3;
} | {
    type: 'CHAT_MSG';
    username: string;
    message: string;
} | {
    type: 'CHESTS_PLACED';
    label: string;
    positions: SerializedVec3[];
} | {
    type: 'LOG';
    level: 'info' | 'warn' | 'error';
    message: string;
};
//# sourceMappingURL=messages.d.ts.map