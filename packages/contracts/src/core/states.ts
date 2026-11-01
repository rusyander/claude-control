/**
 * Машины состояний ядра (01 §State, F09): у каждого состояния — выходы и срок, данными, а не
 * кодом. Модельная проверка (P17) перебирает каждую пару (состояние, событие): правило ровно одно
 * или ни одного (тогда событие в этом состоянии отклоняется — `unmatched: 'reject'`), у каждого
 * нетерминального состояния есть выход или срок, из каждого достижимого состояния достижим
 * конец, а конец задачи рождает `task.ended`.
 *
 * Модуль чистый — ни zod, ни импортов: читают его и ядро, и панель.
 */

export interface Transition<S extends string, E extends string> {
  on: E;
  from: readonly S[];
  /** `same` — событие принято и записано, состояние не меняется (напоминание, повторный вывод). */
  to: S | 'same';
}

export interface Deadline<E extends string> {
  /** Чем меряется срок — для человека и для таймера дирижёра. */
  measure: string;
  /** Событие, которое рождает истёкший срок; у него обязано быть правило из этого состояния. */
  event: E;
}

export interface MachineDef<S extends string, E extends string> {
  name: string;
  initial: S;
  states: readonly S[];
  terminal: readonly S[];
  events: readonly E[];
  transitions: readonly Transition<S, E>[];
  deadlines: Partial<Record<S, Deadline<E>>>;
  /** Кто выводит состояние без срока (человек, предшественник). */
  exitOwner: Partial<Record<S, string>>;
  unmatched: 'reject';
}

export const TASK_STATES = [
  'draft',
  'estimating',
  'awaiting-launch',
  'running',
  'paused',
  'waiting-window',
  'publishing',
  'done',
  'cancelled',
  'failed',
] as const;
const TASK_EVENTS = [
  'estimate',
  'estimated',
  'launch',
  'pause',
  'resume',
  'window-wait',
  'window-reset',
  'publish',
  'published',
  'finish',
  'cancel',
  'fail',
  'deadline',
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type TaskEvent = (typeof TASK_EVENTS)[number];
const LIVE_TASK = TASK_STATES.filter((s) => !['done', 'cancelled', 'failed'].includes(s));

export const TASK_MACHINE: MachineDef<TaskState, TaskEvent> = {
  name: 'task',
  initial: 'draft',
  states: TASK_STATES,
  terminal: ['done', 'cancelled', 'failed'],
  events: TASK_EVENTS,
  transitions: [
    { on: 'estimate', from: ['draft'], to: 'estimating' },
    { on: 'estimated', from: ['estimating'], to: 'awaiting-launch' },
    { on: 'launch', from: ['draft', 'awaiting-launch'], to: 'running' },
    { on: 'pause', from: ['running', 'waiting-window', 'publishing'], to: 'paused' },
    { on: 'resume', from: ['paused'], to: 'running' },
    { on: 'window-wait', from: ['running'], to: 'waiting-window' },
    { on: 'window-reset', from: ['waiting-window'], to: 'running' },
    { on: 'publish', from: ['running'], to: 'publishing' },
    { on: 'published', from: ['publishing'], to: 'done' },
    // Сценарий без публикации (только ревью, G8): все единицы в конце — задача готова без публикатора.
    { on: 'finish', from: ['running'], to: 'done' },
    { on: 'cancel', from: LIVE_TASK, to: 'cancelled' },
    { on: 'fail', from: LIVE_TASK, to: 'failed' },
    // Срок оценки — бюджет шага плана: оценка не уложилась → задача падает с отчётом.
    { on: 'deadline', from: ['estimating'], to: 'failed' },
    // Срок окна — время сброса: окно открылось → работа продолжается.
    { on: 'deadline', from: ['waiting-window'], to: 'running' },
    // Сроки шагов живут в машине шага; у задачи в работе срок — только напоминание.
    { on: 'deadline', from: ['running', 'publishing'], to: 'same' },
  ],
  deadlines: {
    estimating: { measure: 'plan step budget', event: 'deadline' },
    'waiting-window': { measure: 'window reset time', event: 'deadline' },
    running: { measure: 'step deadlines', event: 'deadline' },
    publishing: { measure: 'publish backoff cycles', event: 'deadline' },
  },
  exitOwner: { draft: 'human', 'awaiting-launch': 'human', paused: 'human' },
  unmatched: 'reject',
};

/** Конец задачи → исход `task.ended`. */
export const TASK_ENDED_OUTCOME: Record<
  'done' | 'cancelled' | 'failed',
  'done' | 'cancelled' | 'failed'
> = {
  done: 'done',
  cancelled: 'cancelled',
  failed: 'failed',
};

/**
 * Исход `task.ended` для состояния, куда пришла задача, или `null`, если это не конец. Читает
 * таблицу машины, а не список в коде: новый конец без исхода — красная модельная проверка P17.
 */
export function taskEndedOutcome(
  state: TaskState,
): (typeof TASK_ENDED_OUTCOME)[keyof typeof TASK_ENDED_OUTCOME] | null {
  if (!(TASK_MACHINE.terminal as readonly TaskState[]).includes(state)) return null;
  return TASK_ENDED_OUTCOME[state as keyof typeof TASK_ENDED_OUTCOME] ?? null;
}

const UNIT_STATES = [
  'planned',
  'blocked',
  'running',
  'ready-to-publish',
  'published',
  'answering',
  'conditional',
  'done',
  'closed',
] as const;
const UNIT_EVENTS = [
  'block',
  'unblock',
  'start',
  'ready',
  'published',
  'threads-found',
  'no-threads',
  'answered',
  'waived',
  'cleared',
  'close',
] as const;
export type UnitState = (typeof UNIT_STATES)[number];
export type UnitEvent = (typeof UNIT_EVENTS)[number];

export const UNIT_MACHINE: MachineDef<UnitState, UnitEvent> = {
  name: 'unit',
  initial: 'planned',
  states: UNIT_STATES,
  terminal: ['done', 'closed'],
  events: UNIT_EVENTS,
  transitions: [
    { on: 'block', from: ['planned'], to: 'blocked' },
    { on: 'unblock', from: ['blocked'], to: 'planned' },
    { on: 'start', from: ['planned'], to: 'running' },
    { on: 'ready', from: ['running'], to: 'ready-to-publish' },
    { on: 'published', from: ['ready-to-publish'], to: 'published' },
    { on: 'threads-found', from: ['published'], to: 'answering' },
    { on: 'no-threads', from: ['published'], to: 'done' },
    { on: 'answered', from: ['answering'], to: 'done' },
    { on: 'waived', from: ['published', 'answering'], to: 'conditional' },
    { on: 'cleared', from: ['conditional'], to: 'closed' },
    {
      on: 'close',
      from: [
        'planned',
        'blocked',
        'running',
        'ready-to-publish',
        'published',
        'answering',
        'conditional',
      ],
      to: 'closed',
    },
  ],
  deadlines: {
    running: { measure: 'step budgets', event: 'close' },
    answering: { measure: 'fix/reply step budgets', event: 'close' },
  },
  exitOwner: {
    planned: 'conductor/schedule',
    blocked: 'predecessor event',
    'ready-to-publish': 'publisher',
    published: 'publisher (threads read once at MR open)',
    conditional: 'human point clears',
  },
  unmatched: 'reject',
};

export const STEP_STATES = [
  'queued',
  'running',
  'checking',
  'waiting-human',
  'round-capped',
  'done',
  'failed',
  'skipped',
] as const;
const STEP_EVENTS = [
  'start',
  'check',
  'checked-green',
  'checked-red',
  'ask',
  'answered',
  'round-cap',
  'skip',
  'fail',
  'deadline',
] as const;
export type StepState = (typeof STEP_STATES)[number];
export type StepEvent = (typeof STEP_EVENTS)[number];

export const STEP_MACHINE: MachineDef<StepState, StepEvent> = {
  name: 'step',
  initial: 'queued',
  states: STEP_STATES,
  terminal: ['done', 'failed', 'skipped'],
  events: STEP_EVENTS,
  transitions: [
    { on: 'start', from: ['queued'], to: 'running' },
    { on: 'check', from: ['running'], to: 'checking' },
    { on: 'checked-green', from: ['checking'], to: 'done' },
    { on: 'checked-red', from: ['checking'], to: 'running' },
    { on: 'ask', from: ['running'], to: 'waiting-human' },
    { on: 'answered', from: ['waiting-human', 'round-capped'], to: 'running' },
    { on: 'round-cap', from: ['running', 'checking'], to: 'round-capped' },
    { on: 'skip', from: ['queued', 'round-capped'], to: 'skipped' },
    {
      on: 'fail',
      from: ['queued', 'running', 'checking', 'waiting-human', 'round-capped'],
      to: 'failed',
    },
    { on: 'deadline', from: ['running', 'checking'], to: 'failed' },
    // Срок вопроса — расписание напоминаний: напомнили, ждём дальше.
    { on: 'deadline', from: ['waiting-human'], to: 'same' },
  ],
  deadlines: {
    running: { measure: 'step budget + stall detector', event: 'deadline' },
    checking: { measure: 'step budget', event: 'deadline' },
    'waiting-human': { measure: 'reminder schedule', event: 'deadline' },
  },
  exitOwner: { queued: 'conductor/schedule', 'round-capped': 'human point 6' },
  unmatched: 'reject',
};

export const SESSION_STATES = ['starting', 'live', 'quiet', 'ended', 'lost'] as const;
const SESSION_EVENTS = ['spawned', 'output', 'silent', 'exited', 'host-dead', 'deadline'] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export type SessionEvent = (typeof SESSION_EVENTS)[number];

export const SESSION_MACHINE: MachineDef<SessionState, SessionEvent> = {
  name: 'session',
  initial: 'starting',
  states: SESSION_STATES,
  terminal: ['ended', 'lost'],
  events: SESSION_EVENTS,
  transitions: [
    { on: 'spawned', from: ['starting'], to: 'live' },
    { on: 'output', from: ['live'], to: 'same' },
    { on: 'output', from: ['quiet'], to: 'live' },
    { on: 'silent', from: ['live'], to: 'quiet' },
    { on: 'exited', from: ['starting', 'live', 'quiet'], to: 'ended' },
    { on: 'host-dead', from: ['starting', 'live', 'quiet'], to: 'lost' },
    // Старт дольше 60 с — сессия кончилась неудачей старта.
    { on: 'deadline', from: ['starting'], to: 'ended' },
    // Тишина дольше порога — проба жизни; живой и молчит — показан, не убит (06 §Observer).
    { on: 'deadline', from: ['quiet'], to: 'same' },
  ],
  deadlines: {
    starting: { measure: '60 s', event: 'deadline' },
    quiet: { measure: 'stall threshold per tool class', event: 'deadline' },
  },
  exitOwner: { live: 'session output / host' },
  unmatched: 'reject',
};

const CHECK_STATES = ['queued', 'leased', 'running', 'recorded', 'no-verdict', 'aborted'] as const;
const CHECK_EVENTS = ['lease', 'start', 'record', 'no-verdict', 'abort', 'deadline'] as const;
export type CheckRunState = (typeof CHECK_STATES)[number];
export type CheckRunEvent = (typeof CHECK_EVENTS)[number];

export const CHECK_MACHINE: MachineDef<CheckRunState, CheckRunEvent> = {
  name: 'check',
  initial: 'queued',
  states: CHECK_STATES,
  terminal: ['recorded', 'no-verdict', 'aborted'],
  events: CHECK_EVENTS,
  transitions: [
    { on: 'lease', from: ['queued'], to: 'leased' },
    { on: 'start', from: ['leased'], to: 'running' },
    { on: 'record', from: ['running'], to: 'recorded' },
    { on: 'no-verdict', from: ['leased', 'running'], to: 'no-verdict' },
    { on: 'abort', from: ['queued', 'leased', 'running'], to: 'aborted' },
    // Очередь стареет — приоритет растёт, состояние то же.
    { on: 'deadline', from: ['queued'], to: 'same' },
    { on: 'deadline', from: ['running'], to: 'aborted' },
  ],
  deadlines: {
    queued: { measure: 'aging', event: 'deadline' },
    running: { measure: 'learned p95 x 3', event: 'deadline' },
  },
  exitOwner: { leased: 'verifier queue' },
  unmatched: 'reject',
};

export const ASK_STATES = ['open', 'answered', 'expired', 'withdrawn'] as const;
const ASK_EVENTS = ['answer', 'expire', 'withdraw'] as const;
export type AskState = (typeof ASK_STATES)[number];
export type AskEvent = (typeof ASK_EVENTS)[number];

export const ASK_MACHINE: MachineDef<AskState, AskEvent> = {
  name: 'ask',
  initial: 'open',
  states: ASK_STATES,
  terminal: ['answered', 'expired', 'withdrawn'],
  events: ASK_EVENTS,
  transitions: [
    { on: 'answer', from: ['open'], to: 'answered' },
    // Поздний ответ на истёкший вопрос сохраняется и показывается (P71), состояние то же.
    { on: 'answer', from: ['expired'], to: 'same' },
    { on: 'expire', from: ['open'], to: 'expired' },
    { on: 'withdraw', from: ['open'], to: 'withdrawn' },
  ],
  deadlines: {},
  exitOwner: { open: 'human (scenario may set expiry)' },
  unmatched: 'reject',
};

const PUBLISH_STATES = [
  'composing',
  'ready',
  'refused',
  'pushing',
  'mr-open',
  'waiting-forge',
  'done',
  'failed',
] as const;
const PUBLISH_EVENTS = [
  'composed',
  'refuse',
  'fix',
  'push',
  'pushed',
  'forge-down',
  'retry',
  'settled',
  'fail',
  'deadline',
] as const;
export type PublishState = (typeof PUBLISH_STATES)[number];
export type PublishEvent = (typeof PUBLISH_EVENTS)[number];

export const PUBLISH_MACHINE: MachineDef<PublishState, PublishEvent> = {
  name: 'publish',
  initial: 'composing',
  states: PUBLISH_STATES,
  terminal: ['done', 'failed'],
  events: PUBLISH_EVENTS,
  transitions: [
    { on: 'composed', from: ['composing'], to: 'ready' },
    { on: 'refuse', from: ['composing', 'ready'], to: 'refused' },
    { on: 'fix', from: ['refused'], to: 'composing' },
    { on: 'push', from: ['ready'], to: 'pushing' },
    { on: 'pushed', from: ['pushing'], to: 'mr-open' },
    { on: 'forge-down', from: ['pushing', 'mr-open'], to: 'waiting-forge' },
    { on: 'retry', from: ['waiting-forge'], to: 'pushing' },
    { on: 'settled', from: ['mr-open'], to: 'done' },
    {
      on: 'fail',
      from: ['composing', 'ready', 'refused', 'pushing', 'mr-open', 'waiting-forge'],
      to: 'failed',
    },
    // Цикл отката ≤ 30 мин: истёк — новая попытка, каждая в журнале.
    { on: 'deadline', from: ['waiting-forge'], to: 'pushing' },
  ],
  deadlines: { 'waiting-forge': { measure: 'backoff <= 30 min cycle', event: 'deadline' } },
  exitOwner: {
    composing: 'publisher/ready',
    ready: 'publisher',
    refused: 'fix step or human point',
    pushing: 'forge reply',
    'mr-open': 'publisher (threads + conflicts read once)',
  },
  unmatched: 'reject',
};

export const MACHINES = {
  task: TASK_MACHINE,
  unit: UNIT_MACHINE,
  step: STEP_MACHINE,
  session: SESSION_MACHINE,
  check: CHECK_MACHINE,
  ask: ASK_MACHINE,
  publish: PUBLISH_MACHINE,
} as const;

export type MachineName = keyof typeof MACHINES;

/** Итог события в состоянии: следующее состояние, «то же» или отказ. Одна функция на всех. */
export function nextState<S extends string, E extends string>(
  machine: MachineDef<S, E>,
  state: S,
  event: E,
): { ok: true; to: S } | { ok: false } {
  const rule = machine.transitions.find((t) => t.on === event && t.from.includes(state));
  if (!rule) return { ok: false };
  return { ok: true, to: rule.to === 'same' ? state : rule.to };
}
