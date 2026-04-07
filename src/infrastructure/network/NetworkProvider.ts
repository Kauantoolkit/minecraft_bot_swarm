import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyConfig } from '../../domain/value-objects/ProxyConfig';
import { config } from '../../config';

export interface ConnectionOptions {
  host: string;
  port: number;
  version: string | false;
  username: string;
  agent?: SocksProxyAgent;
}

export class NetworkProvider {
  buildConnectionOptions(username: string, proxy?: ProxyConfig): ConnectionOptions {
    const rawVersion = config.server.version;
    const version: string | false = rawVersion === 'auto' ? false : rawVersion;

    const base: ConnectionOptions = {
      host: config.server.host,
      port: config.server.port,
      version,
      username,
    };

    if (proxy) {
      console.log(`[NetworkProvider] ${username} -> PROXY ${proxy.url}`);
      base.agent = new SocksProxyAgent(proxy.url);
    } else {
      console.log(`[NetworkProvider] ${username} -> DIRECT ${base.host}:${base.port}`);
    }

    return base;
  }
}
