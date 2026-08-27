import { Bot as MineflayerBot } from 'mineflayer';

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Minimum empty inventory slots before the bot considers itself "full". */
export const INVENTORY_FULL_THRESHOLD = 5;

export function isInventoryFull(mfBot: MineflayerBot): boolean {
  const empty = (mfBot.inventory as unknown as { emptySlotCount(): number }).emptySlotCount?.() ?? 0;
  return empty < INVENTORY_FULL_THRESHOLD;
}

export function getEmptySlots(mfBot: MineflayerBot): number {
  return (mfBot.inventory as unknown as { emptySlotCount(): number }).emptySlotCount?.() ?? 0;
}

/** Returns current time as HH:MM:SS.mmm — used in log messages across all behaviors. */
export function ts(): string {
  const d = new Date();
  return (
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}
