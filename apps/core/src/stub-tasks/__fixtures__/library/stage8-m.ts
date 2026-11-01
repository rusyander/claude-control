import type { StubTask, TaskInput, TimedMove } from '../stub-tasks.types.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны M этапа 8 (наблюдатель: самопроверка каталога сигналов — каждый сигнал
 * срабатывает на своей задаче и молчит на чистой). Здесь — пары на факты переходников этапа 8:
 * окно чтения (`range` в каноне ядра — номер строки с единицы у обоих CLI) и исход вызова
 * (`outcome.errorText` без структурного кода выхода, F18). Почти-двойники (`observer.signals: []`)
 * — то, что делает замер ложных способным покраснеть. Файл зоны; каталог `STUB_TASKS` подхватывает сам.
 */

/** 100 коротких строк: два соседних окна по 20 строк — разные части одного файла. */
const LINES = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

const REPO: TaskInput['repo'] = {
  ...BASE_REPO,
  files: {
    ...BASE_REPO.files,
    'docs/LINES.md': `${LINES}\n`,
    // Настоящий CLI исполняет команду сам: коды выхода те же, что сообщает подделка.
    'fail.js': 'process.exitCode = 3;\n',
    // Первый запуск — 3, каждый следующий — 1 (метка `.ran` в копии).
    'flaky.js':
      "const fs = require('fs');\nprocess.exitCode = fs.existsSync('.ran') ? 1 : 3;\nfs.writeFileSync('.ran', '');\n",
    'ok.js': 'process.exitCode = 0;\n',
  },
};

const INPUT: TaskInput = {
  title: 'Summarise the docs',
  request: 'Read the docs of the repository and report what it is for.',
  repo: REPO,
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
    summary: 'docs read; the repository is a throwaway stub repo',
  },
};

function pair(
  id: string,
  summary: string,
  moves: TimedMove[],
  signal: string,
  expect: string,
  fires: boolean,
): StubTask {
  return {
    id,
    summary,
    adversarial: fires,
    input: INPUT,
    moves: [...moves, DONE, { op: 'text', text: 'Reported.' }],
    dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
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
    phase2: [],
  };
}

const DOC = '${copy}/docs/LINES.md';
const FAIL: TimedMove = { op: 'shell', argv: ['node', 'fail.js'], exit: 3 };
const SLEEP: TimedMove = { op: 'shell', argv: ['sleep', '2'] };

export const STAGE8_M: readonly StubTask[] = [
  pair(
    'm-reread-same-window',
    'the same 20-line window of an unchanged file read twice → waste-reread hint on both CLIs (phase 8)',
    [
      { op: 'read', path: DOC, range: { offset: 1, limit: 20 } },
      { op: 'read', path: DOC, range: { offset: 1, limit: 20 } },
    ],
    'waste-reread',
    'hint at the 2nd read of the same window; the window is known on Claude and Qwen alike',
    true,
  ),
  pair(
    'm-reread-adjacent-windows',
    'two adjacent 20-line windows of one file → no reread signal (different parts of the file)',
    [
      { op: 'read', path: DOC, range: { offset: 1, limit: 20 } },
      { op: 'read', path: DOC, range: { offset: 21, limit: 20 } },
    ],
    'waste-reread',
    'adjacent windows are different reads, silent',
    false,
  ),
  pair(
    'm-fail-repeat-edit-between',
    'node fail.js fails, the script is edited, it fails again → no fail-repeat signal (edit between)',
    [
      FAIL,
      { op: 'write', path: '${copy}/fail.js', content: 'process.exitCode = 3; // retry\n' },
      FAIL,
    ],
    'waste-fail-repeat',
    'an edit between two identical failures resets the count, silent',
    false,
  ),
  pair(
    'm-fail-repeat-other-exit',
    'the same command fails with exit 3, then with exit 1 → no fail-repeat signal (another failure)',
    [
      { op: 'shell', argv: ['node', 'flaky.js'], exit: 3 },
      { op: 'shell', argv: ['node', 'flaky.js'], exit: 1 },
    ],
    'waste-fail-repeat',
    'same argv with another exit code (CLI error text) is another failure, silent',
    false,
  ),
  pair(
    'm-success-repeat',
    'node ok.js succeeds three times → no fail-repeat signal (no failure)',
    [
      { op: 'shell', argv: ['node', 'ok.js'] },
      { op: 'shell', argv: ['node', 'ok.js'] },
      { op: 'shell', argv: ['node', 'ok.js'] },
    ],
    'waste-fail-repeat',
    'repeated successes are not failures, silent',
    false,
  ),
  pair(
    'm-poll-split-by-work',
    'sleep, a read, sleep → no poll signal (the waits are not consecutive)',
    [SLEEP, { op: 'read', path: '${copy}/README.md' }, SLEEP],
    'waste-poll',
    'two waits with work between them are not a poll loop, silent',
    false,
  ),
];
