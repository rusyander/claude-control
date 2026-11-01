import type { StubTask, TimedMove } from '../stub-tasks.types.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны I этапа 8 (наблюдатель: целостность — утечка ресурса, окно маршрута, рост
 * контекста). Файл зоны; каталог `STUB_TASKS` подхватывает сам. Срабатывающие задачи несут факт
 * внешней границы: отказ сервера маршрута при снятии аренды (`lease`), заголовки окна на ответе
 * хода (`MoveTiming.window`), расход ответа (`MoveTiming.usage`) при известном окне контекста
 * маршрута (`routeWindowTokens`). Почти-двойник — обычный шаг с теми же фактами по эту сторону
 * порога: аренда снята, окно открыто, контекст 55 % окна, подагент сверх 60 % контекст главной не
 * растит.
 */

/** Окно контекста маршрута стенда в токенах. */
export const ROUTE_WINDOW = 200_000;

const INPUT = {
  title: 'Summarise README',
  request: 'Read README.md and report what the repository is for.',
  repo: BASE_REPO,
  stepKind: 'work',
  requirements: [{ id: REQ_1, text: 'purpose of the repository reported' }],
};

const DONE = {
  op: 'model-tool',
  tool: 'step_done',
  args: {
    stepId: '${stepId}',
    outcome: 'done',
    requirements: [{ id: REQ_1, state: 'n/a', evidence: 'report-only step, nothing to check' }],
    summary: 'README read; the repository is a throwaway stub repo',
  },
} as const;

const READ: TimedMove = { op: 'read', path: '${copy}/README.md' };
/**
 * Второй вызов до `step_done`: факты ответа (расход, окно) ложатся на ход, пока шаг работает.
 * Ход текстом здесь не годится — настоящий CLI на ответе текстом кончает свой ход.
 */
const READ_GREET: TimedMove = { op: 'read', path: '${copy}/src/greet.txt' };
const REPORT: TimedMove = { op: 'text', text: 'Reported.' };
/** Расход ответа: контекст (вход + чтение и запись кеша) = `share` окна маршрута. */
const usageAt = (share: number, subagent = false): TimedMove['usage'] => {
  const context = Math.round(ROUTE_WINDOW * share);
  const input = Math.round(context * 0.1);
  const cacheWrite = Math.round(context * 0.2);
  return {
    input,
    cacheRead: context - input - cacheWrite,
    cacheWrite,
    output: 400,
    ...(subagent ? { subagent: true as const } : {}),
  };
};

const ALL = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const;

/**
 * Обычный шаг до конца (P33, F13: ложное = дефект): аренда маршрута снята и подтверждена, окно
 * открыто и не меняет вердикта, контекст главной сессии растёт до 55 % окна, ответ подагента
 * сверх 60 % своего контекста — не контекст сессии. Ни `resource-leak`, ни `window`, ни
 * `context-growth` выйти не должны.
 */
export const INTEGRITY_CLEAN_STEP: StubTask = {
  id: 'integrity-clean-step',
  summary:
    'a step releases its lease, the route window stays open, the context stops at 55 % and a subagent passes 60 % → no integrity signal',
  adversarial: false,
  input: INPUT,
  lease: { release: 'released' },
  routeWindowTokens: ROUTE_WINDOW,
  moves: [
    {
      ...READ,
      usage: usageAt(0.3),
      window: { status: 'allowed', usedPct: 40, resetInMs: 3_600_000 },
    },
    {
      ...READ_GREET,
      usage: usageAt(0.55),
      window: { status: 'allowed', usedPct: 42, resetInMs: 3_600_000 },
    },
    { ...DONE, usage: usageAt(0.75, true) },
    REPORT,
  ],
  dialects: [...ALL],
  verdicts: [
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'resource-leak' },
      expect: 'the lease is released and verified at task end: no resource.leak row',
      journal: { present: ['resource.verified'], absent: ['resource.leak'] },
    },
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'window' },
      expect: 'the route window is open on every answer: window silent',
      journal: { present: ['window.state'] },
    },
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'context-growth' },
      expect: 'the main session stops at 55 % of the route window, the subagent does not count',
      journal: { present: ['turn.usage'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
};

/** Сервер маршрута не остановился при снятии аренды в конце задачи — утечка с причиной. */
export const INTEGRITY_LEAKED_LEASE: StubTask = {
  id: 'integrity-leaked-lease',
  summary: 'the route refuses to release the step lease at task end → resource-leak (warn, show)',
  adversarial: true,
  input: INPUT,
  lease: { release: 'refused', reason: 'route server did not stop: 503' },
  moves: [READ, DONE, REPORT],
  dialects: [...ALL],
  verdicts: [
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'resource-leak' },
      expect: 'one resource.leak row naming the refusal, one resource-leak signal on its rid',
      journal: { present: ['resource.leak'] },
    },
  ],
  observer: { signals: ['resource-leak'] },
  phase2: [],
};

/** Окно подписки предупредило, потом отказало: переход в держащий вердикт — сигнал окна. */
export const INTEGRITY_WINDOW_REFUSAL: StubTask = {
  id: 'integrity-window-refusal',
  summary:
    'the subscription window warns, then refuses on the next answer → window (info, then warn)',
  adversarial: true,
  input: INPUT,
  moves: [
    { ...READ, window: { status: 'allowed_warning', usedPct: 85, resetInMs: 3_600_000 } },
    { ...READ_GREET, window: { status: 'rejected', usedPct: 100, resetInMs: 600_000 } },
    DONE,
    REPORT,
  ],
  dialects: [...ALL],
  verdicts: [
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'window' },
      expect: 'window.state warn then refused; one window signal per transition',
      journal: { present: ['window.state'] },
    },
  ],
  observer: { signals: ['window'] },
  phase2: [],
};

/** Контекст главной сессии растёт 40 % → 65 % окна: парковка на безопасной точке. */
export const INTEGRITY_CONTEXT_RAMP: StubTask = {
  id: 'integrity-context-ramp',
  summary: 'the main session context climbs past 60 % of the route window → context-growth (park)',
  adversarial: true,
  input: INPUT,
  routeWindowTokens: ROUTE_WINDOW,
  moves: [{ ...READ, usage: usageAt(0.4) }, { ...READ_GREET, usage: usageAt(0.65) }, DONE, REPORT],
  dialects: [...ALL],
  verdicts: [
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'context-growth' },
      expect: 'one context-growth signal once the context passes 60 %, a soft park asked',
      journal: { present: ['turn.usage'] },
    },
  ],
  observer: { signals: ['context-growth'] },
  phase2: [],
};

/** Окно, названное сессией, у каждого ответа: маршрут по входу CLI своего окна не знает. */
const reportedAt = (share: number): TimedMove['usage'] => ({
  ...usageAt(share)!,
  contextWindow: ROUTE_WINDOW,
});

/**
 * Вход CLI по подписке: окна в настройках маршрута нет, его называет сама сессия
 * (`turn.usage.contextWindow`). Рост 40 % → 65 % названного окна — та же парковка.
 */
export const INTEGRITY_CONTEXT_RAMP_REPORTED: StubTask = {
  id: 'integrity-context-ramp-reported',
  summary:
    'no route window (cli login); the session reports its window and the context climbs past 60 % of it → context-growth (park)',
  adversarial: true,
  input: INPUT,
  moves: [
    { ...READ, usage: reportedAt(0.4) },
    { ...READ_GREET, usage: reportedAt(0.65) },
    DONE,
    REPORT,
  ],
  dialects: [...ALL],
  verdicts: [
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'context-growth' },
      expect: 'one context-growth signal judged on the reported window, a soft park asked',
      journal: { present: ['turn.usage'] },
    },
  ],
  observer: { signals: ['context-growth'] },
  phase2: [],
};

/** Почти-двойник: то же названное окно, контекст останавливается на 55 % — тишина. */
export const INTEGRITY_CONTEXT_REPORTED_55: StubTask = {
  id: 'integrity-context-reported-55',
  summary:
    'no route window (cli login); the session reports its window and the context stops at 55 % of it → no signal',
  adversarial: false,
  input: INPUT,
  moves: [
    { ...READ, usage: reportedAt(0.4) },
    { ...READ_GREET, usage: reportedAt(0.55) },
    DONE,
    REPORT,
  ],
  dialects: [...ALL],
  verdicts: [
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'context-growth' },
      expect: 'the main session stops at 55 % of the reported window: context-growth silent',
      journal: { present: ['turn.usage'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
};

export const STAGE8_I: readonly StubTask[] = [
  INTEGRITY_CLEAN_STEP,
  INTEGRITY_LEAKED_LEASE,
  INTEGRITY_WINDOW_REFUSAL,
  INTEGRITY_CONTEXT_RAMP,
  INTEGRITY_CONTEXT_RAMP_REPORTED,
  INTEGRITY_CONTEXT_REPORTED_55,
];
