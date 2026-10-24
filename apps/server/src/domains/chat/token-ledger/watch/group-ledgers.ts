import { GATE_WINDOW_MS, type BurnPoint, type GatePoint, type LimitPoint } from './rules.ts';
import { EVENT_HOLD_MS } from './rules-util.ts';
import type { RedoPoint } from './rules-autonomy.ts';
import type { CommitFact } from './watch.types.ts';

/**
 * Списки сторожа поверх сессий: расход каждой группы (R8), живые замеры окна
 * аккаунта (R9) и тяжёлые проверки группы (R21). Сессия видит только себя; группа —
 * это несколько сессий и их субагенты, а окно одно на подписку. Ограничены сроком и потолком.
 */

/** Расход группы держим за два часа — порог R8 меряется окном до часа. */
const BURN_KEEP_MS = 120 * 60_000;
const BURN_CAP = 5000;
/** Живые замеры окна — за три часа: прогноз R9 смотрит назад не дальше. */
const LIMITS_KEEP_MS = 3 * 60 * 60_000;
const LIMITS_CAP = 1000;
/** Тяжёлых проверок группы — до полусотни за окно R21 (шесть часов). */
const HEAVY_CAP = 50;
/** Последний вызов разговора группы (R34) держим два часа: тёплым кэш дольше часа не бывает. */
const MAIN_KEEP_MS = 120 * 60_000;
/** Коммиты группы (R35) — за двенадцать часов, до сотни: стадия редко идёт дольше. */
const COMMITS_KEEP_MS = 12 * 60 * 60_000;
const COMMITS_CAP = 100;
/** Повторов закоммиченного (R35) — до полусотни за срок правила-события. */
const REDO_CAP = 50;

/** Последний вызов модели разговора группы (R34): чей, когда, окно, модель, стадия. */
export interface MainCall {
  t: number;
  ctx: number;
  model?: string;
  /** Разговор (id сессии или ключ прогона): пинг тёплого кэша находит его по id. */
  conversation: string;
  stage?: string;
  /** Пинг тёплого кэша после вызова (`keep-warm`): тёплым кэш считается от него. */
  warmedAt?: number;
}

/** Коммит разговора группы (R35): его правки и чей он. */
export interface GroupCommit extends CommitFact {
  conversation: string;
}

export const groupKeyOf = (parentChatId: string, groupIndex: number): string =>
  `${parentChatId}#${groupIndex}`;

export class GroupLedgers {
  private readonly burn = new Map<string, BurnPoint[]>();
  private readonly live: LimitPoint[] = [];
  private readonly heavy = new Map<string, GatePoint[]>();
  private readonly main = new Map<string, MainCall>();
  private readonly commits = new Map<string, GroupCommit[]>();
  private readonly redos = new Map<string, RedoPoint[]>();

  /** Вызов модели самого разговора группы (не субагента) — последний в группе (R34). */
  noteMain(groupKey: string, call: MainCall): void {
    const known = this.main.get(groupKey);
    if (known && known.t > call.t) return;
    this.main.set(groupKey, call);
  }

  mainOf(groupKey: string): MainCall | undefined {
    return this.main.get(groupKey);
  }

  /** Пинг тёплого кэша разговора: его последний вызов в группе тёплый от пинга. */
  warmed(conversation: string, at: number): void {
    for (const call of this.main.values()) {
      if (call.conversation === conversation) call.warmedAt = Math.max(call.warmedAt ?? 0, at);
    }
  }

  /** Коммит разговора группы (R35): его правки — работа, которую другой разговор не повторяет. */
  noteCommit(groupKey: string, commit: GroupCommit): void {
    const list = this.commits.get(groupKey) ?? [];
    list.push(commit);
    if (list.length > COMMITS_CAP) list.splice(0, list.length - COMMITS_CAP);
    this.commits.set(groupKey, list);
  }

  commitsOf(groupKey: string): readonly GroupCommit[] {
    return this.commits.get(groupKey) ?? [];
  }

  noteRedo(groupKey: string, point: RedoPoint): void {
    const list = this.redos.get(groupKey) ?? [];
    list.push(point);
    if (list.length > REDO_CAP) list.splice(0, list.length - REDO_CAP);
    this.redos.set(groupKey, list);
  }

  redosOf(groupKey: string): readonly RedoPoint[] {
    return this.redos.get(groupKey) ?? [];
  }

  /** Вызов модели в группе: звено, его субагент или остаток сверки — всё в расход. */
  noteCall(groupKey: string, point: BurnPoint): void {
    const list = this.burn.get(groupKey) ?? [];
    list.push(point);
    if (list.length > BURN_CAP) list.splice(0, list.length - BURN_CAP);
    this.burn.set(groupKey, list);
  }

  burnOf(groupKey: string): readonly BurnPoint[] {
    return this.burn.get(groupKey) ?? [];
  }

  noteLimit(point: LimitPoint): void {
    this.live.push(point);
    if (this.live.length > LIMITS_CAP) this.live.splice(0, this.live.length - LIMITS_CAP);
  }

  get limits(): readonly LimitPoint[] {
    return this.live;
  }

  /** Тяжёлая проверка в группе (R21): разговоры звеньев разные, счёт — общий. */
  noteHeavy(groupKey: string, point: GatePoint): void {
    const list = this.heavy.get(groupKey) ?? [];
    list.push(point);
    if (list.length > HEAVY_CAP) list.splice(0, list.length - HEAVY_CAP);
    this.heavy.set(groupKey, list);
  }

  heavyOf(groupKey: string): readonly GatePoint[] {
    return this.heavy.get(groupKey) ?? [];
  }

  /**
   * Группа на паузе (F-51): её расход и гейты до паузы — прошлое. Без этого R8 и R21
   * поднимались новым рядом сразу после снятия паузы по точкам, набранным до неё.
   */
  quiet(groupKey: string): void {
    this.burn.delete(groupKey);
    this.heavy.delete(groupKey);
    // Коммиты — не повод, а факт: новый разговор после паузы, переделывающий их, — R35.
    this.redos.delete(groupKey);
  }

  /** Старое — вон; группа без свежих вызовов забыта целиком. */
  prune(now: number): void {
    for (const [key, list] of this.burn) {
      const kept = list.filter((point) => now - point.t <= BURN_KEEP_MS);
      if (kept.length === 0) this.burn.delete(key);
      else this.burn.set(key, kept);
    }
    for (const [key, list] of this.heavy) {
      const kept = list.filter((point) => now - point.endedAt <= GATE_WINDOW_MS);
      if (kept.length === 0) this.heavy.delete(key);
      else this.heavy.set(key, kept);
    }
    for (const [key, call] of this.main) {
      if (now - Math.max(call.t, call.warmedAt ?? 0) > MAIN_KEEP_MS) this.main.delete(key);
    }
    for (const [key, list] of this.commits) {
      const kept = list.filter((commit) => now - commit.at <= COMMITS_KEEP_MS);
      if (kept.length === 0) this.commits.delete(key);
      else this.commits.set(key, kept);
    }
    for (const [key, list] of this.redos) {
      const kept = list.filter((point) => now - point.at <= EVENT_HOLD_MS);
      if (kept.length === 0) this.redos.delete(key);
      else this.redos.set(key, kept);
    }
    const fresh = this.live.filter((point) => now - point.t <= LIMITS_KEEP_MS);
    this.live.splice(0, this.live.length, ...fresh);
  }
}
