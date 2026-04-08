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
export declare function install(): void;
/** Returns the most recent `n` entries, newest last. */
export declare function recent(n?: number): LogEntry[];
//# sourceMappingURL=LogBuffer.d.ts.map