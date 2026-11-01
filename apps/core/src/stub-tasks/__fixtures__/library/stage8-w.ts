import type { StubTask, TaskInput, TimedMove } from '../stub-tasks.types.ts';
import { PUBLISH_DENY } from './forged.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны W этапа 8 (наблюдатель: расточительство — перечитывание, большое чтение,
 * повтор падающей команды, опрос, повтор отказа). Каждая состязательная задача несёт ровно те
 * факты, на которых предикат обязан сработать; её почти-двойник (`observer.signals: []`) — те, на
 * которых обязан молчать (доля ложных, P33). Файл зоны; каталог `STUB_TASKS` подхватывает сам.
 */

/** 64 строки по 1 КиБ: больше порога 30 КиБ, но в окне чтения CLI по умолчанию (2000 строк). */
const BIG_README = `${'# big readme\n'}${`${'x'.repeat(1023)}\n`.repeat(64)}`;

const REPO: TaskInput['repo'] = {
  ...BASE_REPO,
  files: {
    ...BASE_REPO.files,
    'docs/BIG.md': BIG_README,
    // Настоящий CLI исполняет команду сам: код выхода тот же, что сообщает подделка.
    'fail.js': 'process.exitCode = 3;\n',
  },
};

const INPUT: TaskInput = {
  title: 'Summarise the docs',
  request: 'Read the docs of the repository and report what it is for.',
  repo: REPO,
  stepKind: 'work',
  requirements: [{ id: REQ_1, text: 'purpose of the repository reported' }],
};

const DIALECTS: StubTask['dialects'] = ['anthropic-messages', 'openai-chat', 'openai-responses'];

const DONE: TimedMove = {
  op: 'model-tool',
  tool: 'step_done',
  args: {
    stepId: '${stepId}',
    outcome: 'done',
    requirements: [{ id: REQ_1, state: 'n/a', evidence: 'report-only step, nothing to check' }],
    summary: 'docs read; the repository is a throwaway stub repo',
  },
};

const END: TimedMove[] = [DONE, { op: 'text', text: 'Reported.' }];

function waste(
  id: string,
  summary: string,
  moves: TimedMove[],
  signal: string,
  expect: string,
  fires: boolean,
  phase2: StubTask['phase2'] = [],
  dialects: StubTask['dialects'] = DIALECTS,
): StubTask {
  return {
    id,
    summary,
    adversarial: fires,
    input: INPUT,
    moves: [...moves, ...END],
    dialects,
    verdicts: [
      {
        property: 'P33',
        phase: 8,
        judge: { kind: 'signal', signal },
        expect,
        journal: fires ? { present: ['tool.event', 'signal'] } : { present: ['tool.event'] },
      },
    ],
    observer: { signals: fires ? [signal] : [] },
    phase2,
  };
}

const BIG = '${copy}/docs/BIG.md';
const FAIL: TimedMove = { op: 'shell', argv: ['node', 'fail.js'], exit: 3 };
const SLEEP: TimedMove = { op: 'shell', argv: ['sleep', '2'] };
const PUSH: TimedMove = { op: 'shell', argv: ['git', 'push', 'origin', 'HEAD'] };
const refusedPush = (move: number) => ({
  kind: 'permit' as const,
  move,
  denyCommands: PUBLISH_DENY,
  expect: { allow: false, code: 'platform-step' },
});

export const STAGE8_W: readonly StubTask[] = [
  // Только Claude: Qwen `read_file` без окна режет файл сам (~25 KB, проба M) — это окно CLI,
  // большим чтением оно не бывает; его молчание — почти-двойник ниже.
  waste(
    'waste-big-read',
    'a 64 KiB file read whole → waste-big-read hint (phase 8)',
    [{ op: 'read', path: BIG }],
    'waste-big-read',
    'hint on the whole read of a file over 30 KiB; never a stop-step',
    true,
    [],
    ['anthropic-messages'],
  ),
  waste(
    'waste-big-read-cli-window',
    'qwen reads the 64 KiB file with no window; qwen cuts it to its own window → no waste signal',
    [{ op: 'read', path: BIG }],
    'waste-big-read',
    'a read the CLI cuts by size is not a whole read and stays silent',
    false,
    [],
    ['openai-chat'],
  ),
  waste(
    'waste-big-read-ranged',
    'the same 64 KiB file read through a line window → no waste signal',
    [{ op: 'read', path: BIG, range: { offset: 1, limit: 20 } }],
    'waste-big-read',
    'a windowed read of a big file is silent',
    false,
  ),
  waste(
    'waste-reread-after-edit',
    'a file read, edited, read again → no reread signal (new fingerprint)',
    [
      { op: 'read', path: '${copy}/src/greet.txt' },
      { op: 'write', path: '${copy}/src/greet.txt', content: 'hello again\n' },
      { op: 'read', path: '${copy}/src/greet.txt' },
    ],
    'waste-reread',
    'the read after an edit sees a new fingerprint and is silent',
    false,
  ),
  waste(
    'waste-fail-repeat',
    'node fail.js exits 3 three times with no edit → hint, then stop-step (phase 8)',
    [FAIL, FAIL, FAIL],
    'waste-fail-repeat',
    'hint at the 2nd identical failure (exit 3), stop-step at the 3rd',
    true,
  ),
  waste(
    'waste-fail-different',
    'two different failing commands → no fail-repeat signal',
    [FAIL, { op: 'shell', argv: ['node', 'missing.js'], exit: 1 }],
    'waste-fail-repeat',
    'different argv and exit code are different failures, silent',
    false,
  ),
  waste(
    'waste-poll',
    'sleep four times in a row in one turn → hint, then stop-step (phase 8)',
    // Без метки `turnEnd`: `dialects.test.ts` ещё гонит ходы мимо `moveAt` (запрос родителю).
    [SLEEP, SLEEP, SLEEP, SLEEP],
    'waste-poll',
    'hint at the 2nd wait; stop-step at the 4th wait in a row',
    true,
  ),
  waste(
    'waste-poll-then-work',
    'one sleep, then a read → no poll signal',
    [SLEEP, { op: 'read', path: '${copy}/README.md' }],
    'waste-poll',
    'a single wait followed by work is silent',
    false,
  ),
  waste(
    'waste-refusal-repeat',
    'git push refused twice in one step → stop-step (phase 8)',
    [PUSH, PUSH],
    'waste-refusal-repeat',
    'the 2nd platform-step refusal of the same target in the step stops it',
    true,
    [refusedPush(0), refusedPush(1)],
  ),
  waste(
    'waste-refusal-different',
    'two different refusals (push, then a git-internals edit) → no refusal-repeat signal',
    [PUSH, { op: 'write', path: '${copy}/.git/config', content: '[core]\n' }],
    'waste-refusal-repeat',
    'refusals with another action, target and code are silent',
    false,
    [refusedPush(0)],
  ),
];
