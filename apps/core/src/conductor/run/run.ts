import type { LiveTask } from '../../journal/resume.ts';
import { WORKING, type TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { chatImagesOf, chatOpeningOf } from '../estimate/placement.ts';
import { decideNext } from '../next/next.ts';
import type { LiveStepFact, NextAction } from '../next/next.types.ts';
import { checksInFlight, decideSafepoint } from '../safepoint/safepoint.ts';
import { pendingDeliveries, recordDelivery } from '../human/deliver.ts';
import type { HumanLedger } from '../human/human.types.ts';
import { readHumanLedger } from '../human/ledger.ts';
import { settleLoginLost } from '../human/login-ask.ts';
import { applyAskUpkeep, decideAskUpkeep } from '../human/upkeep.ts';
import * as hook from './hooks.ts';
import { chatReopened, chatReopening, type LastTurn, type Reopening } from './chat-reopen.ts';
import { closeTask, endUnclosed } from './close.ts';
import { briefText, perform, stepCtx, stepLine, type PerformCtx } from './perform.ts';
import { END_REASON } from '../next/next.types.ts';
import type {
  BriefSection,
  IdleSession,
  LiveSession,
  Outgoing,
  RunDeps,
  RunEconomy,
  RunHandle,
  StepCtx,
} from './run.types.ts';
import { endSession, taskMove } from './moves.ts';
import { journalWaitTier, stepWindows, windowWakeMs } from './windows.ts';
import {
  dropAllSeats,
  dropSeat,
  parkSeat,
  pruneSeatWaits,
  seatWaits,
  seatsFreed,
  unparkSeat,
  waitsForSeat,
} from '../schedule/lease.ts';

/** Строка журнала пинга прогрева: subject — сессия, detail — причины и числа решения E. */
export const KEEP_WARM_SIGNAL = 'keep-warm';
const UPKEEP_EVERY_MS = 60_000;
/** Окно без срока сброса (сеть, исчерпание) перепроверяется так часто. */
const WINDOW_RECHECK_MS = 5_000;
/** Такт прогрева: судья E решает по возрасту кэша, такт только даёт ему слово. */
const KEEP_WARM_TICK_MS = 60_000;

/**
 * Исполнитель дирижёра (02:39-44): журнал → `decideNext` → действие → журнал. Будят его новая
 * строка задачи, событие живой сессии и таймер ближайшего срока шага. Сам не решает ничего:
 * каждое не-«ждать» решение ложится строкой `decision` класса `next` перед исполнением.
 *
 * Перезапуск ядра = новый `runTask` над `resume()` журнала: живых сессий в памяти нет, `next`
 * видит шаг без сессии и велит `run-step` — дорога сессии прикрепляет прежнюю или запускает новую.
 */

/**
 * Рабочее время задачи сейчас: свёртка + хвост после последней строки, пока задача идёт. Хвост
 * считается в тех же состояниях, что и свёртка (`WORKING`): иначе сроки шагов оценки не наступают.
 */
export function workNow(state: TaskFoldState, now: number): number {
  const tail = WORKING.includes(state.task) && state.lastAt !== null ? now - state.lastAt : 0;
  return state.work.activeMs + Math.max(0, tail);
}

/**
 * Вход и выход `waiting-window` (этап 12): суд велит ждать окно маршрута, а ни одна сессия не
 * в ходе — задача ждёт окна (`window-wait`); ждущая окна задача получила другое решение (окно
 * открылось, человек перевёл её, вопрос точки 7) — снова идёт (`window-reset`). `true` — переход
 * записан, суд надо спросить заново.
 */
export function windowMove(task: LiveTask, action: NextAction, busy: boolean): boolean {
  const st = task.state;
  if (st.ended !== null) return false;
  const waitsWindow = action.kind === 'wait' && action.window !== undefined;
  if (st.task === 'running' && waitsWindow && !busy) {
    taskMove(task, 'window-wait');
    return true;
  }
  if (st.task === 'waiting-window' && !waitsWindow) {
    taskMove(task, 'window-reset');
    return true;
  }
  return false;
}

export function runTask(task: LiveTask, deps: RunDeps): RunHandle {
  const live = new Map<string, LiveSession>();
  const hooked = new Set<string>();
  let stopped = false;
  let dirty = true;
  let liveVersion = 0;
  let wakeUp: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleWaiters: ((why: string) => void)[] = [];
  /** Действие, которое ничего не сдвинуло: повтор того же без нового события не пишется. */
  let stuck: string | null = null;
  /** Как кончился последний ход шага (этап 12, L3): по нему продолжение чата шлёт слово или нет. */
  const lastTurn = new Map<string, LastTurn>();

  const note = (event: string, data: Record<string, unknown>) => deps.note?.(event, data);
  const wake = () => {
    dirty = true;
    const w = wakeUp;
    wakeUp = null;
    w?.();
  };
  const unsubscribe = task.subscribe(() => wake());
  // Место где-то на машине освободилось (этап 11, P141): ждущие шаги пробуют снова.
  const seats = deps.allocator;
  const unseat = seats?.subscribe(() => {
    seatsFreed(task);
    wake();
  });

  /**
   * Конец задачи — общий путь `closeTask`, кто бы её ни кончил: дирижёр (`finishTask`) или
   * команда человека мимо дирижёра. Живые сессии исполнителя снимаются деревом, крючки конца
   * идут ровно раз. Задача, кончившаяся до этого исполнителя, закрыта, только если отчёт конца
   * уже в журнале: кончившуюся в окне запуска исполнителя закрывает он сам.
   */
  let closed = task.state.ended !== null && !endUnclosed(task.state);
  const closeEnded = async (): Promise<void> => {
    if (closed || task.state.ended === null) return;
    closed = true;
    await closeTask(task, {
      hooks: deps.hooks,
      note,
      stopSessions: async () => {
        for (const [stepId, e] of live) {
          live.delete(stepId);
          if (!e.ended) await deps.sessions.end(e.sessionId, 'tree');
        }
        if (seats) dropAllSeats(task, seats, 'task ended');
        liveVersion += 1;
      },
    });
  };

  /**
   * Первое сообщение открытой сессии (этап 5): бриф новому сеансу, дельта возобновлённому
   * разговору; модель уже всё видела — короткая строка шага (ход всё равно нужен).
   */
  const openingOf = async (
    s: StepCtx,
    sessionId: string,
    sections: BriefSection[],
  ): Promise<Reopening | null> => {
    // Чат открывается словом человека, а не брифом шага: в виде сеанса первым пузырём стоит то,
    // что человек написал, и модель отвечает на него (этап 10). Продолжение чата после снятия
    // (окно, этап 12 L3) — слово без ответа ещё раз или ничего (`chat-reopen.ts`).
    if (s.def.kind === 'chat') {
      if (chatReopened(task, s.stepId, sessionId))
        return chatReopening(task, s.stepId, lastTurn.get(s.stepId));
      const first = chatOpeningOf(task);
      if (first) return { text: first, origin: 'platform' };
    }
    const economy = deps.economy;
    if (!economy?.opening) return { text: briefText(s, sections), origin: 'platform' };
    const text = (await economy.opening(task, s, sessionId, sections)) ?? stepLine(s);
    return { text, origin: 'platform' };
  };

  /**
   * Ошибка хода с текстом «войдите заново» (P170): конец хода ждёт перечитанного входа. «Нет» —
   * вопрос пункта 4 поднят, сессия снимается (шаг ждёт человека); иначе — обычный конец хода.
   */
  const settleLogin = async (s: StepCtx, own: LiveSession, text: string): Promise<void> => {
    let got: 'asked' | 'normal' = 'normal';
    try {
      got = await settleLoginLost(
        task,
        { stepId: s.stepId, sessionId: own.sessionId, text, step: s.def },
        { ...(deps.loginState ? { loginState: deps.loginState } : {}), raise: deps.raise, note },
      );
    } catch (err) {
      note('login.settle-failed', { stepId: s.stepId, reason: String(err) });
    }
    const ctx = got === 'asked' && live.get(s.stepId) === own ? ctxFor() : null;
    if (ctx) await endSession(ctx, s.stepId, 'tree');
    else own.turnEnd = { seq: task.state.seq };
    liveVersion += 1;
    wake();
  };

  const openSession = async (s: StepCtx, sections: BriefSection[]): Promise<string | null> => {
    let entry: LiveSession | null = null;
    // Этап 12 (P170): текст «войдите заново» в ошибке этого хода — до его конца.
    let loginSuspect: string | null = null;
    // Этап 12 (L3): ход кончился ошибкой — слово человека осталось без ответа.
    let turnFailed = false;
    const got = await deps.sessions.open(s, [], {
      loginLost: (text) => {
        if (entry && !entry.warming) loginSuspect = text;
      },
      turnError: () => {
        if (entry && !entry.warming) turnFailed = true;
      },
      turnEnded: () => {
        if (!entry) return;
        if (entry.warming) {
          // Конец хода прогрева: шаг стоит, где стоял, — прежний конец хода остаётся в силе.
          entry.warming = false;
          return;
        }
        lastTurn.set(s.stepId, turnFailed ? 'failed' : 'answered');
        turnFailed = false;
        if (loginSuspect !== null) {
          const text = loginSuspect;
          loginSuspect = null;
          void settleLogin(s, entry, text);
          return;
        }
        entry.turnEnd = { seq: task.state.seq };
        liveVersion += 1;
        wake();
      },
      // Инструмент без результата и в конце хода держит безопасную точку закрытой (фоновая
      // команда, вопрос права): снимать сессию можно только после его результата.
      tool: (delta) => {
        if (!entry || entry.warming) return;
        entry.toolsOpen = Math.max(0, entry.toolsOpen + delta);
        if (delta === 1) entry.turnEnd = null;
        liveVersion += 1;
        wake();
      },
      ended: () => {
        if (!entry) return;
        entry.ended = true;
        // Сеанс кончился сам: место — сразу, не через три удара. Снятый нами (`endSession`) уже
        // не в `live` — его место отпускает снимающий, а не поздний конец прежнего сеанса шага.
        if (seats && live.get(s.stepId) === entry) dropSeat(task, seats, s.stepId, 'session ended');
        liveVersion += 1;
        wake();
      },
    });
    if (!got.ok) {
      note('session.refused', { stepId: s.stepId, reason: got.reason });
      return got.reason;
    }
    entry = {
      sessionId: got.sessionId,
      turnEnd: null,
      ended: false,
      toolsOpen: 0,
      sentSeq: task.state.seq,
    };
    live.set(s.stepId, entry);
    liveVersion += 1;
    let opening: Reopening | null;
    try {
      opening = await openingOf(s, got.sessionId, sections);
    } catch (err) {
      // Дельта сверх бюджета (C бросает `BriefOverBudget`): сессия без задания не остаётся.
      live.delete(s.stepId);
      await deps.sessions.end(got.sessionId, 'tree');
      return `${END_REASON.briefOverBudget}: ${String((err as Error).message ?? err)}`;
    }
    if (opening === null) {
      // Продолжение чата после отвеченного хода: слать нечего, сессия стоит в конце хода — слово
      // человека дойдёт обычной доставкой (`deliverIdle`).
      entry.turnEnd = { seq: task.state.seq };
      liveVersion += 1;
      wake();
      return null;
    }
    // Ключ дубля — сам шаг: та же сессия после перезапуска ядра получит «дубль», не второй бриф.
    // Продолжение чата после снятия — ключ этой сессии: ключ-UUID становится uuid сообщения CLI,
    // а Claude, продолжая тот же разговор (`--resume`), молча отбрасывает сообщение с uuid, который
    // в разговоре уже есть, — повтор слова с ключом шага не доходил до модели вовсе (этап 12, L3).
    const cmdId =
      s.def.kind === 'chat' && chatReopened(task, s.stepId, got.sessionId)
        ? `${s.stepId}:reopen:${got.sessionId}`
        : s.stepId;
    // Картинки вопроса едут только с первым словом чата: модель видит их в том же ходе.
    const images = s.def.kind === 'chat' && opening.origin === 'platform' ? chatImagesOf(task) : [];
    if (images.length > 0)
      await deps.sessions.send(got.sessionId, opening.text, cmdId, opening.origin, images);
    else await deps.sessions.send(got.sessionId, opening.text, cmdId, opening.origin);
    return null;
  };

  const ctxFor = (): PerformCtx | null => {
    const st = task.state;
    const ref = st.scenario?.pending?.to ?? st.scenario?.ref ?? st.created?.scenario;
    const scenario = ref ? deps.scenarioOf(ref) : undefined;
    if (!ref || !scenario) return null;
    return { task, deps, scenario, ref, live, openSession, refusals };
  };
  const refusals = new Map<string, number>();

  /**
   * Отправить сессии слово человека и записать доставку ПОСЛЕ отправки (E, F26): строка до
   * отправки потеряла бы слово при крахе, а повтор после краха отсечёт ключ дубля `ref.id`.
   */
  const sendAll = async (stepId: string, entry: LiveSession, out: Outgoing[]): Promise<void> => {
    if (out.length === 0) return;
    let ledger: HumanLedger | null = null;
    for (const msg of out) {
      entry.turnEnd = null;
      entry.sentSeq = task.state.seq;
      // Слово и ответ человека помечены его строкой (P37); напоминание и подсказка наблюдателя —
      // голос платформы: хук человека не должен принять их за слово человека.
      const origin = msg.ref.kind === 'reminder' || msg.ref.kind === 'hint' ? 'platform' : 'human';
      await deps.sessions.send(entry.sessionId, msg.text, msg.ref.id, origin);
      ledger ??= readHumanLedger(task);
      recordDelivery(task, ledger, { stepId, sessionId: entry.sessionId }, msg.ref);
    }
    liveVersion += 1;
  };

  /** Концы ходов — крючкам `onTurnEnd` (E: доставка) раньше суда `next` (напоминание). */
  const turnEnds = async (ctx: PerformCtx): Promise<void> => {
    for (const [stepId, entry] of live) {
      if (!entry.turnEnd) continue;
      const key = `${stepId}:${entry.turnEnd.seq}`;
      if (hooked.has(key)) continue;
      hooked.add(key);
      const s = stepCtx(ctx, stepId);
      if (!s) continue;
      const claim = task.state.steps[stepId]?.claim;
      const hadStepDone = claim !== undefined && claim.seq > entry.sentSeq;
      const out = await hook.turnEnd(deps.hooks, s, { seq: entry.turnEnd.seq, hadStepDone });
      await sendAll(stepId, entry, out);
    }
  };

  /**
   * Ответ или сообщение пришли, когда сессия уже стоит в конце хода и крючок этого хода отработал:
   * без этого слово ждало бы следующего хода, а `next` вместо него послал бы напоминание.
   * Что доставлять, решает E (`pendingDeliveries`); журнал перечитывается раз на новую строку.
   */
  const deliverIdle = async (): Promise<void> => {
    for (const [stepId, entry] of live) {
      if (entry.ended || !entry.turnEnd || entry.checkedSeq === task.state.seq) continue;
      // Сеанс отдал место на вопросе: слово ждёт, пока место не вернётся (P141).
      if (seats && waitsForSeat(task, stepId)) continue;
      const out = pendingDeliveries(readHumanLedger(task), stepId);
      if (seats && out.length > 0 && !(await unparkSeat(task, seats, stepId))) continue;
      entry.checkedSeq = task.state.seq;
      await sendAll(stepId, entry, out);
    }
    // Сеанс стоит в конце хода на открытом вопросе человеку — место отдаётся (P141).
    for (const [stepId, e] of seats ? live : []) {
      if (e.ended || e.warming || e.turnEnd === null || e.toolsOpen > 0) continue;
      if (Object.values(task.state.asks).some((a) => a.state === 'open' && a.stepId === stepId))
        parkSeat(task, seats!, stepId, e.sessionId);
    }
  };

  /** Уход за вопросами (E) по таймеру, пока хоть один открыт: напоминание и срок идут по часам. */
  let upkeepDue = false;
  let upkeepTimer: ReturnType<typeof setTimeout> | null = null;
  const upkeep = (): void => {
    if (upkeepDue) {
      upkeepDue = false;
      const ledger = readHumanLedger(task);
      applyAskUpkeep(task, ledger, decideAskUpkeep(ledger, deps.now()));
    }
    const open = Object.values(task.state.asks).some((a) => a.state === 'open');
    if (!open || stopped) {
      if (upkeepTimer) clearTimeout(upkeepTimer);
      upkeepTimer = null;
      return;
    }
    if (upkeepTimer) return;
    upkeepTimer = setTimeout(() => {
      upkeepTimer = null;
      upkeepDue = true;
      wake();
    }, deps.upkeepEveryMs ?? UPKEEP_EVERY_MS);
    upkeepTimer.unref?.();
  };

  const facts = (): Record<string, LiveStepFact> => {
    const out: Record<string, LiveStepFact> = {};
    for (const [stepId, e] of live) {
      const unitId = task.state.steps[stepId]?.unitId ?? '';
      const safe = decideSafepoint({
        toolsOpen: e.toolsOpen,
        checksInFlight: checksInFlight(task.state, unitId),
        atTurnEnd: e.turnEnd !== null || e.ended,
      }).safe;
      out[stepId] = { sessionId: e.sessionId, turnEnd: e.turnEnd, ended: e.ended, safe };
    }
    return out;
  };

  const working = (): boolean => [...live.values()].some((e) => !e.ended && e.turnEnd === null);

  const sleep = (): Promise<void> =>
    dirty || stopped
      ? Promise.resolve()
      : new Promise<void>((r) => {
          wakeUp = r;
        });

  const arm = (action: NextAction): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (action.kind !== 'wait') return;
    // Срок шага — по рабочему времени задачи, ожидание форжа (P77) — по стене: будит ближний.
    const now = deps.now();
    const work =
      action.untilWorkMs === undefined
        ? Infinity
        : action.untilWorkMs - workNow(task.state, now) + 1;
    const wall = action.untilWallMs === undefined ? Infinity : action.untilWallMs - now + 1;
    const ms = Math.min(work, wall);
    if (ms === Infinity) return;
    timer = setTimeout(wake, Math.max(1, ms));
    timer.unref?.();
  };

  /** Перепроверка окна маршрута: сброс по стене или факт сети/пополнения (P116, P122). */
  let windowTimer: ReturnType<typeof setTimeout> | null = null;
  const armWindow = (ms: number | null): void => {
    if (windowTimer) clearTimeout(windowTimer);
    windowTimer = null;
    if (ms === null || stopped) return;
    windowTimer = setTimeout(wake, ms);
    windowTimer.unref?.();
  };

  const learnedOf = (
    economy: NonNullable<RunDeps['economy']>,
    scenario: PerformCtx['scenario'],
  ): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [stepId, rec] of Object.entries(task.state.steps)) {
      if (rec.outcome !== undefined) continue;
      const def = scenario.steps.find((d) => d.id === rec.stepDefId);
      if (!def) continue;
      const got = economy.learnedTokens?.(task, { stepId, unitId: rec.unitId, kind: def.kind });
      if (got !== undefined) out[stepId] = got;
    }
    return out;
  };

  /**
   * Прогрев кэша (G8): кого греть, решает E (`decideKeepWarm` в проводке), исполнитель шлёт слово
   * в ту же сессию и пишет строку `signal keep-warm` с числами решения. Такт — пока есть живые
   * сессии, раз в `KEEP_WARM_TICK_MS`. Сбой прогрева — заметка, не сбой цикла.
   */
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  const idleSessions = (): IdleSession[] => {
    const asked = new Set(
      Object.values(task.state.asks)
        .filter((a) => a.state === 'open' && a.stepId !== null)
        .map((a) => a.stepId as string),
    );
    return [...live]
      .filter(([, e]) => !e.ended && !e.warming && e.turnEnd !== null && e.toolsOpen === 0)
      .map(([stepId, e]) => ({
        sessionId: e.sessionId,
        stepId,
        turnSeq: e.turnEnd?.seq ?? 0,
        parked: asked.has(stepId),
      }));
  };
  const keepWarm = async (warm: NonNullable<RunEconomy['keepWarm']>): Promise<void> => {
    for (const ping of warm(task, idleSessions())) {
      const entry = [...live.values()].find((e) => e.sessionId === ping.sessionId);
      if (!entry || entry.ended || entry.warming) continue;
      entry.warming = true;
      const seq = task.append({
        kind: 'signal',
        actor: 'core',
        sessionId: ping.sessionId,
        data: {
          signal: KEEP_WARM_SIGNAL,
          severity: 'info',
          subject: ping.sessionId,
          detail: JSON.stringify({ reasons: ping.reasons, numbers: ping.numbers }),
        },
      }).seq;
      await deps.sessions.send(
        ping.sessionId,
        ping.word,
        `keep-warm:${ping.sessionId}:${seq}`,
        'platform',
      );
    }
  };
  const armKeepWarm = (): void => {
    const warm = deps.economy?.keepWarm;
    if (!warm || warmTimer || stopped || live.size === 0) return;
    warmTimer = setTimeout(() => {
      warmTimer = null;
      if (stopped) return;
      void keepWarm(warm)
        .catch((err: unknown) => note('keep-warm.failed', { error: String(err) }))
        .finally(() => armKeepWarm());
    }, deps.economy?.keepWarmTickMs ?? KEEP_WARM_TICK_MS);
    warmTimer.unref?.();
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      dirty = false;
      await closeEnded();
      const ctx = ctxFor();
      if (!ctx) {
        note('scenario.missing', { ref: task.state.scenario?.ref ?? null });
        await sleep();
        continue;
      }
      await turnEnds(ctx);
      await deliverIdle();
      upkeep();
      const economy = deps.economy;
      const windows = economy ? stepWindows(task, ctx.scenario, economy) : undefined;
      // Конец хода, пришедший после прохода крючков (события CLI идут цепочкой обещаний и
      // вклиниваются между ожиданиями круга), суд не видит, пока его не видели крючки: иначе
      // вместо подсказки наблюдателя уходит напоминание (этап 8, живой прогон claude).
      const liveFacts = facts();
      const unseen = Object.entries(liveFacts).some(
        ([stepId, f]) => f.turnEnd !== null && !hooked.has(`${stepId}:${f.turnEnd.seq}`),
      );
      if (unseen) continue;
      if (seats) pruneSeatWaits(task, seats);
      const children = deps.xl?.childrenOf(task) ?? null;
      const contour = economy?.contour?.();
      const decision = decideNext({
        state: task.state,
        scenario: ctx.scenario,
        workNowMs: workNow(task.state, deps.now()),
        nowMs: deps.now(),
        live: liveFacts,
        ...(windows ? { windows } : {}),
        ...(economy?.learnedTokens ? { learnedTokens: learnedOf(economy, ctx.scenario) } : {}),
        ...(seats ? { seats: seatWaits(task) } : {}),
        ...(children ? { children } : {}),
        ...(contour ? { contour } : {}),
      });
      const action = decision.action;
      // Ожидание окна без живой сессии — состояние задачи (01:119: время работы его не считает).
      if (windowMove(task, action, working())) {
        if (task.state.task === 'waiting-window' && action.kind === 'wait' && action.window)
          journalWaitTier(task, ctx.scenario, economy, action.window.stepId);
        continue;
      }
      const key = JSON.stringify(action);
      arm(action);
      armWindow(
        windows
          ? windowWakeMs(
              windows,
              ctx.scenario,
              task.state,
              deps.now(),
              economy?.recheckMs ?? WINDOW_RECHECK_MS,
            )
          : null,
      );
      armKeepWarm();
      if (action.kind === 'wait' || key === stuck) {
        if (!working() && !timer) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const w of waiters)
            w(action.kind === 'wait' ? action.reason : `stuck ${action.kind}`);
        }
        await sleep();
        if (dirty) stuck = null;
        continue;
      }
      const seq = task.append({
        kind: 'decision',
        actor: 'core',
        data: {
          decisionId: newId(),
          class: 'next',
          inputs: decision.inputs,
          facts: [],
          numbers: { workNowMs: workNow(task.state, deps.now()) },
          reasons: decision.reasons,
          output: action as never,
        },
      }).seq;
      const version = liveVersion;
      let failed = false;
      try {
        await perform(ctx, action);
      } catch (err) {
        failed = true;
        note('perform.failed', { action: action.kind, error: String(err) });
      }
      // Конец, сделанный этим действием, закрывается в том же проходе: снятие ядра сразу после
      // него (`stop('keep')`) не должно оставить задачу без крючков конца.
      await closeEnded();
      // Ничего не сдвинулось — ждём настоящего события, а не крутим то же действие. Упавшее
      // действие — тоже: его строки до сбоя не новое событие, повтор сразу упал бы так же.
      if (failed || (task.state.seq === seq && liveVersion === version)) {
        stuck = key;
        dirty = false;
      } else stuck = null;
    }
  };

  const running = loop().catch((err: unknown) => note('loop.failed', { error: String(err) }));

  return {
    async stop(sessions = 'end') {
      stopped = true;
      unsubscribe();
      unseat?.();
      if (timer) clearTimeout(timer);
      if (upkeepTimer) clearTimeout(upkeepTimer);
      if (windowTimer) clearTimeout(windowTimer);
      if (warmTimer) clearTimeout(warmTimer);
      wake();
      await running;
      // Смерть ядра в тестах P11/P10: сессии живут дальше, их прикрепит следующее ядро.
      if (sessions === 'keep') return;
      // Обход единиц снимает исполнитель по строке конца — бывает, раньше его прохода по ней.
      await closeEnded();
      for (const [stepId, e] of live) {
        live.delete(stepId);
        if (!e.ended) await deps.sessions.end(e.sessionId, 'soft');
      }
      // Места — после сеансов; `stop('keep')` их держит: хосты живы, их прикрепит следующее ядро.
      if (seats) dropAllSeats(task, seats, 'runner stopped');
    },
    wake,
    idle() {
      return new Promise<string>((r) => {
        idleWaiters.push(r);
        wake();
      });
    },
  };
}
