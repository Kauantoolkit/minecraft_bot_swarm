export interface ProxyConfig {
  readonly url: string; // socks5://user:pass@host:port
}

export function parseProxyLine(line: string): ProxyConfig | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (!trimmed.startsWith('socks5://')) return null;
  return { url: trimmed };
}
