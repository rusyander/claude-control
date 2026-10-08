import type { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WatcherProblem,
  WatcherSpend,
  WatcherStatus,
  WatcherThresholds,
} from '@agentdeck/contracts';
import { readJsonFile, readTextFile, writeJsonFile } from '../../lib/safe-io/safe-io.ts';
import { killPidTree } from '../../lib/process-tree/process-tree.ts';
import { findPricing, costOf, type PricingLookup } from '../analytics/pricing.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  RunLedger,
} from '../chat/run-ledger/run-ledger.ts';
import {
  startAnalysis,
  WATCH_KNOWN_MAX,
  type AnalysisHandle,
  type KnownSection,
} from './analyzer.ts';
import { WatchEventStore } from './events.ts';
import { watcherRefusalDetail, type WatcherRoute } from './route.ts';
import {
  reportCounts,
  reportRefs,
  sectionsOf,
  WatchReportError,
  writeReportSections,
} from './report.ts';
import type { ReportLanguage } from './report-texts.ts';
import type {
  AnalysisOutcome,
  WatchEvent,
  WatchFinding,
  WatchSignal,
  WatcherState,
} from './types.ts';

/**
 * Фоновый наблюдатель: жизненный цикл.
 *
 * Включён — каждый сигнал о проблеме сразу склеивается с той же причиной и
 * СРАЗУ ложится разделом в отчёт (статус «проверяется»): человек видит находку
 * в момент обнаружения, а не после разбора. Затем, после короткой паузы
 * (проблемы приходят пачками — один 500 тянет за собой ошибку в логе и отказ на
 * странице), пачка уходит модели, и разделы переписываются уже со статусом.
 * Нет новых сигналов — нет и вызовов модели: тратится только на настоящие
 * проблемы. Сверх потолка разборов в час новое ждёт следующего часа — сигналы
 * пишутся по-прежнему, а в статусе висит «потолок достигнут».
 *
 * Состояние (тумблер, начало, расход, моменты разборов) — в
 * `<appData>/watcher.json`, файле самой панели, а не в `~/.claude`: переживает
 * перезапуск, и включённый наблюдатель после старта продолжает с того, что не
 * успел разобрать. Выключили — процесс разбора снимается деревом немедленно;
 * его номер лежит в своём журнале (`watcher-runs.json`), и сирота прошлого
 * запуска панели добивается на старте.
 */

export const WATCHER_STATE_FILE = 'watcher.json';
export const WATCHER_LEDGER_FILE = 'watcher-runs.json';
/** Пауза перед разбором: проблемы одной причины приходят пачкой. */
export const WATCH_DEBOUNCE_MS = 4000;
/** Сколько проблем за один вызов модели. */
export const WATCH_BATCH_MAX = 10;
/** Потолок разборов в час: наблюдатель, забытый включённым, не выест окно подписки. */
export const WATCH_RUNS_PER_HOUR = 12;
export const WATCH_DEFAULT_THRESHOLDS: WatcherThresholds = {
  slowRequestMs: 5000,
  stuckLoadingMs: 30_000,
};
const HOUR_MS = 60 * 60_000;
/** Сколько помнить номер своего процесса после выхода: событие выхода может прийти позже. */
const OWN_PID_TTL_MS = 60_000;
const LEDGER_KEY = 'watcher';

const ZERO_SPEND: WatcherSpend = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, runs: 0 };

export interface BackgroundWatcherDeps {
  appDataDir: () => string;
  reportPath: () => string;
  /** Корень приложения — рабочий каталог разбора. */
  cwd: string;
  /** Команда CLI, найденная в PATH; `undefined` — CLI нет. */
  resolveCommand: () => string | undefined;
  /** Дешёвая ступень модели (`haiku` у Claude). */
  model: () => string | undefined;
  /**
   * Маршрут разбора на ЭТОТ разбор (`route.ts`): облако вендора, контур профиля
   * «Ассистент панели» или отказ. Не задан — прежний путь, облако вендора.
   */
  resolveRoute?: () => WatcherRoute;
  pricing: () => PricingLookup;
  /** Язык интерфейса панели — язык отчёта; нет — русский. */
  language?: () => ReportLanguage;
  spawnImpl?: typeof nodeSpawn;
  debounceMs?: number;
  timeoutMs?: number;
  runsPerHour?: number;
  thresholds?: Partial<WatcherThresholds>;
  now?: () => Date;
}

export class BackgroundWatcher {
  private readonly deps: BackgroundWatcherDeps;
  readonly events: WatchEventStore;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: AnalysisHandle | undefined;
  /** Номер включения: ответ разбора прошлого включения не пишет в нынешнее. */
  private generation = 0;
  /** Свой запуск CLI: его отказ — не сигнал о сбое (иначе круг без конца). */
  private selfSpawning = false;
  /** Свои процессы разбора: их выход с ошибкой — не новый сигнал. */
  private readonly ownPids = new Set<number>();
  private idle: Promise<void> = Promise.resolve();

  constructor(deps: BackgroundWatcherDeps) {
    this.deps = deps;
    this.events = new WatchEventStore(deps.appDataDir, undefined, reportRefs(deps.reportPath));
  }

  private nowDate(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private now(): string {
    return this.nowDate().toISOString();
  }

  private stateFile(): string {
    return join(this.deps.appDataDir(), WATCHER_STATE_FILE);
  }

  get thresholds(): WatcherThresholds {
    return { ...WATCH_DEFAULT_THRESHOLDS, ...(this.deps.thresholds ?? {}) };
  }

  private get runsPerHour(): number {
    // Не меньше одного, как у настройки на старте (`bootstrap/watcher/watcher.ts`): при
    // нуле пустой список разборов давал `Math.min()` = ∞ и RangeError даты.
    return Math.max(1, this.deps.runsPerHour ?? WATCH_RUNS_PER_HOUR);
  }

  readState(): WatcherState {
    // `readJsonFile` бросает на испорченном JSON — и старт панели падал в `resume`.
    // Нечитаемое состояние = выключен: наблюдатель тратит деньги, и молча включённым
    // он не остаётся; включение человеком перепишет файл целым.
    let state: Partial<WatcherState>;
    try {
      state = readJsonFile<Partial<WatcherState>>(this.stateFile(), {});
    } catch {
      state = {};
    }
    return {
      enabled: state.enabled === true,
      ...(state.since ? { since: state.since } : {}),
      spend: { ...ZERO_SPEND, ...(state.spend ?? {}) },
      ...(state.problem ? { problem: state.problem } : {}),
      ...(Array.isArray(state.runTimes) ? { runTimes: state.runTimes } : {}),
    };
  }

  private writeState(state: WatcherState): void {
    writeJsonFile(this.stateFile(), state, { preserveForm: false });
  }

  private setProblem(problem: Omit<WatcherProblem, 'at'> | undefined): void {
    const state = this.readState();
    if (problem) state.problem = { ...problem, at: this.now() };
    else delete state.problem;
    this.writeState(state);
  }

  private clearProblem(code: WatcherProblem['problemCode']): void {
    if (this.readState().problem?.problemCode === code) this.setProblem(undefined);
  }

  /** Разборы за последний час — от них считается потолок. */
  private recentRuns(state: WatcherState): string[] {
    const from = this.nowDate().getTime() - HOUR_MS;
    return (state.runTimes ?? []).filter((at) => Date.parse(at) > from);
  }

  status(): WatcherStatus {
    const state = this.readState();
    const reportPath = this.deps.reportPath();
    const counts = reportCounts(reportPath);
    return {
      enabled: state.enabled,
      ...(state.enabled && state.since ? { since: state.since } : {}),
      serverNow: this.now(),
      analyzing: this.current !== undefined,
      pending: state.enabled ? this.events.pending().length : 0,
      findings: counts.findings,
      remarks: counts.remarks,
      thresholds: this.thresholds,
      hourlyCap: { limit: this.runsPerHour, used: this.recentRuns(state).length },
      spend: state.spend,
      reportPath,
      ...(state.problem ? { problem: state.problem } : {}),
    };
  }

  isEnabled(): boolean {
    return this.readState().enabled;
  }

  /** Тумблер. Включение начинает счёт заново; выключение снимает разбор сразу. */
  setEnabled(enabled: boolean): WatcherStatus {
    const state = this.readState();
    if (enabled === state.enabled) return this.status();
    this.generation += 1;
    if (!enabled) {
      this.stopNow();
      this.writeState({
        enabled: false,
        spend: state.spend,
        ...(state.runTimes ? { runTimes: this.recentRuns(state) } : {}),
      });
      return this.status();
    }
    this.events.clear();
    // Моменты разборов остаются: выключить-включить — не способ обойти потолок.
    this.writeState({
      enabled: true,
      since: this.now(),
      spend: { ...ZERO_SPEND },
      runTimes: this.recentRuns(state),
    });
    this.checkCli();
    return this.status();
  }

  /** Старт панели: сирота прошлого запуска добивается, включённый продолжает. */
  resume(): void {
    this.reapOrphans();
    if (!this.isEnabled()) return;
    this.checkCli();
    if (this.events.pending().length > 0) this.schedule();
  }

  /** CLI нет в PATH — сказать словами сразу, а не молча копить неразобранное. */
  private checkCli(): boolean {
    if (this.deps.resolveCommand()) {
      this.clearProblem('cli_missing');
      return true;
    }
    this.setProblem({
      problemCode: 'cli_missing',
      message:
        'Claude Code не найден в PATH: проблемы записываются в отчёт, но сверить их с кодом нечем. ' +
        'Установите CLI и перезапустите панель.',
    });
    return false;
  }

  /**
   * Сигнал о проблеме. Выключен — `false` и ничего не пишется. Включён — запись
   * в кольцо, раздел в отчёт немедленно и разбор после паузы.
   */
  signal(signal: WatchSignal): boolean {
    if (signal.kind === 'spawn-failed' && this.selfSpawning) return false;
    if (signal.kind === 'cli-exit' && signal.pid !== undefined && this.ownPids.has(signal.pid)) {
      return false;
    }
    let state: WatcherState;
    try {
      state = this.readState();
    } catch {
      return false;
    }
    if (!state.enabled) return false;
    const { event, kept } = this.events.record(signal, this.now());
    // Вытеснен потолком в том же вызове — раздела без записи и разбора не пишем.
    if (kept) this.writeReport([event]);
    this.schedule();
    return true;
  }

  private language(): ReportLanguage {
    return this.deps.language?.() ?? 'ru';
  }

  private writeReport(events: readonly WatchEvent[], removed: readonly string[] = []): void {
    try {
      writeReportSections(this.deps.reportPath(), events, removed, this.language());
      this.clearProblem('report_unwritable');
    } catch (error) {
      // Отчёт не записался — наблюдатель живёт дальше: проблема лежит в кольце
      // и ляжет в отчёт следующей записью, а человек видит причину в статусе.
      if (error instanceof WatchReportError) {
        this.setProblem({
          problemCode: 'report_unwritable',
          message: `Отчёт не записывается: ${error.path}`,
          detail: error.reason,
        });
        return;
      }
      throw error;
    }
  }

  private schedule(delayMs = this.deps.debounceMs ?? WATCH_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Отказ разбора из таймера некому ловить, а обработчика `unhandledRejection` у
      // сервера нет — процесс падал. Пачка остаётся в кольце до следующего сигнала.
      this.idle = this.runOnce().catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }

  /** Дождаться конца текущего разбора (для проверок). */
  async settled(): Promise<void> {
    while (this.timer || this.current) {
      await this.idle;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Разделы отчёта, которые модель должна знать, чтобы ссылаться, а не дублировать. */
  private knownSections(batch: readonly WatchEvent[]): KnownSection[] {
    const path = this.deps.reportPath();
    let sections;
    try {
      sections = existsSync(path) ? sectionsOf(readTextFile(path)) : new Map();
    } catch {
      return [];
    }
    const inBatch = new Set(batch.map((event) => event.id));
    return [...sections.entries()]
      .filter(([id]) => !inBatch.has(id))
      .map(([, meta]) => ({
        ref: meta.ref,
        entryClass: meta.entryClass,
        title: meta.title,
        ...(meta.location ? { location: meta.location } : {}),
      }))
      .slice(-WATCH_KNOWN_MAX);
  }

  /**
   * Потолок в час: достигнут — статус говорит словами, до какого времени, и
   * разбор сам встаёт в очередь на момент, когда освободится место.
   */
  private capReached(): boolean {
    const state = this.readState();
    const recent = this.recentRuns(state);
    if (recent.length < this.runsPerHour) {
      this.clearProblem('hourly_cap');
      return false;
    }
    const oldest = Math.min(...recent.map((at) => Date.parse(at)));
    const freeAt = new Date(oldest + HOUR_MS);
    this.setProblem({
      problemCode: 'hourly_cap',
      message:
        `Достигнут потолок: ${this.runsPerHour} разборов в час. Проблемы по-прежнему пишутся в ` +
        `отчёт со статусом «проверяется», разбор продолжится в ${freeAt.toISOString().slice(11, 16)} UTC.`,
      detail: freeAt.toISOString(),
    });
    this.schedule(Math.max(1000, freeAt.getTime() - this.nowDate().getTime() + 1000));
    return true;
  }

  /** Разобрать пачку сейчас (паузу уже выждали). */
  async runOnce(): Promise<void> {
    if (this.current || !this.isEnabled()) return;
    const batch = this.events.pending().slice(0, WATCH_BATCH_MAX);
    if (batch.length === 0) return;
    const command = this.deps.resolveCommand();
    if (!command) {
      this.checkCli();
      return;
    }
    // Маршрут — до потолка и до записи времени разбора: отказ не тратит разбор
    // из часового потолка и не запускает процесс мимо выбранного маршрута.
    const route = this.deps.resolveRoute?.() ?? { ok: true, env: {}, viaContour: false };
    if (!route.ok) {
      this.setProblem({
        problemCode: 'route_refused',
        message: route.message,
        detail: watcherRefusalDetail(route, this.language()),
      });
      return;
    }
    this.clearProblem('route_refused');
    if (this.capReached()) return;
    // Разбор пошёл — отложенный на «освободится место» больше не нужен.
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const generation = this.generation;
    const seen = new Map(batch.map((event) => [event.id, event.count]));
    // Разбор идёт минуты, и смерть панели посреди него — самое вероятное место
    // потерять кольцо: пачка уходит на диск до запуска, а не по окну записи.
    this.events.flush();
    const ledger = this.ledger();
    const state = this.readState();
    this.writeState({ ...state, runTimes: [...this.recentRuns(state), this.now()] });

    this.selfSpawning = true;
    let handle: AnalysisHandle;
    try {
      handle = startAnalysis({
        command,
        cwd: this.deps.cwd,
        // Через контур модель задаёт профиль: дешёвую ступень вендора контур отклонил бы.
        ...(route.viaContour ? {} : { model: this.deps.model() }),
        env: route.env,
        events: batch,
        known: this.knownSections(batch),
        language: this.language(),
        spawnImpl: this.deps.spawnImpl,
        timeoutMs: this.deps.timeoutMs,
        onSpawn: (pid) => {
          this.ownPids.add(pid);
          ledger.upsert({ key: LEDGER_KEY, pid, cwd: this.deps.cwd, startedAt: Date.now() });
        },
        onExit: () => ledger.remove(LEDGER_KEY),
      });
    } finally {
      this.selfSpawning = false;
    }
    this.current = handle;
    const outcome = await handle.done;
    if (this.current === handle) this.current = undefined;
    this.forgetOwnPidsLater();
    if (outcome.stopped || generation !== this.generation) return;
    this.applyOutcome(batch, seen, outcome);
    // Не всё уместилось в пачку — следующая пачка, без новой паузы на сигнал.
    if (outcome.ok && this.events.pending().length > 0) this.schedule();
  }

  private forgetOwnPidsLater(): void {
    const pids = [...this.ownPids];
    const timer = setTimeout(() => {
      for (const pid of pids) this.ownPids.delete(pid);
    }, OWN_PID_TTL_MS);
    timer.unref?.();
  }

  private applyOutcome(
    batch: readonly WatchEvent[],
    seen: ReadonlyMap<string, number>,
    outcome: AnalysisOutcome,
  ): void {
    this.addSpend(outcome.usage);
    if (!outcome.ok) {
      // Неудачный разбор не повторяется сам: проблемы остаются «проверяется» и
      // уйдут модели со следующим сигналом. Иначе упавший CLI крутился бы по кругу.
      this.setProblem({
        problemCode: 'analysis_failed',
        message: 'Разбор проблем моделью не удался.',
        ...(outcome.error ? { detail: outcome.error } : {}),
      });
      return;
    }
    const findings = new Map(outcome.findings);
    for (const event of batch) {
      if (findings.has(event.id)) continue;
      findings.set(event.id, {
        title: event.message.split('\n')[0]!.slice(0, 120),
        happened: 'Модель не вернула вердикт по этой проблеме.',
        context: '',
        verdict: 'unclear',
      } satisfies WatchFinding);
    }
    this.events.markAnalyzed(seen, findings);

    // Та же причина, доказанная моделью: раздел вливается в другой и из отчёта уходит.
    const removed: string[] = [];
    const touched = new Set(batch.map((event) => event.id));
    for (const [from, into] of outcome.merges ?? []) {
      const merged = this.events.merge(from, into);
      if (!merged) continue;
      removed.push(merged.removed.id);
      touched.delete(merged.removed.id);
      touched.add(merged.into.id);
    }
    for (const remark of outcome.remarks ?? []) {
      touched.add(this.events.recordRemark(remark, this.now()).event.id);
    }
    const byId = new Map(this.events.list().map((event) => [event.id, event]));
    const updated = [...touched].map((id) => byId.get(id)).filter(Boolean) as WatchEvent[];
    this.writeReport(updated, removed);
    this.clearProblem('analysis_failed');
  }

  private addSpend(usage: AnalysisOutcome['usage']): void {
    const state = this.readState();
    const spend = { ...state.spend };
    spend.input += usage.input;
    spend.output += usage.output;
    spend.cacheRead += usage.cacheRead;
    spend.cacheCreation += usage.cacheCreation;
    spend.runs += 1;
    // Оценка — только когда модель есть в прайсе: цифра по чужому тарифу хуже,
    // чем честное «не посчитано».
    const model = usage.model ?? this.deps.model();
    const price = model ? findPricing(model, this.deps.pricing()) : undefined;
    if (price) {
      spend.estimatedUsd = (spend.estimatedUsd ?? 0) + costOf(price, usage);
    }
    this.writeState({ ...state, spend });
  }

  private ledger(): RunLedger {
    return new RunLedger(this.deps.appDataDir(), WATCHER_LEDGER_FILE);
  }

  private stopNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const handle = this.current;
    this.current = undefined;
    handle?.stop();
  }

  /**
   * Выход панели: разбор снимается, тумблер остаётся как был, кольцо сбоев
   * уходит на диск сейчас, а не по окну отложенной записи.
   */
  shutdown(): void {
    this.generation += 1;
    this.stopNow();
    this.events.flush();
  }

  /**
   * Живой процесс разбора из журнала — сирота прошлой жизни панели: снимаем.
   * `startedAt` записан сразу после запуска (`onSpawn`), поэтому годится как
   * `spawnedAt`: номер, который с тех пор занял чужой процесс, не тронем.
   */
  reapOrphans(
    kill: (pid: number, startedAt: number) => unknown = (pid, startedAt) =>
      killPidTree(pid, { spawnedAt: startedAt }),
  ): number {
    const ledger = this.ledger();
    const entries = ledger.read();
    const { adopt: alive } = adoptableEntries(entries, {
      isAlive: isPidAlive,
      looksLikeCli: pidLooksLikeCli,
    });
    const kept = new Set<string>();
    for (const entry of alive) {
      const pid = entry.pid as number;
      const killed = kill(pid, entry.startedAt);
      // Ничего не снято, а номер жив: сверить его нечем (нет снимка, F-205) —
      // вслепую не снимаем, но и запись не стираем, иначе сирота жила бы дальше
      // без присмотра (F-145, то же у `reapPanelAgentOrphans`). Следующий старт
      // попробует снова; следующий разбор перепишет запись своим процессом.
      if (Array.isArray(killed) && killed.length === 0 && isPidAlive(pid)) kept.add(entry.key);
    }
    for (const entry of entries) if (!kept.has(entry.key)) ledger.remove(entry.key);
    return alive.length - kept.size;
  }
}
