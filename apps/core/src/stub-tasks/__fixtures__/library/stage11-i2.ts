import type { StubTask, TimedMove } from '../stub-tasks.types.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны I2 этапа 11 (расход сверх оценки, F3, P143). Файл зоны; каталог
 * `STUB_TASKS` подхватывает сам. Оценка запуска — строка `estimate-history` на создании
 * (`StubTask.estimate`), расход — `usage` ходов. Срабатывает одна задача: оценка из истории,
 * расход за 2× её верхней границы. Почти-двойники: тот же расход при оценке без истории, и та же
 * оценка с расходом ниже 2× — молчат. Ни одна не останавливается: сигнал только в ленте.
 */

/** Верхняя граница оценки (`spread[1]`); 2× — 24 000 токенов бюджета. */
export const SPEND_ESTIMATE_UPPER = 12_000;

const HISTORY: NonNullable<StubTask['estimate']> = {
  minutes: 4,
  tokens: 9_000,
  spread: [6_000, SPEND_ESTIMATE_UPPER],
  basis: 'history',
};

const NO_HISTORY: NonNullable<StubTask['estimate']> = {
  minutes: null,
  tokens: null,
  spread: null,
  basis: 'no-history',
};

const INPUT = {
  title: 'Summarise README',
  request: 'Read README.md and report what the repository is for.',
  repo: BASE_REPO,
  stepKind: 'work',
  requirements: [{ id: REQ_1, text: 'purpose of the repository reported' }],
};

const DONE: TimedMove = {
  op: 'model-tool',
  tool: 'step_done',
  args: {
    stepId: '${stepId}',
    outcome: 'done',
    requirements: [{ id: REQ_1, state: 'n/a', evidence: 'report-only step, nothing to check' }],
    summary: 'README read; the repository is a throwaway stub repo',
  },
};

/** Расход ответа хода: `input` + 400 выхода токенов бюджета; чтение кэша бюджетом не считается. */
const spend = (input: number): TimedMove['usage'] => ({
  input,
  cacheRead: 40_000,
  cacheWrite: 0,
  output: 400,
});

/** Два чтения по 14 400 — 28 800 токенов бюджета, за 2× верхней границы. */
const OVER_MOVES: TimedMove[] = [
  { op: 'read', path: '${copy}/README.md', usage: spend(14_000) },
  { op: 'read', path: '${copy}/src/greet.txt', usage: spend(14_000) },
  DONE,
  { op: 'text', text: 'Reported.' },
];

/** Те же чтения по 10 400 — 20 800, ниже 2× верхней границы. */
const UNDER_MOVES: TimedMove[] = [
  { op: 'read', path: '${copy}/README.md', usage: spend(10_000) },
  { op: 'read', path: '${copy}/src/greet.txt', usage: spend(10_000) },
  DONE,
  { op: 'text', text: 'Reported.' },
];

const DIALECTS: StubTask['dialects'] = ['anthropic-messages', 'openai-chat', 'openai-responses'];

function spendTask(
  id: string,
  summary: string,
  estimate: NonNullable<StubTask['estimate']>,
  moves: TimedMove[],
  fires: boolean,
  expect: string,
): StubTask {
  return {
    id,
    summary,
    adversarial: fires,
    input: INPUT,
    estimate,
    moves,
    dialects: DIALECTS,
    verdicts: [
      {
        property: 'P143',
        phase: 11,
        judge: { kind: 'signal', signal: 'spend-over-estimate' },
        expect,
        journal: fires ? { present: ['turn.usage', 'signal'] } : { present: ['turn.usage'] },
      },
    ],
    observer: { signals: fires ? ['spend-over-estimate'] : [] },
    phase2: [],
  };
}

export const STAGE11_I2: readonly StubTask[] = [
  spendTask(
    'spend-over-estimate',
    'a history estimate with upper bound 12 000 and 28 800 budget tokens spent → one spend-over-estimate note, the step runs to step_done',
    HISTORY,
    OVER_MOVES,
    true,
    'one info signal shown in the feed once spend passes 2× the upper bound; never a stop, park or ask',
  ),
  spendTask(
    'spend-over-estimate-no-history',
    'the same 28 800 budget tokens under a no-history estimate → no spend signal',
    NO_HISTORY,
    OVER_MOVES,
    false,
    'a no-history estimate has no number to compare with and stays silent',
  ),
  spendTask(
    'spend-under-estimate',
    'the same history estimate with 20 800 budget tokens spent (below 2×) → no spend signal',
    HISTORY,
    UNDER_MOVES,
    false,
    'spend below 2× the upper bound stays silent',
  ),
];
