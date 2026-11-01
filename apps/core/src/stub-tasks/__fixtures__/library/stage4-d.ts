import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны D этапа 4 (оценка и деление): пробы `phase4` — что дирижёр обязан
 * показать на настоящем цикле. Каталог `STUB_TASKS` подхватывает их сам; тест библиотеки сверяет
 * пробы с контрактами уже сейчас. id деления в телах команд — постоянный образец: настоящий
 * прогон подставляет id из журнала.
 */

const SPLIT_SAMPLE = '01920000-0000-7000-8000-0000000000d1';
const DIALECTS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const;

/**
 * P95: «только ревью» на двух MR — разбор насчитал две цели, ядро предлагает единицу на MR,
 * проверка принимает, задача ждёт человека (точка 10); ни одна единица деления не стартует до
 * `split.decided`. На одном MR правка на две единицы — отказ `one-review`.
 */
export const REVIEW_TWO_MRS: StubTask = {
  id: 'stage4-review-two-mrs',
  summary:
    'review-only over two MRs → split offered, point 10 asked, no unit start before split.decided',
  adversarial: false,
  input: {
    title: 'Review two merge requests',
    request: 'Review merge requests !11 and !12.',
    repo: BASE_REPO,
    stepKind: 'intake',
    requirements: [{ id: REQ_1, text: 'each merge request is reviewed' }],
  },
  moves: [
    {
      op: 'model-tool',
      tool: 'step_done',
      args: {
        stepId: '${stepId}',
        outcome: 'done',
        requirements: [],
        reviewTargets: [{ ref: '!11' }, { ref: '!12' }],
        summary: 'two merge requests to review: !11, !12',
      },
    },
    { op: 'text', text: 'Intake done.' },
  ],
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P95',
      phase: 4,
      judge: { kind: 'decision', class: 'split-check' },
      expect:
        'split.proposed with two units, decision split-check accepted, split.decided accepted, human.asked point 10, no unit.transition start before split.decided',
      journal: { present: ['split.proposed', 'split.decided', 'human.asked'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'D',
      property: 'P95',
      commands: [{ kind: 'approve-split', fields: { splitId: SPLIT_SAMPLE } }],
      expect: {
        journal: {
          present: ['split.proposed', 'decision', 'split.decided', 'human.asked', 'unit.created'],
        },
        decisions: ['split-check'],
      },
    },
  ],
};

/**
 * P76 (половина порядка) + P101 (половина оценки): два репозитория, единица-контракт раньше
 * единиц другого репозитория, ветка от предшественника того же репозитория, иначе от приколотой
 * базы; предпроверка дорог — строкой при оценке и ещё раз при запуске.
 */
export const TWO_REPOS_CONTRACT: StubTask = {
  id: 'stage4-two-repos-contract',
  summary: 'two repos: the contract unit precedes the other repo; preflight at estimate and launch',
  adversarial: false,
  input: {
    title: 'Add an endpoint and its page',
    request: 'Add GET /hello in the service and a page that shows it in the app.',
    repo: BASE_REPO,
    stepKind: 'plan',
    requirements: [{ id: REQ_1, text: 'the page shows the endpoint answer' }],
  },
  moves: [
    {
      op: 'model-tool',
      tool: 'step_done',
      args: {
        stepId: '${stepId}',
        outcome: 'done',
        requirements: [],
        units: [
          { name: 'web', repo: 'app', ownedPaths: ['app/**'] },
          { name: 'contract', repo: 'svc', ownedPaths: ['api/**'], contract: true },
        ],
        summary: 'contract first, then the page',
      },
    },
    { op: 'text', text: 'Plan done.' },
  ],
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P76',
      phase: 4,
      judge: { kind: 'decision', class: 'split-check' },
      expect: 'decision output order puts contract before web; web.after = [contract]',
      journal: { present: ['split.decided', 'unit.created'] },
    },
    {
      property: 'P101',
      phase: 4,
      judge: { kind: 'signal', signal: 'preflight' },
      expect: 'signal preflight subject estimate, then subject launch before the split units',
      journal: { present: ['signal'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'D',
      property: 'P76',
      expect: {
        journal: { present: ['split.proposed', 'decision', 'split.decided', 'unit.created'] },
        decisions: ['split-check'],
      },
    },
    {
      zone: 'D',
      property: 'P101',
      commands: [{ kind: 'launch', fields: {} }],
      expect: { journal: { present: ['signal', 'task.transition'] } },
    },
  ],
};

export const STAGE4_D: readonly StubTask[] = [REVIEW_TWO_MRS, TWO_REPOS_CONTRACT];
