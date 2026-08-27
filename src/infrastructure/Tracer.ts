import fs from 'fs';
import path from 'path';

/**
 * Tracer — structured event log that records bot state + context at every
 * decision point. Writes JSONL to disk so you can grep / tail / load later.
 *
 * Each event captures:
 *   - who (botId / username)
 *   - what happened (event type)
 *   - the context that led to it (inventory, position, task params, etc.)
 *   - outcome (success / failure + error message)
 *
 * Also keeps a ring buffer in memory so the web UI can query recent traces.
 */

export interface TraceEvent {
  ts: number;           // Date.now()
  bot: string;          // username (human-readable)
  botId: string;
  event: string;        // e.g. 'task_assigned', 'task_step', 'task_failed', 'orch_tick'
  detail: string;       // short human description
  ctx: Record<string, unknown>;  // full context snapshot
}

const MAX_MEMORY = 500;

class Tracer {
  private buffer: TraceEvent[] = [];
  private stream: fs.WriteStream | null = null;

  init(logDir?: string): void {
    const dir = logDir ?? path.join(process.cwd(), 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filename = `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    this.stream = fs.createWriteStream(path.join(dir, filename), { flags: 'a' });
    console.log(`[Tracer] Writing to ${path.join(dir, filename)}`);
  }

  /** Record an event. Always call this — it handles both memory + disk. */
  record(
    bot: string,
    botId: string,
    event: string,
    detail: string,
    ctx: Record<string, unknown> = {},
  ): void {
    const entry: TraceEvent = { ts: Date.now(), bot, botId, event, detail, ctx };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_MEMORY) this.buffer.shift();

    if (this.stream) {
      this.stream.write(JSON.stringify(entry) + '\n');
    }
  }

  /** Get recent events, optionally filtered by botId. */
  recent(n = 100, botId?: string): TraceEvent[] {
    const src = botId ? this.buffer.filter(e => e.botId === botId) : this.buffer;
    return src.slice(-n);
  }

  /** Get the last N events leading up to (and including) the most recent failure for a bot. */
  failureContext(botId: string, windowSize = 20): TraceEvent[] {
    const botEvents = this.buffer.filter(e => e.botId === botId);
    // Find last failure
    let lastFail = -1;
    for (let i = botEvents.length - 1; i >= 0; i--) {
      if (botEvents[i].event.includes('fail') || botEvents[i].event.includes('error')) {
        lastFail = i;
        break;
      }
    }
    if (lastFail === -1) return [];
    const start = Math.max(0, lastFail - windowSize);
    return botEvents.slice(start, lastFail + 1);
  }
}

/** Singleton — import and use directly. */
export const tracer = new Tracer();
