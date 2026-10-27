import { GATE_WINDOW_MS, type BurnPoint, type GatePoint, type LimitPoint } from './rules.ts';
import { EVENT_HOLD_MS } from './rules-util.ts';
import type { RedoPoint } from './rules-autonomy.ts';
import type { CommitFact } from './watch.types.ts';
import type { EditedFile } from './group-watcher/restart-rules.ts';
import type { LedgerCheckRun } from './group-watcher/ledger-rules.ts';

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
/** Правок дерева группы — до пяти сотен за окно R21: граница прохода нужна только там. */
const EDITS_CAP = 500;
/**
 * Правленых файлов группы (R38) — за три часа, до пяти сотен: перезапуск ждёт конца ходов
 * без предела, и правка, которую он ждёт, бывает старше часа.
 */
const FILES_KEEP_MS = 3 * 60 * 60_000;
const FILES_CAP = 500;
/** Проверок группы для R41 — за полчаса суда и до сотни; начатые — до сотни, пока не кончатся. */
const RUNS_KEEP_MS = EVENT_HOLD_MS;
const RUNS_CAP = 100;

/**
 * Вызов разговора группы, потраченный впустую (R46): за ним повтор (проверка без правки,
 * перечитывание, тот же сбой, сон — проверка) или отказ стража. Один вызов — одна запись.
 */
export interface WastePoint {
  t: number;
  weight: number;
  kind: 'repeat' | 'denied';
}

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
  private readonly waste = new Map<string, WastePoint[]>();
  private readonly live: LimitPoint[] = [];
  private readonly heavy = new Map<string, GatePoint[]>();
  private readonly main = new Map<string, MainCall>();
  private readonly commits = new Map<string, GroupCommit[]>();
  private readonly redos = new Map<string, RedoPoint[]>();
  private readonly edits = new Map<string, number[]>();
  private readonly files = new Map<string, EditedFile[]>();
  private readonly runs = new Map<string, LedgerCheckRun[]>();
  /** Начатые проверки (id вызова → группа и начало): кончатся — лягут в `runs`. */
  private readonly openRuns = new Map<string, { groupKey: string } & Omit<LedgerCheckRun, 'end'>>();

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

  /**
   * Вызов группы впустую (R46): второй шаг впустую за тем же вызовом его не удваивает. Отказ
   * перекрывает повтор: отбитая повторная проверка не шла — это отказ, не прогон.
   */
  noteWaste(groupKey: string, point: WastePoint): void {
    const list = this.waste.get(groupKey) ?? [];
    const known = list.find((one) => one.t === point.t);
    if (known) {
      if (point.kind === 'denied') known.kind = 'denied';
      return;
    }
    list.push(point);
    if (list.length > BURN_CAP) list.splice(0, list.length - BURN_CAP);
    this.waste.set(groupKey, list);
  }

  wasteOf(groupKey: string): readonly WastePoint[] {
    return this.waste.get(groupKey) ?? [];
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

  /** Правка дерева любым разговором группы — граница прохода гейтов (R21). */
  noteTreeEdit(groupKey: string, t: number): void {
    const list = this.edits.get(groupKey) ?? [];
    list.push(t);
    if (list.length > EDITS_CAP) list.splice(0, list.length - EDITS_CAP);
    this.edits.set(groupKey, list);
  }

  /** Правленый файл группы (R38): перезапуск панели, ждущий этот файл, — из-за неё. */
  noteEditedFile(groupKey: string, file: EditedFile): void {
    const list = this.files.get(groupKey) ?? [];
    list.push(file);
    if (list.length > FILES_CAP) list.splice(0, list.length - FILES_CAP);
    this.files.set(groupKey, list);
  }

  editedFilesOf(groupKey: string): readonly EditedFile[] {
    return this.files.get(groupKey) ?? [];
  }

  /** Правленые файлы всех групп — на диск: перезапуск, который они вызвали, гасит этот процесс. */
  editedFilesSnapshot(): Record<string, EditedFile[]> {
    return Object.fromEntries([...this.files].map(([key, list]) => [key, [...list]]));
  }

  /** Список с диска после перезапуска: только свежее `FILES_KEEP_MS`, в пределах потолка. */
  restoreEditedFiles(saved: Record<string, readonly EditedFile[]>, now: number): void {
    for (const [key, list] of Object.entries(saved)) {
      const kept = list
        .filter((file) => now - file.at <= FILES_KEEP_MS)
        .slice(-FILES_CAP)
        .map((file) => ({ at: file.at, path: file.path }));
      if (kept.length > 0) this.files.set(key, kept);
    }
  }

  /** Вызов группы начал проверку, которую журнал проверок обязан увидеть (R41). */
  openCheckRun(groupKey: string, id: string, run: Omit<LedgerCheckRun, 'end'>): void {
    this.openRuns.set(id, { groupKey, ...run });
    if (this.openRuns.size > RUNS_CAP) this.openRuns.delete(this.openRuns.keys().next().value!);
  }

  /** Ответ вызова: проверка кончилась (`ran`) — в список группы; отбитая стражем — забыта. */
  closeCheckRun(id: string, end: number, ran: boolean): void {
    const open = this.openRuns.get(id);
    if (!open) return;
    this.openRuns.delete(id);
    if (!ran) return;
    const { groupKey, ...run } = open;
    const list = this.runs.get(groupKey) ?? [];
    list.push({ ...run, end });
    if (list.length > RUNS_CAP) list.splice(0, list.length - RUNS_CAP);
    this.runs.set(groupKey, list);
  }

  checkRunsOf(groupKey: string): readonly LedgerCheckRun[] {
    return this.runs.get(groupKey) ?? [];
  }

  /** Последняя правка дерева группы не позже `at`; правок нет — 0. */
  passOf(groupKey: string, at: number): number {
    let pass = 0;
    for (const t of this.edits.get(groupKey) ?? []) if (t <= at && t > pass) pass = t;
    return pass;
  }

  /**
   * Группа на паузе (F-51): её расход и гейты до паузы — прошлое. Без этого R8 и R21
   * поднимались новым рядом сразу после снятия паузы по точкам, набранным до неё.
   */
  quiet(groupKey: string): void {
    this.burn.delete(groupKey);
    this.waste.delete(groupKey);
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
    for (const [key, list] of this.waste) {
      const kept = list.filter((point) => now - point.t <= BURN_KEEP_MS);
      if (kept.length === 0) this.waste.delete(key);
      else this.waste.set(key, kept);
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
    for (const [key, list] of this.edits) {
      // Последняя правка старше окна — всё ещё граница прохода свежего гейта: её держим.
      const kept = list.filter((t, i) => now - t <= GATE_WINDOW_MS || i === list.length - 1);
      this.edits.set(key, kept);
      if (!this.heavy.has(key) && kept.every((t) => now - t > GATE_WINDOW_MS))
        this.edits.delete(key);
    }
    for (const [key, list] of this.files) {
      const kept = list.filter((file) => now - file.at <= FILES_KEEP_MS);
      if (kept.length === 0) this.files.delete(key);
      else this.files.set(key, kept);
    }
    for (const [key, list] of this.runs) {
      const kept = list.filter((run) => now - run.end <= RUNS_KEEP_MS);
      if (kept.length === 0) this.runs.delete(key);
      else this.runs.set(key, kept);
    }
    for (const [id, run] of this.openRuns) {
      // Ответа нет часами — вызов потерян (сессию забыли), а не идёт.
      if (now - run.start > FILES_KEEP_MS) this.openRuns.delete(id);
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
