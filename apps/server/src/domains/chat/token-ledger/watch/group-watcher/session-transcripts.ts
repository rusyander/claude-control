import { foreignWatchEvents } from '../../foreign/foreign-events.ts';
import { firstRecordAt, foreignTranscriptKind } from '../../foreign/foreign-transcript.ts';
import { TranscriptTail } from '../tail.ts';
import { createTranscriptReader } from '../transcript-events.ts';
import type { WatchEvent } from '../watch.types.ts';
import type { GroupWatcherDeps, Session, TranscriptHint } from './group-watcher.types.ts';
import { WATCH_TICK_MS } from './timing.ts';

/**
 * Всё, что сторож читает с диска: переписка самой сессии (прогон без потока,
 * база окна) и транскрипты субагентов, их хвосты и отступы. Особенности чужого
 * CLI — подсказка поиска файла первого хода, файл, родившийся в этом ходе, и
 * дочитывание на конце хода — живут здесь, в одном месте.
 */
export class SessionTranscripts {
  private readonly deps: GroupWatcherDeps;
  private readonly tail = new TranscriptTail();

  constructor(deps: GroupWatcherDeps) {
    this.deps = deps;
  }

  /** Подсказка поиска переписки чужого CLI; у Claude — нет. */
  private hintOf(session: Session): TranscriptHint | undefined {
    if (!session.provider) return undefined;
    return {
      provider: session.provider,
      ...(session.target.cwd ? { cwd: session.target.cwd } : {}),
      ...(session.turnAt !== undefined ? { since: session.turnAt } : {}),
    };
  }

  /** Файл переписки сессии под нынешним id. */
  mainFile(session: Session, sessionId = session.sessionId): string | undefined {
    if (!sessionId) return undefined;
    const hint = this.hintOf(session);
    return hint ? this.deps.transcript?.(sessionId, hint) : this.deps.transcript?.(sessionId);
  }

  /** Читатель переписки: формат Claude или своего CLI. */
  private mainReader(session: Session): (row: unknown) => WatchEvent[] {
    const kind = session.provider ? foreignTranscriptKind(session.provider) : undefined;
    return kind ? foreignWatchEvents(kind) : createTranscriptReader();
  }

  /**
   * Файл переписки чужого CLI до смены id: ключ разговора на месте id первого
   * хода сменится настоящим id — файл тот же, отступ его хвоста остаётся (иначе
   * прочитанное читалось бы снова). У Claude и без id — `undefined`.
   */
  fileBeforeRebind(session: Session): string | undefined {
    return session.provider && session.sessionId ? this.mainFile(session) : undefined;
  }

  /**
   * Сессия получила id `sessionId`: прежний файл, если он сменился, — забыть;
   * субагентов после перезапуска панели не догоняем (хвост с конца); прогон без
   * потока — с нынешнего конца; база окна — из начала транскрипта.
   */
  bound(session: Session, sessionId: string, before: string | undefined, now: number): void {
    if (before !== undefined && this.mainFile(session) !== before) this.tail.forget(before);
    const dir = session.provider ? undefined : this.deps.subagentDir?.(sessionId);
    if (dir) this.tail.prime(dir, now);
    if (session.detached) this.primeMain(session, now);
    if (session.state.firstCtx === undefined) this.firstContext(session, sessionId);
  }

  /** Сессия `old` ушла от разговора: хвосты прежней — забыть; `keepMain` — файл переписки тот же. */
  unbind(session: Session, old: string, keepMain: boolean): void {
    const dir = session.provider ? undefined : this.deps.subagentDir?.(old);
    if (dir) this.tail.forget(dir);
    delete session.readTail;
    if (keepMain) return;
    const file = this.mainFile(session, old);
    if (file) this.tail.forget(file);
    delete session.readMain;
  }

  /**
   * База окна — первый вызов сессии. Сторож его не видел (панель перезапускалась,
   * разговор продолжен) — берём из начала транскрипта: иначе базой стало бы
   * нынешнее полное окно, и холодная перезапись R2 под ним не видна.
   */
  private firstContext(session: Session, sessionId: string): void {
    // Новый разговор: первый вызов сторож увидит сам и со временем (R19) — транскрипт,
    // уже успевший его записать, не должен его опередить.
    if (session.state.fresh) return;
    const file = this.mainFile(session, sessionId);
    if (!file) return;
    const read = this.mainReader(session);
    for (const row of this.tail.head(file)) {
      const call = read(row).find(
        (event): event is Extract<WatchEvent, { kind: 'call' }> =>
          event.kind === 'call' && !event.sidechain,
      );
      if (!call) continue;
      const ctx = call.input + call.cacheRead + call.cacheWrite;
      if (ctx > 0) {
        session.state.firstCtx = ctx;
        return;
      }
    }
  }

  /**
   * Транскрипт самой сессии — с его нынешнего конца (прошлое не догоняется).
   * Переписка чужого CLI, начатая уже в этом ходе, — с начала: это его первый ход.
   */
  primeMain(session: Session, now: number): void {
    const file = this.mainFile(session);
    if (!file) return;
    if (session.provider && session.turnAt !== undefined) {
      const born = firstRecordAt(file);
      if (born !== undefined && born >= session.turnAt) return;
    }
    this.tail.primeFile(file, now);
  }

  /** События хвостов: транскрипт самой сессии (без потока) и её субагенты. */
  tailEvents(session: Session, now: number, minIntervalMs?: number): WatchEvent[] {
    // После конца хода — ещё два тика: субагент последней минуты дочитывается.
    const ended = session.state.endedAt;
    if (!session.sessionId || (ended !== undefined && now - ended > 2 * WATCH_TICK_MS)) return [];
    const events: WatchEvent[] = [];
    if (session.detached) {
      // Дочитать сразу (конец хода) — только чужой CLI: у Claude прогон без потока как был.
      events.push(...this.mainEvents(session, now, session.provider ? minIntervalMs : undefined));
    }
    // У чужого CLI субагентов Claude нет: каталог искался бы по чужому id.
    const dir = session.provider ? undefined : this.deps.subagentDir?.(session.sessionId);
    if (dir) {
      session.readTail ??= createTranscriptReader({ sidechain: true });
      const { stage } = session.target;
      const sidechain = this.tail
        .read(dir, now, minIntervalMs)
        .flatMap(({ row }) => session.readTail?.(row) ?? [])
        // Субагент работает на стадии своего звена: его коммит в работе — тоже R6.
        .map((event) => (event.kind === 'tool' && stage ? { ...event, stage } : event));
      session.tailCalls += sidechain.filter((event) => event.kind === 'call').length;
      events.push(...sidechain);
    }
    // Строки транскрипта идут со своим временем; часы машины впереди — не позже «сейчас».
    return events.map((event) => (event.t > now ? { ...event, t: now } : event));
  }

  /** Прогон без потока: события сессии — из её транскрипта; стадию ставит звено. */
  private mainEvents(session: Session, now: number, minIntervalMs?: number): WatchEvent[] {
    const file = this.mainFile(session);
    if (!file) {
      // Транскрипта нет (CLI без известного формата, ещё не записан) — видеть нечего,
      // и молчание не улика.
      if (session.state.lastEventAt < now) session.state.lastEventAt = now;
      return [];
    }
    session.readMain ??= this.mainReader(session);
    const { stage } = session.target;
    return this.tail
      .readFile(file, now, minIntervalMs)
      .flatMap(({ row }) => session.readMain?.(row) ?? [])
      .map((event) => (event.kind === 'tool' && stage ? { ...event, stage } : event));
  }
}
