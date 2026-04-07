import fs from 'fs';
import { ProxyConfig, parseProxyLine } from '../../domain/value-objects/ProxyConfig';

export class ProxyLoader {
  private proxies: ProxyConfig[] = [];
  private cursor = 0;

  load(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      console.warn(`[ProxyLoader] File not found: ${filePath}. Running without proxies.`);
      return;
    }

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    this.proxies = lines.map(parseProxyLine).filter((p): p is ProxyConfig => p !== null);

    console.log(`[ProxyLoader] Loaded ${this.proxies.length} proxies from ${filePath}`);
  }

  next(): ProxyConfig | undefined {
    if (this.proxies.length === 0) return undefined;
    const proxy = this.proxies[this.cursor % this.proxies.length];
    this.cursor++;
    return proxy;
  }

  hasProxies(): boolean {
    return this.proxies.length > 0;
  }

  count(): number {
    return this.proxies.length;
  }
}
