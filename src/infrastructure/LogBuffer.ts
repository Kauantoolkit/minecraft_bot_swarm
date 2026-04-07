/**
 * Ring-buffer that captures all console output.
 * Call install() once at startup; after that every console.log/warn/error
 * is both printed to stdout AND stored for the web debug UI.
 */

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  text: string;
  time: number;
}

const MAX_ENTRIES = 300;
const entries: LogEntry[] = [];

function push(level: LogEntry['level'], args: unknown[]): void {
  const text = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  entries.push({ level, text, time: Date.now() });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function install(): void {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]) => { push('info', args);  orig.log(...args); };
  console.warn = (...args: unknown[]) => { push('warn', args); orig.warn(...args); };
  console.error = (...args: unknown[]) => { push('error', args); orig.error(...args); };
}

/** Returns the most recent `n` entries, newest last. */
export function recent(n = 100): LogEntry[] {
  return entries.slice(-n);
}
