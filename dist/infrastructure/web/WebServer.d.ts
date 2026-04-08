import { IBotRepository } from '../../domain/repositories/IBotRepository';
import { SwarmController } from '../../application/SwarmController';
import { IBotAdapter } from '../mineflayer/IBotAdapter';
export declare class WebServer {
    private readonly repository;
    private readonly controller;
    private readonly adapter;
    private readonly dispatch;
    private readonly port;
    private readonly server;
    constructor(repository: IBotRepository, controller: SwarmController, adapter: IBotAdapter, dispatch: (cmd: string) => void, port?: number);
    start(): void;
    private handle;
    private apiStatus;
    private apiCommand;
    private apiLog;
    private serveUI;
}
//# sourceMappingURL=WebServer.d.ts.map