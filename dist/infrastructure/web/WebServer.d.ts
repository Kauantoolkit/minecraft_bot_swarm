import { IBotRepository } from '../../domain/repositories/IBotRepository';
import { SwarmController } from '../../application/SwarmController';
import { IBotAdapter } from '../mineflayer/IBotAdapter';
import type { Orchestrator } from '../../orchestrator/Orchestrator';
export declare class WebServer {
    private readonly repository;
    private readonly controller;
    private readonly adapter;
    private readonly dispatch;
    private readonly port;
    private readonly orchestrator?;
    private readonly server;
    constructor(repository: IBotRepository, controller: SwarmController, adapter: IBotAdapter, dispatch: (cmd: string) => void, port?: number, orchestrator?: Orchestrator | undefined);
    start(): void;
    private handle;
    private apiStatus;
    private apiOrchGet;
    private apiOrchPost;
    private apiCommand;
    private apiLog;
    private serveUI;
}
//# sourceMappingURL=WebServer.d.ts.map