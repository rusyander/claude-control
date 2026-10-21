import { randomUUID } from 'node:crypto';
import type { GroupSignal, GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { RunWatchFeed } from '../../ChatRunRegistry/ChatRunRegistry.types.ts';
import type { LearnedDurations } from './check-signature.ts';
import { createWatchState, reduce } from './reduce.ts';
import { evaluate } from './rules.ts';
import { clearChatSignals, mergeSignals, signalsToNotify } from './signals.ts';
import { streamWatchEvents } from './stream-events.ts';
import { TranscriptTail } from './tail.ts';
import { createTranscriptReader } from './transcript-events.ts';
import type { WatchContext, WatchEvent, WatchNode, WatchState } from './watch.types.ts';

/**
 * Сторож групп разделения (фаза 2, W): живой поток прогона звена → состояние
 * сессии → правила → сигналы на записи группы и, по важности, в Telegram.
 * Ноль вызовов модели и ни одного тормоза: только наблюдение.
 *
 * Состояние живёт на РАЗГОВОР, не на прогон. Сессия, чей ход кончился больше
 * `IDLE_DROP_MS` назад и чей вопрос человеку не висит, или звено, чья группа
 * кончилась, — забываются, их активные сигналы закрываются. От забытой сессии
 * остаётся затравка — конец её последнего вызова и база окна: правилу холодной
 * записи (R2) она нужна, когда разговор продолжат через час.
 *
 * Активный сигнал без сессии (панель перезапускалась, сторож выключали) никто
 * не подтверждает: он закрывается — сразу, если группа кончилась или сторож
 * выключен, иначе через `IDLE_DROP_MS` после старта сторожа, если разговор так
 * и не дал о себе знать. Прогон, подхваченный после перезапуска без потока
 * (`detached`), читается хвостом своего транскрипта — с конца файла.
 */

/** Как часто смотреть на время: R1/R1b, срок правил-событий, хвост субагентов. */
export const WATCH_TICK_MS = 60_000;
/** Тишина после конца хода, за которой полное состояние сессии больше не держим. */
export const IDLE_DROP_MS = 10 * 60_000;
/** Затравок продолжения держим не больше: дерево — десятки разговоров. */
const SEEDS_CAP = 200;

interface ResumeSeed {
  lastCallAt: number;
  firstCtx?: number;
}

/** Звено, к которому относится разговор: из связи в хранилище разделения. */
export interface WatchTarget {
  /** Ключ разговора для ссылки «открыть чат» — под ним связь записана. */
  chatId: string;
  parentChatId: string;
  groupIndex: number;
  stage?: string;
  /** Каталог копии звена: чтения внутри неё — свои (R7). */
  cwd?: string;
}

export interface GroupWatcherDeps {
  settings: () => GroupWatch;
  /** Звено по ключам прогона; не звено группы — `undefined`, сторож молчит. */
  resolve: (chatId: string, sessionId?: string) => WatchTarget | undefined;
  /** Живая запись группы (правится на месте, как конвейером). */
  group: (parentChatId: string, groupIndex: number) => SplitPlanGroupRecord | undefined;
  /** Записать разделение родителя на диск. */
  save: (parentChatId: string) => void;
  /** Все разделения (живые записи): закрыть активные сигналы, за которыми сессии нет. */
  plans?: () => Record<string, { groups: readonly SplitPlanGroupRecord[] }>;
  /** Что знает панель о звене сейчас: идёт ли группа, вопрос человеку, очередь. */
  node: (target: WatchTarget, keys: readonly string[]) => Omit<WatchNode, 'chatId' | 'groupIndex'>;
  /** Каталог транскриптов субагентов сессии; нет — хвоста нет. */
  subagentDir?: (sessionId: string) => string | undefined;
  /** Транскрипт самой сессии — для прогона без потока (`detached`). */
  transcript?: (sessionId: string) => string | undefined;
  /** Настоящий ключ разговора: временный `new-…` после рождения сессии — её id. */
  canonical?: (chatId: string) => string;
  /** Сигнал «внимание»/«тревога» поднят впервые (или вырос) — уведомить. */
  notify?: (signal: GroupSignal, target: WatchTarget) => void;
  panelRoot?: string;
  learned?: () => LearnedDurations | undefined;
  now?: () => number;
  makeId?: () => string;
  log?: (message: string, error?: unknown) => void;
}

interface Session {
  state: WatchState;
  target: WatchTarget;
  keys: Set<string>;
  sessionId?: string;
  node: Omit<WatchNode, 'chatId' | 'groupIndex'>;
  /** Хвост субагентов дал вызовы в этом ходе — остаток сверки в поток не берём (двойной счёт). */
  tailCalls: number;
  readTail?: (row: unknown) => WatchEvent[];
  /** Прогон без потока (подхвачен после перезапуска): сессия читается из своего транскрипта. */
  detached?: boolean;
  readMain?: (row: unknown) => WatchEvent[];
}

const TERMINAL = new Set(['done', 'failed']);

export class GroupWatcher {
  private readonly deps: GroupWatcherDeps;
  private readonly sessions = new Map<string, Session>();
  /** sessionId → ключ состояния: продолжение разговора под новым ключом прогона. */
  private readonly bySession = new Map<string, string>();
  private readonly dirty = new Set<string>();
  /** Ключ разговора (чат или sessionId) → затравка забытой сессии для R2. */
  private readonly seeds = new Map<string, ResumeSeed>();
  private readonly sent = new Map<string, { at: number; severity: GroupSignal['severity'] }>();
  private readonly tail = new TranscriptTail();
  private timer: NodeJS.Timeout | undefined;
  /** Старт сторожа: до него сигналы записаны прошлой жизнью панели. */
  private readonly bornAt: number;

  constructor(deps: GroupWatcherDeps) {
    this.deps = deps;
    this.bornAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), WATCH_TICK_MS);
    this.timer.unref();
  }

  /** Погасить тик; отложенные числа сигналов — на диск. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const parent of [...this.dirty]) this.flush(parent);
  }

  /** Подписчик реестра прогонов (`setWatchListener`). Ошибка сторожа прогону не мешает. */
  readonly onFeed = (chatId: string, feed: RunWatchFeed): void => {
    try {
      this.feed(chatId, feed);
    } catch (error) {
      this.deps.log?.('[group-watch] feed event failed', error);
    }
  };

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private context(session: Session): WatchContext {
    const learned = this.deps.learned?.();
    return {
      settings: this.deps.settings(),
      ...(this.deps.panelRoot ? { panelRoot: this.deps.panelRoot } : {}),
      ...(session.target.cwd ? { cwd: session.target.cwd } : {}),
      ...(learned ? { learned } : {}),
    };
  }

  private feed(chatId: string, feed: RunWatchFeed): void {
    if (!this.deps.settings().enabled) return;
    const now = this.now();
    const session = this.session(
      chatId,
      feed.sessionId,
      now,
      feed.kind === 'start' ? feed.cwd : undefined,
    );
    if (!session) return;
    if (feed.kind === 'start') session.detached = feed.detached === true;
    // Тот же ключ, другой разговор (новый разговор под ключом, ответвление) — хвосты его.
    if (feed.sessionId && feed.sessionId !== session.sessionId)
      this.bindSession(chatId, session, feed.sessionId, now);

    if (feed.kind === 'start') {
      session.tailCalls = 0;
      if (session.detached && session.sessionId) this.primeMain(session, now);
      session.node = this.deps.node(session.target, [...session.keys]);
      this.apply(session, [{ kind: 'start', t: now }], now);
      return;
    }
    if (feed.kind === 'finish') {
      this.apply(session, [{ kind: 'end', t: now }], now);
      return;
    }
    const events = streamWatchEvents(feed.event, now, session.target.stage).filter(
      (event) => !(event.kind === 'call' && event.sidechain && session.tailCalls > 0),
    );
    if (events.length > 0) this.apply(session, events, now);
  }

  /** Состояние разговора: найденное по ключу или sessionId, или новое — если это звено группы. */
  private session(
    chatId: string,
    sessionId: string | undefined,
    now: number,
    cwd: string | undefined,
  ): Session | undefined {
    const key = this.sessions.has(chatId)
      ? chatId
      : sessionId
        ? this.bySession.get(sessionId)
        : undefined;
    const known = key ? this.sessions.get(key) : undefined;
    if (known) {
      known.keys.add(chatId);
      if (key !== chatId) this.sessions.set(chatId, known);
      return known;
    }
    const target = this.deps.resolve(chatId, sessionId);
    if (!target) return undefined;
    const state = createWatchState(now);
    const seed = [sessionId, chatId, target.chatId]
      .map((candidate) => (candidate ? this.seeds.get(candidate) : undefined))
      .find(Boolean);
    if (seed) {
      state.lastCallAt = seed.lastCallAt;
      if (seed.firstCtx !== undefined) state.firstCtx = seed.firstCtx;
    }
    const session: Session = {
      state,
      target: cwd && !target.cwd ? { ...target, cwd } : target,
      keys: new Set([chatId, target.chatId]),
      node: { running: true, paused: false },
      tailCalls: 0,
    };
    this.sessions.set(chatId, session);
    if (sessionId) this.bindSession(chatId, session, sessionId, now);
    return session;
  }

  private bindSession(chatId: string, session: Session, sessionId: string, now: number): void {
    if (session.sessionId) this.unbindSession(session);
    session.sessionId = sessionId;
    session.keys.add(sessionId);
    this.bySession.set(sessionId, chatId);
    const dir = this.deps.subagentDir?.(sessionId);
    // После перезапуска панели прошлые субагенты не догоняются: хвост с конца.
    if (dir) this.tail.prime(dir, now);
    if (session.detached) this.primeMain(session, now);
  }

  /** Сессия ушла от разговора: хвосты прежней — забыть. */
  private unbindSession(session: Session): void {
    const old = session.sessionId;
    if (!old) return;
    this.bySession.delete(old);
    const dir = this.deps.subagentDir?.(old);
    if (dir) this.tail.forget(dir);
    const file = this.deps.transcript?.(old);
    if (file) this.tail.forget(file);
    delete session.readTail;
    delete session.readMain;
  }

  /** Транскрипт самой сессии — с его нынешнего конца (прошлое не догоняется). */
  private primeMain(session: Session, now: number): void {
    const file = session.sessionId ? this.deps.transcript?.(session.sessionId) : undefined;
    if (file) this.tail.primeFile(file, now);
  }

  private apply(session: Session, events: readonly WatchEvent[], now: number): void {
    const ctx = this.context(session);
    for (const event of events) reduce(session.state, event, ctx);
    this.judge(session, ctx, now);
  }

  /**
   * Первый ход звена заведён под временным `new-…`; сессия родилась — список
   * знает чат по её id. Цель и уже поднятые сигналы переезжают на него, иначе
   * «Открыть чат» вёл бы по ключу, которого больше нет.
   */
  private rekey(session: Session): void {
    const old = session.target.chatId;
    if (!old.startsWith('new-')) return;
    const key = this.deps.canonical?.(old);
    if (!key || key === old) return;
    session.target = { ...session.target, chatId: key };
    session.keys.add(key);
    const { parentChatId, groupIndex } = session.target;
    const signals = this.deps.group(parentChatId, groupIndex)?.watch?.signals ?? [];
    const moved = signals.filter((signal) => signal.chatId === old);
    for (const signal of moved) signal.chatId = key;
    if (moved.length > 0) this.dirty.add(parentChatId);
  }

  /** Правила по состоянию → сигналы записи группы; состав сменился — на диск сразу. */
  private judge(session: Session, ctx: WatchContext, now: number): void {
    this.rekey(session);
    const { target } = session;
    const group = this.deps.group(target.parentChatId, target.groupIndex);
    if (!group) return;
    const hits = evaluate(
      session.state,
      {
        ...session.node,
        chatId: target.chatId,
        groupIndex: target.groupIndex,
        ...(target.stage ? { stage: target.stage } : {}),
      },
      ctx,
      now,
    );
    const merged = mergeSignals(
      group.watch?.signals ?? [],
      {
        chatId: target.chatId,
        groupIndex: target.groupIndex,
        ...(target.stage ? { stage: target.stage } : {}),
      },
      hits,
      now,
      this.deps.makeId ?? randomUUID,
    );
    if (!merged.structural && !merged.numbers) return;
    group.watch = { signals: merged.signals };
    // Состав сменился — на диск сразу; не вышло — запись остаётся отложенной до тика.
    this.dirty.add(target.parentChatId);
    if (merged.structural) this.flush(target.parentChatId);
    if (merged.raised.length > 0 && ctx.settings.telegram && this.deps.notify) {
      const keyOf = (signal: GroupSignal): string =>
        // Прогноз окна — о всём аккаунте: один на разделение, не на каждое звено.
        signal.rule === 'R9' ? `R9:${target.parentChatId}` : `${signal.rule}:${signal.chatId}`;
      const due = signalsToNotify(
        merged.raised,
        keyOf,
        this.sent,
        ctx.settings.cooldownMinutes * 60_000,
        now,
      );
      for (const signal of due) this.deps.notify(signal, target);
    }
  }

  /** Записать разделение родителя; сбой записи — в журнал, разделение остаётся отложенным. */
  private flush(parentChatId: string): void {
    try {
      this.deps.save(parentChatId);
      this.dirty.delete(parentChatId);
    } catch (error) {
      this.deps.log?.('[group-watch] save failed', error);
    }
  }

  /** Тик: хвост субагентов, время в правилах, забытые сессии, отложенная запись чисел. */
  tick(): void {
    const now = this.now();
    const enabled = this.deps.settings().enabled;
    if (enabled) this.sweep(now);
    else this.dropAll(now);
    this.closeOrphans(now, enabled);
    for (const parent of [...this.dirty]) this.flush(parent);
  }

  private sweep(now: number): void {
    const seen = new Set<Session>();
    for (const [key, session] of this.sessions) {
      if (seen.has(session)) continue;
      seen.add(session);
      // Сбой одной сессии (чтение хвоста, записи панели) не лишает остальные проверки.
      try {
        this.sweepOne(key, session, now);
      } catch (error) {
        this.deps.log?.('[group-watch] tick failed', error);
      }
    }
  }

  private sweepOne(key: string, session: Session, now: number): void {
    const group = this.deps.group(session.target.parentChatId, session.target.groupIndex);
    if (!group || TERMINAL.has(group.status)) {
      this.drop(key, session, group, now);
      return;
    }
    session.node = this.deps.node(session.target, [...session.keys]);
    const { state } = session;
    // Ход кончился вопросом текстом — сессия ждёт человека, R1b ещё впереди;
    // лимит исчерпан, а сброс впереди — R10 держится до него.
    const limitAhead = state.rejectedAt !== undefined && (state.rejectedResetsAt ?? 0) * 1000 > now;
    const idle =
      state.endedAt !== undefined &&
      now - state.lastEventAt > IDLE_DROP_MS &&
      !session.node.ask &&
      !limitAhead;
    if (idle) {
      this.drop(key, session, group, now);
      return;
    }
    const events = this.tailEvents(session, now);
    this.apply(session, events, now);
  }

  /** Сторож выключен: следить не за кем — сессии забыты, их сигналы закрыты. */
  private dropAll(now: number): void {
    const seen = new Set<Session>();
    for (const [key, session] of [...this.sessions]) {
      if (seen.has(session)) continue;
      seen.add(session);
      const group = this.deps.group(session.target.parentChatId, session.target.groupIndex);
      this.drop(key, session, group, now);
    }
  }

  /**
   * Активные сигналы, за которыми нет сессии: панель перезапускалась, сторож
   * выключали. Группа кончилась или сторож выключен — закрыть сразу; иначе —
   * когда сторож живёт дольше `IDLE_DROP_MS`, а разговор так и не дал о себе знать.
   */
  private closeOrphans(now: number, enabled: boolean): void {
    const plans = this.deps.plans?.();
    if (!plans) return;
    const watched = new Set([...this.sessions.values()].map((session) => session.target.chatId));
    const settled = !enabled || now - this.bornAt > IDLE_DROP_MS;
    for (const [parentChatId, plan] of Object.entries(plans)) {
      for (const group of plan.groups) {
        const signals = group.watch?.signals;
        if (!signals?.some((signal) => !signal.clearedAt)) continue;
        const terminal = TERMINAL.has(group.status);
        const orphans = new Set(
          signals
            .filter((signal) => !signal.clearedAt && !watched.has(signal.chatId))
            .map((signal) => signal.chatId),
        );
        if (orphans.size === 0 || !(terminal || settled)) continue;
        let current = signals;
        for (const chatId of orphans) current = clearChatSignals(current, chatId, now).signals;
        group.watch = { signals: current };
        this.dirty.add(parentChatId);
      }
    }
  }

  private tailEvents(session: Session, now: number): WatchEvent[] {
    // После конца хода — ещё два тика: субагент последней минуты дочитывается.
    const ended = session.state.endedAt;
    if (!session.sessionId || (ended !== undefined && now - ended > 2 * WATCH_TICK_MS)) return [];
    const events: WatchEvent[] = [];
    if (session.detached) events.push(...this.mainEvents(session, session.sessionId, now));
    const dir = this.deps.subagentDir?.(session.sessionId);
    if (dir) {
      session.readTail ??= createTranscriptReader({ sidechain: true });
      const sidechain = this.tail
        .read(dir, now)
        .flatMap(({ row }) => session.readTail?.(row) ?? []);
      session.tailCalls += sidechain.filter((event) => event.kind === 'call').length;
      events.push(...sidechain);
    }
    // Строки транскрипта идут со своим временем; часы машины впереди — не позже «сейчас».
    return events.map((event) => (event.t > now ? { ...event, t: now } : event));
  }

  /** Прогон без потока: события сессии — из её транскрипта; стадию ставит звено. */
  private mainEvents(session: Session, sessionId: string, now: number): WatchEvent[] {
    const file = this.deps.transcript?.(sessionId);
    if (!file) {
      // Транскрипта нет (не Claude, ещё не записан) — видеть нечего, и молчание не улика.
      if (session.state.lastEventAt < now) session.state.lastEventAt = now;
      return [];
    }
    session.readMain ??= createTranscriptReader();
    const { stage } = session.target;
    return this.tail
      .readFile(file, now)
      .flatMap(({ row }) => session.readMain?.(row) ?? [])
      .map((event) => (event.kind === 'tool' && stage ? { ...event, stage } : event));
  }

  private drop(
    key: string,
    session: Session,
    group: SplitPlanGroupRecord | undefined,
    now: number,
  ): void {
    for (const [alias, held] of this.sessions) if (held === session) this.sessions.delete(alias);
    this.sessions.delete(key);
    const { lastCallAt, firstCtx } = session.state;
    if (lastCallAt !== undefined && group && !TERMINAL.has(group.status)) {
      const seed: ResumeSeed = { lastCallAt, ...(firstCtx !== undefined ? { firstCtx } : {}) };
      for (const alias of session.keys) {
        this.seeds.delete(alias);
        this.seeds.set(alias, seed);
      }
      while (this.seeds.size > SEEDS_CAP) {
        this.seeds.delete(this.seeds.keys().next().value as string);
      }
    }
    this.unbindSession(session);
    if (!group?.watch) return;
    const cleared = clearChatSignals(group.watch.signals, session.target.chatId, now);
    if (!cleared.changed) return;
    group.watch = { signals: cleared.signals };
    this.dirty.add(session.target.parentChatId);
  }

  /** Для проверок и снимка: сколько разговоров под наблюдением. */
  get watched(): number {
    return new Set(this.sessions.values()).size;
  }
}
