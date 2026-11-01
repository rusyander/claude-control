import type { StubTask, TaskInput } from '../stub-tasks.types.ts';

/** Одноразовый репозиторий всех задач библиотеки: два файла, ветка `main`. */
export const BASE_REPO: TaskInput['repo'] = {
  baseBranch: 'main',
  files: {
    'README.md': '# stub repo\n\nA throwaway repository of the stub-task library.\n',
    'src/greet.txt': 'hello\n',
  },
};

export const HELLO_FILE = 'hello.txt';
/** Id требования задач библиотеки: ядро выдаёт требованиям UUIDv7 (02:54), заявка шага ссылается на него. */
export const REQ_1 = '01920000-0000-7000-8000-00000000a001';
export const HELLO_TEXT = 'hello from the stub task\n';

/**
 * Чистая задача (без подвоха): файл → коммит в копии → `step_done` с требованием «не применимо»
 * (проверок в фазе 2 нет: верификатор — фаза 3, а `step_done` не примет номер записи, которой
 * нет). Это ЕДИНСТВЕННЫЙ эффект задачи, который ядро должно довести до конца ровно один раз
 * (P10): один коммит, сколько бы раз ядро ни умерло по дороге.
 */
export const HAPPY_PATH: StubTask = {
  id: 'happy-path',
  summary: 'one work step: write a file, commit it locally, step_done accepted',
  adversarial: false,
  input: {
    title: 'Add hello.txt',
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
        requirements: [
          { id: REQ_1, state: 'n/a', evidence: 'no check registry before phase 3; commit made' },
        ],
        summary: `${HELLO_FILE} written and committed`,
      },
    },
    { op: 'text', text: 'Step finished.' },
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P08',
      phase: 2,
      judge: { kind: 'signal', signal: 'step-done-refused' },
      expect: 'step_done accepted: no record cited, the step moves running → checking',
      journal: { present: ['step.claimed'], absent: ['human.asked'] },
    },
    {
      property: 'P10',
      phase: 2,
      judge: { kind: 'repo', fact: 'commits' },
      expect: 'exactly one new commit on the copy branch, carrying hello.txt, across any core kill',
    },
    {
      property: 'P16',
      phase: 4,
      judge: { kind: 'decision', class: 'next' },
      expect: 'no reminder: step_done arrived in the first turn; next step follows the scenario',
    },
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'any' },
      expect: 'no observer signal fires — every signal here is a false positive',
    },
  ],
  observer: { signals: [] },
  phase2: [
    {
      kind: 'model-tool',
      move: 3,
      expect: {
        ok: true,
        result: { accepted: true },
        journal: { present: ['step.claimed'], absent: ['human.asked'] },
        stepState: 'checking',
      },
    },
  ],
  e2e: { commits: 1, committed: { [HELLO_FILE]: HELLO_TEXT } },
};
