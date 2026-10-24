import type { WatchState } from '../watch.types.ts';
import type { ResumeSeed } from './group-watcher.types.ts';

/** Затравок продолжения держим не больше: дерево — десятки разговоров. */
const SEEDS_CAP = 200;

/** Затравка по состоянию сессии: конец последнего вызова, база и отметка пинга. */
export function seedOf(state: {
  lastCallAt: number;
  firstCtx?: number | undefined;
  warmedAt?: number | undefined;
  lastCacheRead?: number | undefined;
}): ResumeSeed {
  return {
    lastCallAt: state.lastCallAt,
    ...(state.firstCtx !== undefined ? { firstCtx: state.firstCtx } : {}),
    ...(state.warmedAt !== undefined ? { warmedAt: state.warmedAt } : {}),
    ...(state.lastCacheRead !== undefined ? { lastCacheRead: state.lastCacheRead } : {}),
  };
}

/**
 * Затравки забытых сессий: ключ разговора (чат или sessionId) → конец последнего
 * вызова, база окна и отметка пинга. Правилу холодной записи (R2) они нужны,
 * когда разговор продолжат через час, а полного состояния сессии уже нет.
 */
export class ResumeSeeds {
  private readonly seeds = new Map<string, ResumeSeed>();

  /**
   * Пинг тёплого кэша у сессии, которой нет под наблюдением: отметка ложится в
   * затравку (общую у всех ключей разговора — видна под каждым), а нет её —
   * заводится новая с концом последнего вызова, который дала проводка.
   */
  warm(sessionId: string, at: number, lastCallAt: number): void {
    const seed = this.seeds.get(sessionId);
    if (seed) {
      seed.warmedAt = Math.max(seed.warmedAt ?? 0, at);
      return;
    }
    this.seeds.set(sessionId, { lastCallAt, warmedAt: at });
    this.trim();
  }

  /**
   * Затравка нового разговора: своя по ключам, иначе — сессии, от которой он
   * ответвлён (`parent` — её живое состояние, если она под наблюдением).
   */
  seedFor(
    keys: ReadonlyArray<string | undefined>,
    forkOf: string | undefined,
    parent: WatchState | undefined,
  ): ResumeSeed | undefined {
    const own = keys.map((key) => (key ? this.seeds.get(key) : undefined)).find(Boolean);
    if (own || !forkOf) return own;
    if (parent?.lastCallAt === undefined) return this.seeds.get(forkOf);
    return seedOf({ ...parent, lastCallAt: parent.lastCallAt });
  }

  /** Сессия забыта посреди живой группы — её затравка под каждым ключом разговора. */
  keep(aliases: Iterable<string>, state: WatchState & { lastCallAt: number }): void {
    const seed = seedOf(state);
    for (const alias of aliases) {
      this.seeds.delete(alias);
      this.seeds.set(alias, seed);
    }
    this.trim();
  }

  private trim(): void {
    while (this.seeds.size > SEEDS_CAP) {
      this.seeds.delete(this.seeds.keys().next().value as string);
    }
  }
}
