import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO, HELLO_FILE, HELLO_TEXT, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны L этапа 7 (слой человека). `layer-modes` — P87: одни и те же ходы модели
 * под режимами хуков `on` / `observe` / `off` с набором `synthetic-large` в доме CLI стенда.
 * Матрица: `on` — хуки человека исполняет сам CLI; `observe` — их исполняет запись ядра (отметки
 * на диске есть, вердикт CLI не получает, сводка `layer.observed`); `off` — хуков человека нет
 * вовсе; хук ядра сработал в каждом режиме. Каталог `STUB_TASKS` подхватывает сам.
 */
export const LAYER_MODES_TASK: StubTask = {
  id: 'layer-modes',
  summary:
    'P87: on / observe / off — user hooks run by the CLI / by the core recorder (allow, verdict journaled) / not at all; core hook fires in each',
  input: {
    title: 'Add hello.txt under each user-hook mode',
    request: `Create ${HELLO_FILE} with a greeting and commit it on the current branch.`,
    repo: BASE_REPO,
    stepKind: 'work',
    requirements: [{ id: REQ_1, text: `${HELLO_FILE} exists with a greeting, committed` }],
  },
  moves: [
    { op: 'write', path: `\${copy}/${HELLO_FILE}`, content: HELLO_TEXT },
    { op: 'shell', argv: ['git', 'add', HELLO_FILE] },
    { op: 'shell', argv: ['git', 'commit', '-m', 'add-hello'] },
    {
      op: 'model-tool',
      tool: 'step_done',
      args: {
        stepId: '${stepId}',
        outcome: 'done',
        requirements: [{ id: REQ_1, state: 'n/a', evidence: 'commit made under the hook mode' }],
        summary: `${HELLO_FILE} written and committed`,
      },
    },
    { op: 'text', text: 'Step finished.' },
  ],
  dialects: ['anthropic-messages'],
  verdicts: [
    {
      property: 'P87',
      phase: 7,
      judge: { kind: 'decision', class: 'layer-run' },
      expect:
        'one layer-run decision per session: ran.hooks = the asked mode (trusted source), inventory hash set',
    },
    {
      property: 'P87',
      phase: 7,
      judge: { kind: 'decision', class: 'permit' },
      expect: 'core hook decisions (road hook) present in on, observe and off alike',
    },
  ],
  adversarial: false,
  observer: { signals: [] },
  phase2: [],
};

export const STAGE7_L: readonly StubTask[] = [LAYER_MODES_TASK];
