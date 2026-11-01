import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO, HELLO_FILE, HELLO_TEXT, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны S этапа 7 (слой человека). `layer-sets` — P36: одни и те же ходы модели под
 * каждым набором слоя (`layer-sets/{none,synthetic-large,hostile}`, посаженным в дом CLI стенда):
 * ходы заглушки от слоя не зависят, поэтому решения ядра о праве обязаны совпасть по наборам;
 * разница — только строки `hook-block`/`hook-loop`, названные хуком. Ход `shell` нарочно идёт
 * через Bash (враждебный набор его запрещает), `step_done` — через инструмент ядра (враждебный
 * набор его блокирует). Каталог `STUB_TASKS` подхватывает сам.
 */
export const LAYER_SETS_TASK: StubTask = {
  id: 'layer-sets',
  summary:
    'P36: same moves under none / synthetic-large / hostile user layer sets — core decisions equal, only named hook lines differ',
  adversarial: true,
  input: {
    title: 'Add hello.txt under a user layer',
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
        requirements: [{ id: REQ_1, state: 'n/a', evidence: 'commit made under the user layer' }],
        summary: `${HELLO_FILE} written and committed`,
      },
    },
    { op: 'text', text: 'Step finished.' },
  ],
  dialects: ['anthropic-messages'],
  verdicts: [
    {
      property: 'P36',
      phase: 7,
      judge: { kind: 'decision', class: 'permit' },
      expect:
        'permit decisions (tool, action, verdict) identical across the three sets; core hook fires in every set',
    },
    {
      property: 'P36',
      phase: 7,
      judge: { kind: 'signal', signal: 'hook-block' },
      expect:
        'hostile set only: each user-hook refusal is a warn hook-block naming the hook key; none and synthetic-large have none',
    },
  ],
  observer: { signals: ['hook-block'] },
  phase2: [],
};

export const STAGE7_S: readonly StubTask[] = [LAYER_SETS_TASK];
