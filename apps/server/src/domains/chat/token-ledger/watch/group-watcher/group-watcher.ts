import type {
  GroupSignal,
  GroupWatchCoverage,
  GroupWatchCoverageSummary,
  GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';
import { readJsonFile, writeJsonFile } from '../../../../../lib/safe-io/safe-io.ts';
import { windowWeight } from '../../../../analytics/token-audit/window-weight.ts';
import { awaitsAnswer } from '../../../group-questions/group-wait.ts';
import { GroupLedgers, groupKeyOf } from '../group-ledgers.ts';
import { createWatchState, quietCauses, reduce } from '../reduce.ts';
import { editIntentOf, repeats } from '../reduce-autonomy.ts';
import { freshCause, groupRedo } from '../rules-autonomy.ts';
import { escalateBurn } from '../rules-embed.ts';
import {
  FANOUT_BURN_SHARE,
  GROUP_LEVEL,
  SESSION_RULES,
  evaluate,
  groupBurn,
  groupGates,
  subBurnShare,
  type LimitPoint,
} from '../rules.ts';
import { maskCommand } from '../check-signature.ts';
import { streamWatchEvents } from '../stream-events.ts';
import type { ColdCacheRule, WatchContext, WatchEvent, WatchNode } from '../watch.types.ts';
import { foreignColdRule } from '../../foreign/foreign-cache.ts';
import { foreignStreamReader } from '../../foreign/foreign-stream.ts';
import type {
  GroupWatchFeed,
  GroupWatcherDeps,
  Session,
  WatchTarget,
} from './group-watcher.types.ts';
import { correlateGroups } from './correlate.ts';
import { coverageOf, coverageSummary, providerOfParent, type PanelSources } from './coverage.ts';
import { sweepGroups, type NudgeSnap, type SeenMark } from './group-sweep.ts';
import { commandCheck } from './ledger-checks.ts';
import { editedFileOf, type EditedFile } from './restart-rules.ts';
import { ResumeSeeds } from './seeds.ts';
import { accountWindow, finishedRuns, isHeavyRun, type FinishedRun } from './window-rules.ts';
import { wasteStep } from './run-summary.ts';
import { SessionTranscripts } from './session-transcripts.ts';
import { SignalRecorder } from './signal-recorder.ts';
import { IDLE_DROP_MS, TERMINAL, WATCH_TICK_MS } from './timing.ts';

/**
 * Сторож групп разделения (фаза 2, W): живой поток прогона звена → состояние
 * сессии → правила → сигналы на записи группы и, по важности, наружу (Telegram,
 * вебхук — каждый канал решает сам по своим событиям). Ноль вызовов модели и
 * ни одного тормоза: только наблюдение.
 *
 * Состояние живёт на РАЗГОВОР, не на прогон. Сессия, чей ход кончился больше
 * `IDLE_DROP_MS` назад и чей вопрос человеку не висит, или звено, чья группа
 * кончилась, — забываются, их активные сигналы закрываются. От забытой сессии
 * остаётся затравка — конец её последнего вызова и база окна: правилу холодной
 * записи (R2) она нужна, когда разговор продолжат через час.
 *
 * R8 (расход группы) и R9 (прогноз окна аккаунта) — не правила сессии: их
 * считает сторож по своим спискам (`GroupLedgers`), сигнал у них один на группу.
 *
 * Активный сигнал без сессии (панель перезапускалась, сторож выключали) никто
 * не подтверждает: он закрывается — сразу, если группа кончилась или сторож
 * выключен, иначе через `IDLE_DROP_MS` после старта сторожа, если разговор так
 * и не дал о себе знать. Прогон, подхваченный после перезапуска без потока
 * (`detached`), читается хвостом своего транскрипта — с конца файла.
 *
 * Сигналы и их запись — `SignalRecorder`, файлы и хвосты — `SessionTranscripts`,
 * затравки продолжения — `ResumeSeeds`; здесь — сессии и порядок событий.
 *
 * Одиночный чат панели (цель `scope: 'chat'`) — та же сессия без группы: правила
 * `SINGLE_RULES`, сигналы в своём срезе, без R8/R9/R21. Правила группы R22, R23, R28
 * считаются на тике по всем живым группам (`group-sweep.ts`, `correlate.ts`): сессии
 * у группы может и не быть — тишину группы меряет `lastSeen`, он переживает забытую сессию.
 */

const R8_ONLY: ReadonlySet<GroupWatchRule> = new Set(['R8']);
const R9_ONLY: ReadonlySet<GroupWatchRule> = new Set(['R9']);
const R21_ONLY: ReadonlySet<GroupWatchRule> = new Set(['R21']);
const R35_ONLY: ReadonlySet<GroupWatchRule> = new Set(['R35']);

export class GroupWatcher {
  private readonly deps: GroupWatcherDeps;
  private readonly sessions = new Map<string, Session>();
  /** sessionId → ключ состояния: продолжение разговора под новым ключом прогона. */
  private readonly bySession = new Map<string, string>();
  private readonly seeds = new ResumeSeeds();
  private readonly ledgers = new GroupLedgers();
  private readonly signals: SignalRecorder;
  private readonly files: SessionTranscripts;
  /** Группа → когда подавала голос последний раз (R22); переживает забытую сессию. */
  private readonly lastSeen = new Map<string, SeenMark>();
  /** Группа → что сторож видел в счётчике напоминаний о доставке (R28). */
  private readonly nudgeSnap = new Map<string, NudgeSnap>();
  private readonly bornAt: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: GroupWatcherDeps) {
    this.deps = deps;
    this.bornAt = this.now();
    this.signals = new SignalRecorder(deps, this.bornAt);
    this.files = new SessionTranscripts(deps);
    this.restoreEdits();
  }

  /** Правки групп, записанные прошлым процессом (R38: перезапуск из-за них уже случился). */
  private restoreEdits(): void {
    const file = this.deps.editsFile;
    if (!file) return;
    try {
      const saved = readJsonFile<{ groups?: Record<string, EditedFile[]> }>(file, {});
      if (saved.groups && typeof saved.groups === 'object')
        this.ledgers.restoreEditedFiles(saved.groups, this.bornAt);
    } catch (error) {
      this.deps.log?.('[group-watch] edits restore failed', error);
    }
  }

  /** Правки групп — на диск сразу: перезапуск, который они вызовут, памяти не оставит. */
  private saveEdits(): void {
    const file = this.deps.editsFile;
    if (!file) return;
    try {
      writeJsonFile(file, { groups: this.ledgers.editedFilesSnapshot() }, { preserveForm: false });
    } catch (error) {
      this.deps.log?.('[group-watch] edits save failed', error);
    }
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
    this.signals.flushDirty();
  }

  /**
   * Пинг тёплого кэша освежил окно сессии (`keep-warm`). Пинг идёт мимо потока
   * и транскрипта сессии, поэтому сторож узнаёт о нём только так. Отметка — для
   * R2: продолжение после пинга читает кэш, и пауза считается от пинга. Время
   * последнего события не трогается: пинг не работа, и молчание звена для R1
   * остаётся молчанием. Сессии под наблюдением нет — отметка ложится в затравку
   * продолжения (`lastCallAt` проводка берёт из хвоста транскрипта).
   */
  warmed(sessionId: string, at: number, lastCallAt: number): void {
    // Новый разговор группы после пинга — поверх тёплого (R34): отметка и в списке группы.
    this.ledgers.warmed(sessionId, at);
    const key = this.bySession.get(sessionId);
    const session = key ? this.sessions.get(key) : undefined;
    if (session) {
      session.state.warmedAt = Math.max(session.state.warmedAt ?? 0, at);
      return;
    }
    this.seeds.warm(sessionId, at, lastCallAt);
  }

  /** Подписчик реестра прогонов (`setWatchListener`). Ошибка сторожа прогону не мешает. */
  readonly onFeed = (chatId: string, feed: GroupWatchFeed): void => {
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
      ...(this.deps.home ? { home: this.deps.home } : {}),
      ...(this.deps.realPath ? { realPath: this.deps.realPath } : {}),
      ...(learned ? { learned } : {}),
      ...(session.provider ? { cold: this.foreignCold(session.provider, session.local) } : {}),
      ...(this.deps.portAlive ? { portAlive: this.deps.portAlive } : {}),
    };
  }

  /** Разговор сессии для списков группы: id сессии, пока его нет, — ключ прогона. */
  private conversationOf(session: Session): string {
    return session.sessionId ?? session.target.chatId;
  }

  /**
   * Новый разговор группы (R34): последний вызов прошлого разговора группы и повод
   * нового — по ключу прогона, эскалации доставки и смене стадии. Прошлого нет — ничего.
   */
  private freshPrior(
    chatId: string,
    session: Session,
    now: number,
  ): Pick<Extract<WatchEvent, { kind: 'start' }>, 'prev' | 'cause'> {
    const { parentChatId, groupIndex } = session.target;
    const last = this.ledgers.mainOf(groupKeyOf(parentChatId, groupIndex));
    if (!last) return {};
    const record = this.deps.group(parentChatId, groupIndex);
    const escalatedAt = record?.deliveryEscalatedAt ? Date.parse(record.deliveryEscalatedAt) : NaN;
    const stage = session.node.stage ?? session.target.stage;
    const cause = freshCause({
      key: chatId,
      now,
      ...(Number.isFinite(escalatedAt) ? { escalatedAt } : {}),
      ...(last.stage ? { prevStage: last.stage } : {}),
      ...(stage ? { stage } : {}),
    });
    return {
      prev: {
        t: Math.max(last.t, last.warmedAt ?? 0),
        ctx: last.ctx,
        ...(last.model ? { model: last.model } : {}),
      },
      cause,
    };
  }

  /**
   * Правка повторяет коммит другого разговора группы на этой стадии (R35): коммит
   * раньше правки и не раньше начала звена. Свой коммит разговор не повторяет — он его помнит.
   */
  private noteRedo(
    session: Session,
    groupKey: string,
    event: Extract<WatchEvent, { kind: 'tool' }>,
    ctx: WatchContext,
  ): void {
    const intent = editIntentOf(event, ctx);
    if (!intent) return;
    const conversation = this.conversationOf(session);
    const since = session.node.stageSince;
    const done = this.ledgers
      .commitsOf(groupKey)
      .filter(
        (commit) =>
          commit.conversation !== conversation &&
          commit.at < event.t &&
          (since === undefined || commit.at >= since),
      )
      .flatMap((commit) => commit.intents);
    if (done.length > 0 && repeats(intent, done)) {
      this.ledgers.noteRedo(groupKey, { at: event.t, path: intent.path, shown: intent.shown });
    }
  }

  /** R2 чужого CLI: срок и след его провайдера, не часовой кэш Claude из настроек. */
  private foreignCold(provider: string, local: boolean | undefined): ColdCacheRule {
    const coldAfterMs = this.deps.foreignColdAfterMs?.();
    return foreignColdRule(provider, {
      ...(local ? { local } : {}),
      ...(coldAfterMs !== undefined ? { coldAfterMs } : {}),
    });
  }

  private feed(chatId: string, feed: GroupWatchFeed): void {
    if (!this.deps.settings().enabled) return;
    const now = this.now();
    const start = feed.kind === 'start' ? feed : undefined;
    const session = this.session(
      chatId,
      feed.sessionId,
      now,
      start?.cwd,
      start?.forkOf,
      start?.provider,
    );
    if (!session) return;
    if (start) {
      session.detached = start.detached === true;
      session.turnAt = now;
      session.turnOpen = true;
      if (start.provider) session.provider = start.provider;
      // Модель хода выбирается на каждом ходе: локальная — кэша провайдера нет.
      if (session.provider) session.local = start.local === true;
    }
    // Конец хода чужого CLI: дочитать его переписку до смены id сессии и до
    // конца хода — последние строки хода иначе не дошли бы до правил.
    if (feed.kind === 'finish' && session.provider && session.detached) {
      const tail = this.files.tailEvents(session, now, 0);
      if (tail.length > 0) this.apply(session, tail, now);
    }
    // Тот же ключ, другой разговор (новый разговор под ключом, ответвление) — хвосты его.
    if (feed.sessionId && feed.sessionId !== session.sessionId)
      this.bindSession(chatId, session, feed.sessionId, now);

    if (feed.kind === 'start') {
      session.tailCalls = 0;
      if (session.detached && session.sessionId) this.files.primeMain(session, now);
      session.node = this.deps.node(session.target, [...session.keys]);
      // Без id сессии, не подхват и не ответвление — CLI начинает новый разговор (R19, R2).
      // Чужой CLI: на месте id — ключ разговора, пока CLI своего не назвал, —
      // это тоже новый разговор (первый ход звена или новая сессия после паузы).
      const placeholder = session.provider !== undefined && feed.sessionId === chatId;
      const fresh = (!feed.sessionId && !feed.detached && !feed.forkOf) || placeholder;
      const prior =
        fresh && session.target.scope !== 'chat' ? this.freshPrior(chatId, session, now) : {};
      this.apply(
        session,
        [
          {
            kind: 'start',
            t: now,
            ...(fresh ? { fresh: true as const } : {}),
            ...prior,
            ...(feed.promptChars !== undefined ? { chars: feed.promptChars } : {}),
          },
        ],
        now,
      );
      return;
    }
    if (feed.kind === 'finish') {
      session.turnOpen = false;
      this.apply(session, [{ kind: 'end', t: now }], now);
      return;
    }
    if (feed.kind === 'foreign') {
      if (!session.provider) return;
      session.readStream ??= foreignStreamReader(session.provider);
      const events = session.readStream?.(feed.row) ?? [];
      if (events.length > 0) this.applyStream(session, events, now);
      return;
    }
    // Остаток сверки — расход субагентов, ещё не дочитанный хвостом: дочитать
    // сейчас, иначе он прошёл бы в расход и второй раз, когда хвост дойдёт (R8).
    const drained =
      feed.event.kind === 'usage' && feed.event.remainder
        ? this.files.tailEvents(session, now, 0)
        : [];
    const events = [
      ...drained,
      ...streamWatchEvents(feed.event, now, session.target.stage).filter(
        (event) => !(event.kind === 'call' && event.sidechain && session.tailCalls > 0),
      ),
    ];
    if (events.length > 0) this.applyStream(session, events, now);
  }

  /**
   * События потока хода. Текст и размышления идут кусками десятки раз в секунду:
   * только «жива», без оценки правил — R1 закроется на ближайшем тике.
   */
  private applyStream(session: Session, events: WatchEvent[], now: number): void {
    if (events.every((event) => event.kind === 'activity')) {
      const ctx = this.context(session);
      for (const event of events) reduce(session.state, event, ctx);
      return;
    }
    this.apply(session, events, now);
  }

  /** Состояние разговора: найденное по ключу или sessionId, или новое — если это звено группы. */
  private session(
    chatId: string,
    sessionId: string | undefined,
    now: number,
    cwd: string | undefined,
    forkOf?: string,
    provider?: string,
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
    const parentKey = forkOf ? this.bySession.get(forkOf) : undefined;
    const parent = parentKey ? this.sessions.get(parentKey)?.state : undefined;
    const seed = this.seeds.seedFor([sessionId, chatId, target.chatId], forkOf, parent);
    if (seed) {
      state.lastCallAt = seed.lastCallAt;
      if (seed.firstCtx !== undefined) state.firstCtx = seed.firstCtx;
      if (seed.warmedAt !== undefined) state.warmedAt = seed.warmedAt;
      if (seed.lastCacheRead !== undefined) state.lastCacheRead = seed.lastCacheRead;
    }
    const session: Session = {
      state,
      target: cwd && !target.cwd ? { ...target, cwd } : target,
      keys: new Set([chatId, target.chatId]),
      node: { running: true, paused: false },
      tailCalls: 0,
      ...(provider ? { provider, turnAt: now } : {}),
    };
    this.sessions.set(chatId, session);
    if (sessionId) this.bindSession(chatId, session, sessionId, now);
    return session;
  }

  private bindSession(chatId: string, session: Session, sessionId: string, now: number): void {
    const before = this.files.fileBeforeRebind(session);
    if (session.sessionId) this.unbindSession(session, before !== undefined);
    session.sessionId = sessionId;
    session.keys.add(sessionId);
    this.bySession.set(sessionId, chatId);
    this.files.bound(session, sessionId, before, now);
  }

  /** Сессия ушла от разговора: хвосты прежней — забыть; `keepMain` — файл переписки тот же. */
  private unbindSession(session: Session, keepMain = false): void {
    const old = session.sessionId;
    if (!old) return;
    this.bySession.delete(old);
    this.files.unbind(session, old, keepMain);
  }

  /** События → состояние сессии и списки сторожа, затем оценка. */
  private apply(session: Session, events: readonly WatchEvent[], now: number): void {
    const ctx = this.context(session);
    const groupKey = groupKeyOf(session.target.parentChatId, session.target.groupIndex);
    // Одиночный чат (F-78): R8 и R21 у него не считаются — их списки никто бы не прочёл.
    const grouped = session.target.scope !== 'chat';
    let editsNoted = false;
    for (const event of events) {
      const heavyBefore = session.state.heavyChecks.at(-1);
      const editBefore = session.state.treeEditAt;
      if (grouped && event.kind === 'tool') this.noteRedo(session, groupKey, event, ctx);
      // Правленый файл — в список группы (R38): перезапуск панели, ждущий его, — из-за неё.
      const edited = grouped ? editedFileOf(event, ctx) : undefined;
      if (edited) {
        this.ledgers.noteEditedFile(groupKey, edited);
        editsNoted = true;
      }
      if (grouped) this.noteLedgerCheck(groupKey, event, ctx);
      reduce(session.state, event, ctx);
      // Шаг впустую — вес вызова разговора, который его сделал, в потери группы (R46).
      const waste = grouped ? wasteStep(session.state, event) : undefined;
      const wastedCall = waste ? session.state.calls.at(-1) : undefined;
      if (waste && wastedCall)
        this.ledgers.noteWaste(groupKey, {
          t: wastedCall.t,
          weight: wastedCall.weight,
          kind: waste,
        });
      // Правка дерева любым звеном — граница прохода гейтов группы (R21).
      const editAfter = session.state.treeEditAt;
      if (grouped && editAfter !== undefined && editAfter !== editBefore)
        this.ledgers.noteTreeEdit(groupKey, editAfter);
      // Коммит сессии — в список группы (R35): другой её разговор не должен его повторять.
      if (grouped && session.state.commitFacts.length > 0) {
        const conversation = this.conversationOf(session);
        for (const fact of session.state.commitFacts.splice(0)) {
          this.ledgers.noteCommit(groupKey, { ...fact, conversation });
        }
      }
      // Последний вызов самого разговора — затравка нового разговора группы (R34).
      if (grouped && event.kind === 'call' && !event.sidechain && !event.turnTotal) {
        const ctxTokens = event.input + event.cacheRead + event.cacheWrite;
        const stage = session.node.stage ?? session.target.stage;
        if (ctxTokens > 0) {
          this.ledgers.noteMain(groupKey, {
            t: event.t,
            ctx: ctxTokens,
            ...(event.model ? { model: event.model } : {}),
            conversation: this.conversationOf(session),
            ...(stage ? { stage } : {}),
          });
        }
      }
      // Тяжёлая проверка — в счёт группы (R21): гейты звеньев идут в разных разговорах.
      const heavy = session.state.heavyChecks.at(-1);
      if (grouped && heavy && heavy !== heavyBefore)
        this.ledgers.noteHeavy(groupKey, {
          ...heavy,
          chatId: session.target.chatId,
          pass: Math.max(heavy.editAt ?? 0, this.ledgers.passOf(groupKey, heavy.at)),
        });
      // Расход группы — все вызовы: звена, его субагентов и остаток сверки. Субагентом
      // помечен только вызов субагента: остаток сверки — расход без хозяина (R8 его видит,
      // а доля веера в нём — нет).
      if (grouped && event.kind === 'call') {
        this.ledgers.noteCall(groupKey, {
          t: event.t,
          weight: windowWeight(event, event.model),
          ...(event.sidechain && !event.remainder ? { sub: true } : {}),
        });
      }
      if (event.kind === 'limit' && event.utilization !== undefined && event.resetsAt) {
        this.ledgers.noteLimit({
          t: event.t,
          utilization: event.utilization,
          resetsAt: event.resetsAt,
          ...(event.week ? { week: true as const } : {}),
        });
      }
    }
    if (editsNoted) this.saveEdits();
    if (session.target.scope !== 'chat') this.markSeen(groupKey, session);
    this.judge(session, ctx, now);
  }

  /**
   * Проверка, которую журнал проверок обязан записать (R41): начало — по вызову Bash на
   * переднем плане, конец — по ответу. Фоновый прогон длительности не меряет: не судим.
   */
  private noteLedgerCheck(groupKey: string, event: WatchEvent, ctx: WatchContext): void {
    const ledger = this.deps.ledger;
    if (!ledger) return;
    if (event.kind === 'toolResult') {
      this.ledgers.closeCheckRun(event.id, event.t, !event.denied);
      return;
    }
    if (event.kind !== 'tool' || event.name !== 'Bash' || !ctx.cwd) return;
    if (event.input.run_in_background === true || !event.id) return;
    const command = typeof event.input.command === 'string' ? event.input.command : '';
    const check = command ? commandCheck(command, ctx.cwd, ledger.scriptsOf) : undefined;
    if (!check) return;
    this.ledgers.openCheckRun(groupKey, event.id, {
      start: event.t,
      check,
      command: maskCommand(command),
    });
  }

  /**
   * Группа подала голос (R22): время последнего события сессии, не «сейчас» — тик
   * дочитывает хвост и без событий, и тишина иначе начиналась бы с забытья сессии.
   * Подхват без потока без конца хода — отметка `detached`: оборвёт его перезапуск.
   */
  private markSeen(groupKey: string, session: Session): void {
    const at = Math.max(this.lastSeen.get(groupKey)?.at ?? 0, session.state.lastEventAt);
    const detached = session.detached === true && session.turnOpen === true;
    this.lastSeen.set(groupKey, { at, ...(detached ? { detached: true } : {}) });
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
    const before = session.target;
    // Одиночный чат сам себе «родитель»: его срез ключуется ключом чата.
    session.target = {
      ...before,
      chatId: key,
      ...(before.scope === 'chat' ? { parentChatId: key } : {}),
    };
    session.keys.add(key);
    this.signals.moveChat(before, old, key);
  }

  /** Правила сессии и расход группы → сигналы записи группы (у одиночного чата — его среза). */
  private judge(session: Session, ctx: WatchContext, now: number): void {
    this.rekey(session);
    const { target } = session;
    if (target.scope === 'chat') {
      this.judgeChat(session, ctx, now);
      return;
    }
    const group = this.deps.group(target.parentChatId, target.groupIndex);
    if (!group) return;
    // Стадия — живая из связи (звено перешло в ревью тем же разговором), иначе — со старта.
    const stage = session.node.stage ?? target.stage;
    const node: WatchNode = {
      ...session.node,
      chatId: target.chatId,
      groupIndex: target.groupIndex,
      ...(stage ? { stage } : {}),
    };
    // Пауза: прежние поводы — прошлое, после снятия паузы они не поднимаются вторым рядом.
    // Сигналы группы (R8, R21) на паузе гаснут: она ничего не жжёт и не проверяет — а если
    // всё же действует, это R20.
    const groupKey = groupKeyOf(target.parentChatId, target.groupIndex);
    if (node.paused) {
      quietCauses(session.state);
      this.ledgers.quiet(groupKey);
    }
    const hits = evaluate(session.state, node, ctx, now);
    const points = this.ledgers.burnOf(groupKey);
    const recorded = this.signals.signalsOf(target.parentChatId, target.groupIndex);
    const burnActive = recorded.some((signal) => signal.rule === 'R8' && !signal.clearedAt);
    const burn = node.paused ? undefined : groupBurn(points, ctx.settings, now, burnActive);
    const gates = node.paused
      ? undefined
      : groupGates(this.ledgers.heavyOf(groupKey), ctx.settings, now);
    const redo = node.paused
      ? undefined
      : groupRedo(this.ledgers.redosOf(groupKey), ctx.settings, now);
    // Веер субагентов (R13) называет причину расхода группы, только когда расход и есть
    // субагенты: их доля в окне R8 — не меньше половины. Веер по одному числу запусков
    // (дешёвые разведчики) R8 не прячет — иначе тяжёлый расход самого звена пропал бы.
    // Своя сессия — по нынешним попаданиям, другие звенья группы — по их активным сигналам.
    const fanout =
      burn !== undefined &&
      (hits.some((hit) => hit.rule === 'R13') ||
        recorded.some(
          (signal) => signal.rule === 'R13' && !signal.clearedAt && signal.chatId !== target.chatId,
        )) &&
      subBurnShare(points, ctx.settings, now) >= FANOUT_BURN_SHARE;
    // Два круга в одном ходе (R4/R11/R21/R24) — новее из них тревога (BURN).
    escalateBurn(gates ? [...hits, gates] : hits, session.state.turnAt);
    this.signals.record(target, ctx.settings, now, [
      { hits, merge: { rules: SESSION_RULES } },
      { hits: burn && !fanout ? [burn] : [], merge: { rules: R8_ONLY, group: true } },
      { hits: gates ? [gates] : [], merge: { rules: R21_ONLY, group: true } },
      { hits: redo ? [redo] : [], merge: { rules: R35_ONLY, group: true } },
    ]);
  }

  /** Одиночный чат: только правила сессии из `SINGLE_RULES`, расхода и окна группы у него нет. */
  private judgeChat(session: Session, ctx: WatchContext, now: number): void {
    if (!ctx.settings.singleChats) return;
    const { target } = session;
    const node: WatchNode = {
      ...session.node,
      chatId: target.chatId,
      groupIndex: target.groupIndex,
    };
    const hits = evaluate(session.state, node, ctx, now, 'chat');
    escalateBurn(hits, session.state.turnAt);
    this.signals.record(target, ctx.settings, now, [{ hits, merge: { rules: SESSION_RULES } }]);
  }

  /**
   * Охват живой группы (чип на карточке): чем сторож её видит и каких источников нет.
   * Кончившаяся или неизвестная группа — `undefined`: строка о ней ничего не скажет.
   */
  coverageOf(parentChatId: string, groupIndex: number): GroupWatchCoverage | undefined {
    const group = this.deps.group(parentChatId, groupIndex);
    if (!group || TERMINAL.has(group.status)) return undefined;
    const sessions = [...this.sessions.values()].filter(
      (session) =>
        session.target.scope !== 'chat' &&
        session.target.parentChatId === parentChatId &&
        session.target.groupIndex === groupIndex,
    );
    return coverageOf({
      enabled: this.deps.settings().enabled,
      provider: providerOfParent(parentChatId),
      sessions,
      panel: this.panelSources(),
    });
  }

  /** Строка настроек: охват всех живых групп всех разделений и пробелы панели. */
  coverageSummary(): GroupWatchCoverageSummary {
    const list: GroupWatchCoverage[] = [];
    for (const [parent, plan] of Object.entries(this.deps.plans?.() ?? {})) {
      for (const group of plan.groups) {
        const one = this.coverageOf(parent, group.index);
        if (one) list.push(one);
      }
    }
    return coverageSummary(list, this.panelSources(), this.deps.settings().enabled);
  }

  private panelSources(): PanelSources {
    const panel = this.deps.panelSources?.() ?? {
      ledger: Boolean(this.deps.ledger),
      devWatch: Boolean(this.deps.restartFeed),
    };
    let limitJournal = false;
    try {
      limitJournal = (this.deps.limitRuns?.().length ?? 0) > 0;
    } catch (error) {
      this.deps.log?.('[group-watch] limit runs failed', error);
    }
    return { ...panel, limitJournal };
  }

  /** Тик: хвост субагентов, время в правилах, прогноз окна, забытые сессии, отложенная запись. */
  tick(): void {
    const now = this.now();
    const settings = this.deps.settings();
    const enabled = settings.enabled;
    this.ledgers.prune(now);
    if (enabled) {
      this.sweep(now);
      this.sweepGroupLevel(now);
      this.signals.releasePending(settings, now);
      this.projectAccount(now);
    } else {
      this.dropAll(now);
      this.signals.releasePending(settings, now, false);
    }
    const live = [...this.sessions.values()].map((session) => session.target);
    this.signals.closeOrphans(now, enabled, live, settings.singleChats);
    this.signals.flushDirty();
  }

  /**
   * Правила группы (R22, R28) и плана (R23) — по каждой живой группе каждого
   * разделения, с сессией или без. Одна запись на группу: пустой список закрывает
   * прежние сигналы этих правил. Сбой обхода — в журнал, тик идёт дальше.
   */
  private sweepGroupLevel(now: number): void {
    const settings = this.deps.settings();
    try {
      const plans = this.deps.plans?.() ?? {};
      // Чужой CLI идёт мимо реестра: открытый ход его сессии — тоже «группа идёт».
      const foreignOpen = new Set<string>();
      const watchedKeys = new Map<string, Set<string>>();
      for (const session of this.sessions.values()) {
        if (session.target.scope === 'chat') continue;
        const key = groupKeyOf(session.target.parentChatId, session.target.groupIndex);
        if (session.provider && session.turnOpen) foreignOpen.add(key);
        const keys = watchedKeys.get(key) ?? new Set<string>();
        for (const alias of session.keys) keys.add(alias);
        watchedKeys.set(key, keys);
      }
      const groupLive = this.deps.groupLive;
      const runs = this.runsByGroup(now);
      const swept = sweepGroups({
        plans,
        ...(groupLive
          ? {
              live: (parent: string, group: SplitPlanGroupRecord) => {
                const key = groupKeyOf(parent, group.index);
                const live = groupLive(parent, group, [...(watchedKeys.get(key) ?? [])]);
                return foreignOpen.has(key) ? { ...live, running: true } : live;
              },
            }
          : {}),
        ...(this.deps.groupSeenAt ? { seenAt: this.deps.groupSeenAt } : {}),
        ...(this.deps.deferredStuck ? { deferredStuck: this.deps.deferredStuck } : {}),
        ...(this.deps.deferredWaiting ? { deferredWaiting: this.deps.deferredWaiting } : {}),
        ...(this.deps.restartFeed ? { restarts: this.deps.restartFeed() } : {}),
        editedFilesOf: (key: string) => this.ledgers.editedFilesOf(key),
        ...(this.deps.ledger ? { ledger: this.deps.ledger.read() } : {}),
        checkRunsOf: (key: string) => this.ledgers.checkRunsOf(key),
        heavyRunsOf: (key: string) =>
          (runs.get(key) ?? []).filter((run) => isHeavyRun(run, settings)),
        finishedRunsOf: (key: string) => runs.get(key) ?? [],
        burnOf: (key: string) => this.ledgers.burnOf(key),
        wasteOf: (key: string) => this.ledgers.wasteOf(key),
        lastSeen: this.lastSeen,
        nudgeSnap: this.nudgeSnap,
        settings,
        now,
        bornAt: this.bornAt,
      });
      const correlated = new Map<string, ReturnType<typeof correlateGroups>>();
      for (const { parentChatId, group, hits, paused } of swept) {
        // Группа на паузе и без сессии под наблюдением: её расход и гейты — тоже прошлое (F-51).
        if (paused) this.ledgers.quiet(groupKeyOf(parentChatId, group.index));
        let plan = correlated.get(parentChatId);
        if (!plan) {
          const byGroup = new Map<number, GroupSignal[]>();
          for (const item of swept) {
            // Группа на паузе в беде плана не участвует (F-91): её падение — прошлое, никто
            // его сейчас не повторяет, и «одна беда в двух группах» с ней — уже не так.
            if (item.parentChatId !== parentChatId || item.paused) continue;
            byGroup.set(item.group.index, this.signals.signalsOf(parentChatId, item.group.index));
          }
          plan = correlateGroups(byGroup, settings, now);
          correlated.set(parentChatId, plan);
        }
        const cross = paused ? undefined : plan.get(group.index);
        const target: WatchTarget = {
          chatId: group.chatId ?? parentChatId,
          parentChatId,
          groupIndex: group.index,
        };
        this.signals.record(target, settings, now, [
          { hits: cross ? [...hits, cross] : hits, merge: { rules: GROUP_LEVEL, group: true } },
        ]);
      }
    } catch (error) {
      this.deps.log?.('[group-watch] group sweep failed', error);
    }
  }

  /**
   * Законченные прогоны (R42 — тяжёлые из них, R46 — все) по группам: прогон относится к
   * группе по ключу чата или сессии через связи дерева — и временный `new-…` ключ старта
   * стадии тоже. Прогон без связи не относится никуда; у одиночного чата ключ свой (номер
   * группы `CHAT_SCOPE_INDEX`), и обход групп его не читает. Сбой чтения журнала — пустой
   * список, тик идёт дальше.
   */
  private runsByGroup(now: number): Map<string, FinishedRun[]> {
    const out = new Map<string, FinishedRun[]>();
    if (!this.deps.limitRuns) return out;
    let runs: FinishedRun[] = [];
    try {
      runs = finishedRuns(this.deps.limitRuns(), now);
    } catch (error) {
      this.deps.log?.('[group-watch] limit runs failed', error);
    }
    for (const run of runs) {
      const target = this.deps.resolve(run.chatId, run.sessionId);
      if (!target) continue;
      const key = groupKeyOf(target.parentChatId, target.groupIndex);
      out.set(key, [...(out.get(key) ?? []), run]);
    }
    return out;
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
    const chat = session.target.scope === 'chat';
    const group = chat
      ? undefined
      : this.deps.group(session.target.parentChatId, session.target.groupIndex);
    // Одиночный чат: группы нет, конец слежки — выключенный выключатель одиночных чатов.
    if (chat ? !this.deps.settings().singleChats : !group || TERMINAL.has(group.status)) {
      this.drop(key, session, group, now);
      return;
    }
    session.node = this.deps.node(session.target, [...session.keys]);
    const { state } = session;
    // Ход кончился вопросом карточкой — сессия ждёт человека, R1b ещё впереди; вопросом
    // текстом, который некому подхватить, — R27 впереди; лимит исчерпан, а сброс
    // впереди — R10 держится до него.
    const limitAhead = state.rejectedAt !== undefined && (state.rejectedResetsAt ?? 0) * 1000 > now;
    const proseAhead =
      session.node.proseWait === true &&
      Boolean(state.endText) &&
      awaitsAnswer(state.endText ?? '');
    // Группа на паузе, а свой сервер сессии жив — R36 держится, пока порт слушает.
    const portsHeld =
      session.node.paused && state.ownPorts.some((port) => this.deps.portAlive?.(port) === true);
    const idle =
      state.endedAt !== undefined &&
      now - state.lastEventAt > IDLE_DROP_MS &&
      !session.node.ask &&
      !limitAhead &&
      !proseAhead &&
      !portsHeld;
    if (idle) {
      this.drop(key, session, group, now);
      return;
    }
    this.apply(session, this.files.tailEvents(session, now), now);
  }

  /**
   * R9 — раз на тик, по всем замерам аккаунта (журнал + живой поток), в каждую
   * группу под наблюдением: прогноз один, памяти отправленного — один ключ.
   */
  private projectAccount(now: number): void {
    const settings = this.deps.settings();
    let samples: readonly LimitPoint[] = this.ledgers.limits;
    try {
      samples = [...(this.deps.limitSamples?.() ?? []), ...this.ledgers.limits];
    } catch (error) {
      this.deps.log?.('[group-watch] limit journal failed', error);
    }
    const hit = accountWindow(samples, settings, now);
    const groups = new Map<string, { target: WatchTarget; paused: boolean }>();
    for (const session of this.sessions.values()) {
      // Одиночный чат — не группа: прогноз окна аккаунта идёт на карточки групп.
      if (session.target.scope === 'chat') continue;
      const { parentChatId, groupIndex } = session.target;
      const key = groupKeyOf(parentChatId, groupIndex);
      const known = groups.get(key);
      // Пауза дерева статус группы не меняет — её знает узел сессии (F-54).
      groups.set(key, {
        target: known?.target ?? session.target,
        paused: (known?.paused ?? false) || session.node.paused,
      });
    }
    for (const { target, paused: nodePaused } of groups.values()) {
      const group = this.deps.group(target.parentChatId, target.groupIndex);
      if (!group || TERMINAL.has(group.status)) continue;
      // Группа на паузе окно не тратит: прогноз аккаунта ей не сигнал.
      const paused = group.status === 'paused' || nodePaused;
      this.signals.record(target, settings, now, [
        { hits: hit && !paused ? [hit] : [], merge: { rules: R9_ONLY, group: true } },
      ]);
    }
  }

  /** Сторож выключен: следить не за кем — сессии забыты, их сигналы закрыты. */
  private dropAll(now: number): void {
    const seen = new Set<Session>();
    for (const [key, session] of [...this.sessions]) {
      if (seen.has(session)) continue;
      seen.add(session);
      const group =
        session.target.scope === 'chat'
          ? undefined
          : this.deps.group(session.target.parentChatId, session.target.groupIndex);
      this.drop(key, session, group, now);
    }
  }

  private drop(
    key: string,
    session: Session,
    group: SplitPlanGroupRecord | undefined,
    now: number,
  ): void {
    for (const [alias, held] of this.sessions) if (held === session) this.sessions.delete(alias);
    this.sessions.delete(key);
    const { lastCallAt } = session.state;
    // Одиночный чат продолжат так же, как звено: затравка R2 нужна и ему.
    const resumable =
      session.target.scope === 'chat' || (group !== undefined && !TERMINAL.has(group.status));
    if (lastCallAt !== undefined && resumable) {
      this.seeds.keep(session.keys, { ...session.state, lastCallAt });
    }
    this.unbindSession(session);
    this.signals.clearChat(session.target, now);
  }

  /** Для проверок и снимка: сколько разговоров под наблюдением. */
  get watched(): number {
    return new Set(this.sessions.values()).size;
  }
}
