import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { SeatAnswer, SeatAsk, SeatPort } from './schedule.types.ts';

/**
 * Место сеанса шага на стороне исполнителя (этап 11, D9, P141): `runStep` берёт место до
 * `openSession`. Ждущий шаг пишет строку `schedule` (исход `waiting`, держатель назван) — одну на
 * пару «шаг × держатель», а не на каждое пробуждение; место пришло после ожидания — строка
 * `granted`. Место, выданное сразу, строки не пишет: ждать было некого.
 *
 * Память исполнителя (по задаче, не в журнале): кто ждёт места (суд `next` ждёт их, а не велит
 * `run-step` на каждой строке задачи), с какой просьбой шаг взял место (её повторяет возврат
 * места после вопроса человеку) и какие сеансы отдали место, встав на вопросе.
 */

interface TaskSeats {
  /** Последняя записанная строка ожидания шага: `держатель:причина`. */
  told: Map<string, string>;
  /** Шаг ждёт места: суд ждёт его до освобождения где-нибудь на машине. */
  waits: Map<string, string>;
  /**
   * Ждущий билет шага лежит в очереди машины. Пробуждение (`seatsFreed`) стирает `waits`, но не
   * билет: встань задача до повтора просьбы — снять его некому было бы, и живое ядро било бы его
   * сердцем вечно во главе очереди.
   */
  pending: Set<string>;
  asks: Map<string, SeatAsk>;
  /** Сеанс стоит на вопросе человеку и отдал место (`parkSeat`). */
  parked: Map<string, string>;
}

const memo = new WeakMap<LiveTask, TaskSeats>();

function seatsOf(task: LiveTask): TaskSeats {
  let m = memo.get(task);
  if (!m)
    memo.set(
      task,
      (m = {
        told: new Map(),
        waits: new Map(),
        pending: new Set(),
        asks: new Map(),
        parked: new Map(),
      }),
    );
  return m;
}

/**
 * Просьба места для шага: «начатая» единица — та, у которой уже был другой шаг (повторный вход
 * того же шага начатой единицу не делает: иначе ожидание само поднимало бы её в порядке).
 */
export function seatAskOf(
  task: LiveTask,
  s: { stepId: string; unitId: string; def: { kind: string } },
  routeId: string,
): SeatAsk {
  const started = Object.entries(task.state.steps).some(
    ([id, rec]) => id !== s.stepId && rec.unitId === s.unitId,
  );
  return {
    taskId: task.taskId,
    stepId: s.stepId,
    unitId: s.unitId,
    stepKind: s.def.kind,
    routeId,
    interactive: s.def.kind === 'chat',
    started,
    remainingMs: null,
    learnedMs: null,
  };
}

function writeDecision(task: LiveTask, ask: SeatAsk, answer: SeatAnswer): void {
  const decision = answer.decision;
  const holder = answer.granted ? null : answer.holder;
  task.append({
    kind: 'decision',
    actor: 'core',
    unitId: ask.unitId,
    stepId: ask.stepId,
    data: {
      decisionId: newId(),
      class: 'schedule',
      inputs: [],
      facts: [],
      numbers: { queued: decision?.order.length ?? 0 },
      reasons: answer.granted
        ? (decision?.reasons ?? [])
        : [answer.reason, ...(decision?.reasons ?? [])],
      // Исход читается по `grant` (`decision-view`): своё место — `granted`, иначе `waiting`.
      output: {
        grant: answer.granted ? [ask.unitId] : [],
        ticketId: answer.ticketId,
        routeId: ask.routeId,
        ...(answer.granted ? {} : { reason: answer.reason, holder }),
        order: decision?.order ?? [],
      } as never,
    },
  });
}

/** `true` — место есть, шаг идёт; `false` — ждёт (проводка разбудит исполнителя на освобождении). */
export async function takeSeat(task: LiveTask, port: SeatPort, ask: SeatAsk): Promise<boolean> {
  const answer = await port.acquire(ask);
  const m = seatsOf(task);
  if (answer.granted) {
    if (m.told.has(ask.stepId)) writeDecision(task, ask, answer);
    m.told.delete(ask.stepId);
    m.waits.delete(ask.stepId);
    m.pending.delete(ask.stepId);
    m.asks.set(ask.stepId, ask);
    return true;
  }
  m.waits.set(ask.stepId, answer.reason);
  m.pending.add(ask.stepId);
  const key = `${answer.holder?.taskId ?? '-'}:${answer.holder?.sessionId ?? '-'}:${answer.reason}`;
  if (m.told.get(ask.stepId) !== key) {
    m.told.set(ask.stepId, key);
    writeDecision(task, ask, answer);
  }
  return false;
}

/** Шаги задачи, ждущие места, с причиной — вход суда `next` (`NextInput.seats`). */
export function seatWaits(task: LiveTask): Readonly<Record<string, string>> {
  return Object.fromEntries(seatsOf(task).waits);
}

export function waitsForSeat(task: LiveTask, stepId: string): boolean {
  return seatsOf(task).waits.has(stepId);
}

/**
 * Ждущий билет шага, которому место больше не нужно (шаг кончился, задача стоит или кончилась),
 * снимается: живое ядро бьёт его сердцем, и сам он не устареет — держал бы голову очереди машины.
 */
export function pruneSeatWaits(task: LiveTask, port: SeatPort): void {
  const m = seatsOf(task);
  const st = task.state;
  const going = st.ended === null && (st.task === 'running' || st.task === 'estimating');
  for (const stepId of new Set([...m.waits.keys(), ...m.pending])) {
    if (m.parked.has(stepId)) continue; // сеанс жив, ждёт место назад — его снимет конец сеанса
    const rec = st.steps[stepId];
    if (!going || !rec || rec.outcome !== undefined) dropSeat(task, port, stepId, 'not waiting');
  }
}

/** Место где-то освободилось: каждый ждущий шаг пробует снова. */
export function seatsFreed(task: LiveTask): void {
  seatsOf(task).waits.clear();
}

/** Отпустить место шага (конец сеанса, снятие задачи); забывает и ожидание, и парковку. */
export function dropSeat(task: LiveTask, port: SeatPort, stepId: string, why: string): void {
  const m = seatsOf(task);
  m.waits.delete(stepId);
  m.pending.delete(stepId);
  m.parked.delete(stepId);
  m.asks.delete(stepId);
  port.release(task.taskId, stepId, why);
}

/** Отпустить все места задачи: держащие и ждущие (конец задачи, снятие исполнителя). */
export function dropAllSeats(task: LiveTask, port: SeatPort, why: string): void {
  const m = seatsOf(task);
  const all = [...m.asks.keys(), ...m.waits.keys(), ...m.pending, ...m.parked.keys()];
  for (const stepId of new Set(all)) dropSeat(task, port, stepId, why);
}

/**
 * Сеанс встал на вопросе человеку (P141): место отдаётся один раз, сеанс живёт дальше. Вернёт
 * `true`, если место отдано сейчас.
 */
export function parkSeat(
  task: LiveTask,
  port: SeatPort,
  stepId: string,
  sessionId: string,
): boolean {
  const m = seatsOf(task);
  if (m.parked.has(stepId) || !m.asks.has(stepId)) return false;
  m.parked.set(stepId, sessionId);
  port.release(task.taskId, stepId, 'parked on a human ask');
  return true;
}

export function isParked(task: LiveTask, stepId: string): boolean {
  return seatsOf(task).parked.has(stepId);
}

/**
 * Перед словом припаркованному сеансу: место снова (та же просьба, что при первом взятии).
 * `false` — ждёт места: слово ждёт вместе с ним.
 */
export async function unparkSeat(task: LiveTask, port: SeatPort, stepId: string): Promise<boolean> {
  const m = seatsOf(task);
  const sessionId = m.parked.get(stepId);
  const ask = m.asks.get(stepId);
  if (sessionId === undefined || !ask) return true;
  if (m.waits.has(stepId)) return false;
  if (!(await takeSeat(task, port, ask))) return false;
  m.parked.delete(stepId);
  port.bind(task.taskId, stepId, sessionId);
  return true;
}
