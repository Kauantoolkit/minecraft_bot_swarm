import { ProxyConfig } from '../../domain/value-objects/ProxyConfig';
export declare class ProxyLoader {
    private proxies;
    private cursor;
    load(filePath: string): void;
    next(): ProxyConfig | undefined;
    hasProxies(): boolean;
    count(): number;
}
//# sourceMappingURL=ProxyLoader.d.ts.map