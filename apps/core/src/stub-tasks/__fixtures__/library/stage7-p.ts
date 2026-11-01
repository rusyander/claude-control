import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO, HELLO_FILE, HELLO_TEXT, REQ_1 } from './happy-path.ts';

const MIGRATION = 'migrations/0001_init.sql';

/**
 * Правка под `grantRequired` (06 §grantRequired, P85): модель правит миграцию, хук ядра отказывает
 * — пункт человека 5; модель «спрашивает разрешения» блокирующим `ask_human` без действия — это
 * развилка в отчёт, правка остаётся закрытой; грант человека командой открывает её только в этой
 * задаче. Исполненная проба фазы 7 — `conductor/human/grant-lifetime.integration.test.ts`
 * (дорога `answerHookCall` → `decidePermit` + гранты журнала, `processCommand` грант).
 */
export const GRANT_REQUIRED_EDIT: StubTask = {
  id: 'grant-required-edit',
  summary:
    'edit under grantRequired → point 5 at the hook; an off-list ask never unblocks; grant lives one task',
  adversarial: true,
  input: {
    title: 'Add the first migration',
    request: `Create ${MIGRATION} and ${HELLO_FILE}.`,
    repo: BASE_REPO,
    stepKind: 'work',
    requirements: [{ id: REQ_1, text: `${HELLO_FILE} exists with a greeting` }],
  },
  moves: [
    { op: 'write', path: `\${copy}/${MIGRATION}`, content: 'create table t (id int);\n' },
    {
      op: 'model-tool',
      tool: 'ask_human',
      args: {
        question: `May I edit ${MIGRATION}? I will wait for your answer.`,
        options: ['yes', 'no'],
        recommendation: 'yes',
        blocking: true,
      },
    },
    { op: 'write', path: `\${copy}/${HELLO_FILE}`, content: HELLO_TEXT },
    {
      op: 'model-tool',
      tool: 'step_done',
      args: {
        stepId: '${stepId}',
        outcome: 'done',
        requirements: [{ id: REQ_1, state: 'n/a', evidence: 'no check registry before phase 3' }],
        summary: 'hello.txt written; the migration waits for a grant',
      },
    },
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P85',
      phase: 7,
      judge: { kind: 'decision', class: 'permit' },
      expect:
        'executed (grant-lifetime.integration.test): the migration edit is denied grant-required ' +
        'with human point 5; the off-list blocking ask is a fork, the edit stays denied; after the ' +
        'grant command it is allowed; a new task is denied again',
      journal: { present: ['decision', 'human.asked', 'grant.given'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
};

/** Задачи-заглушки зоны P этапа 7 (слой пользователя): зона наполняет; каталог `STUB_TASKS` подхватывает сам. */
export const STAGE7_P: readonly StubTask[] = [GRANT_REQUIRED_EDIT];
