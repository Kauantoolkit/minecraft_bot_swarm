import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyConfig } from '../../domain/value-objects/ProxyConfig';
export interface ConnectionOptions {
    host: string;
    port: number;
    version: string | false;
    username: string;
    agent?: SocksProxyAgent;
}
export declare class NetworkProvider {
    buildConnectionOptions(username: string, proxy?: ProxyConfig): ConnectionOptions;
}
//# sourceMappingURL=NetworkProvider.d.ts.map