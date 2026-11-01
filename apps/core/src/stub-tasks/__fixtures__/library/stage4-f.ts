import type { StubTask, TimedMove } from '../stub-tasks.types.ts';
import { REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны F этапа 4 (обвязка шага): пробы `phase4` — что дирижёр обязан показать на
 * настоящем цикле. Каталог `STUB_TASKS` подхватывает их сам; тест библиотеки сверяет пробы с
 * контрактами (вид строки, класс решения) уже сейчас. Сами свойства на настоящем репозитории,
 * копии и проверяющем доказывает `bootstrap/conductor-wiring/wiring.integration.test.ts`; здесь —
 * то, что обязан увидеть сквозной прогон волны 2.
 */

const DIALECTS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const;

/** Репозиторий с багом и реестром проверок: раннер vitest, проверка `tests`. */
const BUGGY_REPO: StubTask['input']['repo'] = {
  baseBranch: 'main',
  files: {
    'package.json': '{"name":"p","version":"1.0.0","type":"module"}\n',
    'src/add.mjs': 'export const add = (a, b) => a - b;\n',
    '.agentdeck/checks.json': `${JSON.stringify({
      v: 1,
      checks: [
        {
          id: 'tests',
          class: 'test-runner',
          argv: ['npx', 'vitest', 'run', '{files}'],
          requiredAt: ['publish', 'deliver'],
          filter: { kind: 'vitest', argv: ['npx', 'vitest', 'run', '{files}', '-t', '{tests}'] },
        },
      ],
    })}\n`,
  },
};

const FIXED = 'export const add = (a, b) => a + b;\n';
const REGRESSION =
  "import { describe, it, expect } from 'vitest';\nimport { add } from '../src/add.mjs';\ndescribe('add', () => {\n  it('sums', () => expect(add(2, 3)).toBe(5));\n});\n";

const fixAndFinish = (summary: string): TimedMove[] => [
  { op: 'write', path: '${copy}/src/add.mjs', content: FIXED },
  { op: 'write', path: '${copy}/test/add.test.mjs', content: REGRESSION },
  {
    op: 'model-tool',
    tool: 'step_done',
    args: {
      stepId: '${stepId}',
      outcome: 'done',
      // Заявление `covered` несёт id записей проверок — их знает только прогон; заглушка молчит.
      requirements: [],
      summary,
    },
  },
  { op: 'text', text: 'Fix done.' },
];

/**
 * P94: шаг работы над багом с регрессией `tests` и воротами «красный до» — тест фикса падает на
 * закреплённой базе (без фикса) и проходит на копии; доказательство — факт шага `redBefore`, шаг
 * засчитан. Копия единицы легла при старте, установка — по первому шагу, что правит копию.
 */
export const BUG_FIX_RED_BEFORE: StubTask = {
  id: 'stage4-bug-fix-red-before',
  summary:
    'bug-fix work step: the regression test fails on the pinned base and passes on the copy (red-before proven)',
  adversarial: false,
  input: {
    title: 'Fix add()',
    request: 'add(2, 3) returns -1; make it return 5 and cover it with a test.',
    repo: BUGGY_REPO,
    stepKind: 'work',
    requirements: [{ id: REQ_1, text: 'add(2, 3) returns 5 and a test proves it' }],
  },
  moves: fixAndFinish('add fixed, regression test added'),
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P94',
      phase: 4,
      judge: { kind: 'decision', class: 'red-before' },
      expect:
        'resource.created copy at unit start, decision copy-setup, decision red-before reasons [proven, "add > sums: proven"], step.ended with facts.redBefore proven=true, final decision compose ready',
      journal: { present: ['resource.created', 'decision', 'step.ended'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'F',
      property: 'P94',
      expect: {
        journal: {
          present: ['resource.created', 'decision', 'step.started', 'step.ended', 'check.recorded'],
        },
        decisions: ['copy-setup', 'red-before', 'compose'],
      },
    },
  ],
};

/**
 * P101 (половина ранних прогонов): шаг только чтения после сданной работы запускает проверки итога
 * в фоне один раз; финальная проверка их переигрывает — `compose` с ran=0, ничего не гоняет заново.
 */
export const PRE_RUN_REPLAY: StubTask = {
  id: 'stage4-pre-run-replay',
  summary:
    'a read-only step after done work pre-runs the final checks once; the final gate replays them (compose ran=0)',
  adversarial: false,
  input: {
    title: 'Fix add() and review it',
    request: 'Fix add(), then review the change.',
    repo: BUGGY_REPO,
    stepKind: 'review',
    requirements: [{ id: REQ_1, text: 'add(2, 3) returns 5' }],
  },
  moves: [
    {
      op: 'model-tool',
      tool: 'step_done',
      args: {
        stepId: '${stepId}',
        outcome: 'done',
        requirements: [],
        summary: 'change reviewed',
      },
    },
    { op: 'text', text: 'Review done.' },
  ],
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P101',
      phase: 4,
      judge: { kind: 'decision', class: 'compose' },
      expect:
        'check.recorded of the final checks before the final gate, one decision compose reasons=[ready] numbers.ran=0',
      journal: { present: ['check.requested', 'check.recorded', 'decision'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'F',
      property: 'P101',
      expect: {
        journal: { present: ['check.requested', 'check.recorded', 'decision'] },
        decisions: ['compose'],
      },
    },
  ],
};

/**
 * P101 (половина диска): свободного места ниже порога — новой копии нет, единица стоит с кодом
 * `disk-low`; строки `resource.created` копии в журнале нет.
 */
export const DISK_LOW_NO_COPY: StubTask = {
  id: 'stage4-disk-low-no-copy',
  summary: 'free disk below the threshold: no new copy is laid out, the unit stops with disk-low',
  adversarial: true,
  input: {
    title: 'Fix add() on a full disk',
    request: 'Fix add().',
    repo: BUGGY_REPO,
    stepKind: 'work',
    requirements: [{ id: REQ_1, text: 'add(2, 3) returns 5' }],
  },
  moves: fixAndFinish('never reached: the unit stops before the copy'),
  dialects: [...DIALECTS],
  verdicts: [
    {
      property: 'P101',
      phase: 4,
      judge: { kind: 'repo', fact: 'commits' },
      expect: 'unit stopped with disk-low, no resource.created copy, no commits on any copy branch',
      journal: { absent: ['resource.created', 'step.started'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'F',
      property: 'P101',
      expect: { journal: { present: ['unit.transition'], absent: ['resource.created'] } },
    },
  ],
};

export const STAGE4_F: readonly StubTask[] = [BUG_FIX_RED_BEFORE, PRE_RUN_REPLAY, DISK_LOW_NO_COPY];
