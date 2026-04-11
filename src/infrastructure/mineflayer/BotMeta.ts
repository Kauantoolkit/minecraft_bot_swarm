import { Bot as MineflayerBot } from 'mineflayer';
import { Bot } from '../../domain/entities/Bot';

/**
 * Per-bot runtime metadata.
 *
 * Each behavior module owns a subset of these fields.
 * Fields are grouped by owning module in comments to make it clear
 * which behavior is responsible for setting/clearing each one.
 */
export interface BotMeta {
  // ── Movement / PvP (shared slot — last writer wins) ─────────────────────
  /** Installed by follow() and pvp(). Starting either removes the other. */
  pvpListener?: () => void;
  /** Companion path_update listener installed alongside pvpListener by follow(). */
  followPathUpdateListener?: (r: { status: string }) => void;


  isInterrupted?: boolean;

  // ── Guard / Bodyguard (shared slot — last writer wins) ──────────────────
  /** Installed by guard() and bodyguard(). Starting either removes the other. */
  guardListener?: () => void;

  // ── Defend — background, independent of the primary mode ────────────────
  defendListener?: () => void;
  _defendHurtListener?: (e: unknown) => void;
  _defendPathUpdateListener?: (r: { status: string }) => void;

  // ── Avoid ────────────────────────────────────────────────────────────────
  avoidListener?: () => void;

  // ── Async loop flags ─────────────────────────────────────────────────────
  farmingActive?: boolean;
  exploringActive?: boolean;

  // ── Cross-mode communication ─────────────────────────────────────────────
  /**
   * Populated by async loop modes (explore, farm) at the start of each leg/cycle.
   * Defend calls this when returning to idle so the mode resumes immediately
   * instead of waiting for the 30 s leg timeout.
   */
  resumeCallback?: () => void;

  // ── Display ──────────────────────────────────────────────────────────────
  /** Human-readable active mode shown in the debug status UI. */
  activeMode: string;
}

/**
 * Thin wrapper around WeakMap<Bot, BotMeta> with lazy initialisation.
 *
 * Behaviors receive this store via the adapter and call `store.get(bot)` to
 * read/write their fields without needing to reach into the adapter's internals.
 */
export class MetaStore {
  private readonly map = new WeakMap<Bot, BotMeta>();

  get(bot: Bot): BotMeta {
    if (!this.map.has(bot)) this.map.set(bot, { activeMode: 'idle' });
    return this.map.get(bot)!;
  }

  /** Returns the mineflayer bot handle typed correctly, or null if not set. */
  static mfBot(bot: Bot): MineflayerBot | null {
    return (bot.handle as MineflayerBot | null) ?? null;
  }
}
