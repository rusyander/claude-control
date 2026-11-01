import { PRESETS } from '../../../conductor/scenario/presets.ts';
import type { StubTask, TimedMove } from '../stub-tasks.types.ts';
import { BASE_REPO, HELLO_FILE, HELLO_TEXT, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны A этапа 4 (сценарий, маршрут шага): пробы `phase4` — что дирижёр обязан
 * показать на настоящем цикле. Каталог `STUB_TASKS` подхватывает их сам; тест библиотеки сверяет
 * пробы с контрактами (вид строки, класс решения, тело команды) уже сейчас.
 *
 * id шага в телах команд — постоянный образец: настоящий прогон подставляет id из журнала.
 */

const STEP_SAMPLE = '01920000-0000-7000-8000-0000000000a3';

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

const FEATURE = PRESETS.find((s) => s.id === 'feature' && s.version === 1);
if (!FEATURE) throw new Error('preset feature@1 missing');

/**
 * P70: сценарий правится посреди задачи — новая версия в библиотеке, строка `scenario.edited` с
 * разницей; идущий шаг остаётся на своей версии, следующий берёт новую.
 */
export const SCENARIO_EDIT_MID_TASK: StubTask = {
  id: 'stage4-scenario-edit-mid-task',
  summary:
    'a scenario edited mid-task lands as a new library version; the running step keeps its own',
  adversarial: false,
  input: INPUT,
  moves: [{ op: 'text', text: 'Working.' }, ...finish('hello.txt written')],
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P70',
      phase: 4,
      // Команду человека пропускает судья полномочий; правка — его принятый исход.
      judge: { kind: 'decision', class: 'authority' },
      expect:
        'command.received edit-scenario, scenario.edited with the diff, next step on v1 of the fork',
      journal: { present: ['command.received', 'scenario.edited'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'A',
      property: 'P70',
      commands: [
        {
          kind: 'edit-scenario',
          fields: {
            scenario: { ...FEATURE, id: 'team-flow', version: 1, title: 'Фича (правка)' },
            baseVersion: 1,
            applyNow: false,
          },
        },
      ],
      expect: { journal: { present: ['command.received', 'scenario.edited'] } },
    },
  ],
};

/**
 * P80 (строки tier/continuation) + G9: `set-model` на шаге принят только внутри разрешённого
 * набора; следующий старт шага пишет решения `tier` и `continuation` с тем же выбором.
 */
export const SET_MODEL_THEN_STEP: StubTask = {
  id: 'stage4-set-model-then-step',
  summary: 'set-model is judged by the tier decider; the next step start journals the same choice',
  adversarial: false,
  input: INPUT,
  moves: finish('hello.txt written on the overridden model'),
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P80',
      phase: 4,
      judge: { kind: 'decision', class: 'tier' },
      expect: 'two override.set lines; decision tier names the overridden model, then continuation',
      journal: { present: ['override.set', 'decision'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'A',
      property: 'P80',
      commands: [
        {
          kind: 'set-model',
          fields: {
            scope: 'step',
            scopeId: STEP_SAMPLE,
            model: 'claude-opus-5',
            effort: 'high',
            timing: 'safe-point',
          },
        },
      ],
      expect: {
        journal: { present: ['command.received', 'override.set', 'decision'] },
        decisions: ['tier', 'continuation'],
      },
    },
  ],
};

export const STAGE4_A: readonly StubTask[] = [SCENARIO_EDIT_MID_TASK, SET_MODEL_THEN_STEP];
