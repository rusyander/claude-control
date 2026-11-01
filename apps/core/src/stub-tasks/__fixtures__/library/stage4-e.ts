import type { StubTask, TimedMove } from '../stub-tasks.types.ts';
import { BASE_REPO, HELLO_FILE, HELLO_TEXT, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны E этапа 4 (человек и вмешательства): пробы `phase4` — что дирижёр обязан
 * показать на настоящем цикле (волна 2). Каталог `STUB_TASKS` подхватывает их сам; до волны 2
 * тест библиотеки сверяет пробы с контрактами (вид строки, класс решения, тело команды).
 *
 * id вопроса и шага в телах команд — постоянные образцы: настоящий прогон подставляет id из
 * журнала (вопрос, поднятый ходом 0), тело проверяется схемой команды уже сейчас.
 */

const ASK_SAMPLE = '01920000-0000-7000-8000-0000000000a1';
const STEP_SAMPLE = '01920000-0000-7000-8000-0000000000a2';

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

const DIALECTS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const;

/**
 * P71: вопрос из списка (запись в трекер, пункт 9) истёк, пока шаг шёл по умолчанию; ответ
 * человека пришёл позже — хранится, показан, шагу доставлен один раз, шаг не «отпускается».
 */
export const LATE_ANSWER: StubTask = {
  id: 'stage4-late-answer',
  summary: 'an answer after the ask expired is stored, delivered once, and never resumes a step',
  adversarial: false,
  input: INPUT,
  moves: [
    {
      op: 'model-tool',
      tool: 'ask_human',
      args: {
        question: 'Comment on the tracker issue with the result?',
        options: ['comment', 'skip'],
        recommendation: 'skip',
        blocking: false,
        action: { kind: 'tracker-write', target: 'PROJ-1' },
      },
    },
    ...finish('hello.txt written; the tracker comment skipped by default'),
  ],
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P71',
      phase: 4,
      judge: { kind: 'decision', class: 'human-point' },
      expect: 'expired ask, late human.answered stored, one message.delivered late-answer',
      journal: { present: ['human.asked', 'ask.transition', 'human.answered'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'E',
      property: 'P71',
      commands: [{ kind: 'answer', fields: { askId: ASK_SAMPLE, answer: 'comment' } }],
      expect: {
        journal: {
          present: ['human.asked', 'ask.transition', 'human.answered', 'message.delivered'],
        },
        decisions: ['human-point'],
      },
    },
  ],
};

/**
 * P130: правка под `grantRequired` (`infra/**` проекта) — отказ права с пунктом 5; один вопрос
 * на ждущий запрос, шаг ждёт; повтор той же правки вопроса не множит. Путь вне `.claude/`: там
 * судья отказывает как `cli-config` раньше `grantRequired`, и пункт 5 был бы недостижим.
 */
export const GRANT_REQUIRED_EDIT: StubTask = {
  id: 'stage4-grant-required-edit',
  summary: 'an edit under grantRequired raises item 5 once and the step waits for the human',
  adversarial: true,
  input: INPUT,
  grantRequired: [{ globs: ['infra/**'], ops: ['edit'] }],
  moves: [
    { op: 'write', path: '${copy}/infra/deploy.yaml', content: 'replicas: 2\n' },
    { op: 'write', path: '${copy}/infra/deploy.yaml', content: 'replicas: 2\n' },
    ...finish('hello.txt written; the infra edit waits for a grant'),
  ],
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P130',
      phase: 4,
      judge: { kind: 'decision', class: 'permit' },
      expect: 'deny grant-required, one human.asked point 5, step waiting-human',
      journal: { present: ['decision', 'human.asked', 'step.transition'] },
    },
  ],
  // Отказ `grantRequired` ждёт человека (пункт 5): шаг стоит, повтора отказа за шаг нет.
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'E',
      property: 'P130',
      commands: [
        { kind: 'grant', fields: { project: 'r1', globs: ['infra/**'], ops: ['edit'] } },
        { kind: 'answer', fields: { askId: ASK_SAMPLE, answer: 'grant' } },
      ],
      expect: {
        journal: { present: ['decision', 'human.asked', 'grant.given', 'human.answered'] },
        decisions: ['permit', 'human-point'],
      },
    },
  ],
};

/** F26 + P69: сообщение человека и ручная правка между ходами — оба доходят до шага один раз. */
export const MESSAGE_AND_MANUAL_EDIT: StubTask = {
  id: 'stage4-message-and-manual-edit',
  summary:
    'a human message is delivered once at a turn boundary; a manual edit is named in the brief',
  adversarial: false,
  input: INPUT,
  moves: [{ op: 'text', text: 'Looking at the repo.' }, ...finish('hello.txt written')],
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P69',
      phase: 4,
      judge: { kind: 'decision', class: 'next' },
      expect: 'copy.changed-externally names the edited file; the next brief carries it',
      journal: { present: ['copy.changed-externally'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'E',
      property: 'P69',
      commands: [
        { kind: 'message-to-step', fields: { stepId: STEP_SAMPLE, text: 'keep it short' } },
      ],
      expect: {
        journal: { present: ['command.applied', 'message.delivered', 'copy.changed-externally'] },
      },
    },
  ],
};

/** P96: развилка модели вне списка и умолчание ядра — в итоговом отчёте, артефактом. */
export const FINAL_REPORT_FORKS: StubTask = {
  id: 'stage4-final-report-forks',
  summary: 'an off-list ask and a core default land in the final report written once',
  adversarial: false,
  input: INPUT,
  moves: [
    {
      op: 'model-tool',
      tool: 'ask_human',
      args: {
        question: 'Greeting in English or Russian?',
        options: ['English', 'Russian'],
        recommendation: 'English',
        blocking: false,
      },
    },
    ...finish('hello.txt written in English'),
  ],
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P96',
      phase: 4,
      judge: { kind: 'decision', class: 'human-point' },
      expect: 'report.final carries the fork with «English» and the tier default',
      journal: { present: ['report.final'], absent: ['human.asked'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'E',
      property: 'P96',
      expect: {
        journal: { present: ['decision', 'report.final'], absent: ['human.asked'] },
        decisions: ['human-point', 'cleanup'],
      },
    },
  ],
};

export const STAGE4_E: readonly StubTask[] = [
  LATE_ANSWER,
  GRANT_REQUIRED_EDIT,
  MESSAGE_AND_MANUAL_EDIT,
  FINAL_REPORT_FORKS,
];
