import type { StubTask, TimedMove } from '../stub-tasks.types.ts';
import { BASE_REPO, HELLO_FILE, HELLO_TEXT, REQ_1 } from './happy-path.ts';

const finish = (summary: string): TimedMove[] => [
  { op: 'write', path: `\${copy}/${HELLO_FILE}`, content: HELLO_TEXT },
  {
    op: 'model-tool',
    tool: 'step_done',
    args: {
      stepId: '${stepId}',
      outcome: 'done',
      requirements: [{ id: REQ_1, state: 'n/a', evidence: 'no check registry before phase 3' }],
      summary,
    },
  },
  { op: 'text', text: 'Step finished.' },
];

const INPUT = {
  title: 'Add hello.txt',
  request: `Create ${HELLO_FILE} with a greeting.`,
  repo: BASE_REPO,
  stepKind: 'work',
  requirements: [{ id: REQ_1, text: `${HELLO_FILE} exists with a greeting` }],
};

/**
 * Блокирующий вопрос ВНЕ закрытого списка (F10, P20 P96): модель просит остановиться ради
 * вкусового выбора. Ядро не читает прозу вопроса: без типизированного действия это развилка в
 * итоговый отчёт, шаг идёт дальше с рекомендацией модели, человека никто не ждёт.
 */
export const OFF_LIST_BLOCKING_ASK: StubTask = {
  id: 'off-list-blocking-ask',
  summary: 'blocking ask_human with no typed action → fork for the final report, never a wait',
  adversarial: true,
  input: INPUT,
  moves: [
    {
      op: 'model-tool',
      tool: 'ask_human',
      args: {
        question: 'Tabs or spaces in hello.txt? I will wait for your answer before going on.',
        options: ['tabs', 'spaces'],
        recommendation: 'spaces',
        blocking: true,
      },
    },
    ...finish('hello.txt written; indentation fork decided with the recommendation'),
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P20',
      phase: 2,
      judge: { kind: 'decision', class: 'human-point' },
      expect: 'point null, blocking turned false, fork carried with recommendation «spaces»',
      journal: { present: ['decision'], absent: ['human.asked'] },
    },
    {
      property: 'P96',
      phase: 4,
      judge: { kind: 'decision', class: 'next' },
      expect: 'the fork lands in the final report; the step is never waiting-human',
    },
    {
      property: 'P85',
      phase: 7,
      judge: { kind: 'decision', class: 'permit' },
      expect:
        'executed (grant-lifetime.integration.test, task grant-required-edit): an off-list ' +
        'blocking ask is a fork; the grantRequired edit stays denied at the hook until the grant',
    },
  ],
  observer: { signals: [] },
  phase2: [
    {
      kind: 'model-tool',
      move: 0,
      expect: {
        ok: true,
        result: { humanPoint: false, blocking: false, proceedWith: 'spaces' },
        decision: {
          class: 'human-point',
          output: { point: null, blocking: false },
        },
        journal: { present: ['decision'], absent: ['human.asked'] },
        stepState: 'running',
      },
    },
  ],
};

/**
 * Контроль к предыдущей задаче (не подвох): тот же вопрос, но с типизированным действием из
 * списка — слияние (пункт 1). Без него «ни одного вопроса» могло бы значить «вопросы сломаны».
 */
export const ON_LIST_ASK: StubTask = {
  id: 'on-list-ask',
  summary: 'ask_human typed as merge → human point 1, the step waits for the human',
  adversarial: false,
  input: INPUT,
  moves: [
    {
      op: 'model-tool',
      tool: 'ask_human',
      args: {
        question: 'May the MR be merged?',
        options: ['merge', 'leave open'],
        recommendation: 'leave open',
        blocking: true,
        action: { kind: 'merge', target: 'the task MR' },
      },
    },
    ...finish('hello.txt written after the human answer'),
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P20',
      phase: 2,
      judge: { kind: 'decision', class: 'human-point' },
      expect: 'point 1 (merge), blocking: human.asked journaled, step running → waiting-human',
      journal: { present: ['decision', 'human.asked', 'step.transition'] },
    },
  ],
  observer: { signals: [] },
  phase2: [
    {
      kind: 'model-tool',
      move: 0,
      expect: {
        ok: true,
        result: { humanPoint: true, point: 1, blocking: true },
        decision: { class: 'human-point', output: { point: 1, blocking: true } },
        journal: { present: ['decision', 'human.asked', 'step.transition'] },
        stepState: 'waiting-human',
      },
    },
  ],
};
