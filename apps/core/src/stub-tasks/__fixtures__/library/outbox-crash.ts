import { ACTION_KINDS, type ActionKind } from '@agentdeck/contracts/core/journal';
import type { Phase2Probe, ReconcileExpect, StubTask } from '../stub-tasks.types.ts';
import { HAPPY_PATH } from './happy-path.ts';

/**
 * Крах внутри каждого действия outbox (01 §Outbox, P86 P10): ядро умирает после `action.started`
 * — до эффекта или после эффекта, но до `action.done`. При загрузке сверка читает названный факт
 * и пишет решение; повтора вслепую нет. Фаза 2 строит читателей копии (каталог) и процесса (метка
 * окружения); фаза 6 — пуша, удаления ветки, MR и ответа в нити (`ls-remote` голого репозитория и
 * заглушка форжа, `outbox-crash.forge.test.ts`). Трекер (ядро его не пишет, решение G3) и
 * контейнер (фаза 3) отвечают `unknown` → повтор до срока класса, затем точка человека 4.
 */

/** Действия, чей факт читается уже в фазе 2 (`bootstrap/action-readers.ts`). */
export const READ_IN_PHASE_2: readonly ActionKind[] = [
  'copy-create',
  'copy-remove',
  'process-start',
];

/** Действия публикации, чей факт читает форж или `ls-remote` (фаза 6, `forge-wiring/readers.ts`). */
export const READ_BY_FORGE: readonly ActionKind[] = [
  'push',
  'ref-delete',
  'mr-create',
  'mr-update',
  'thread-reply',
  'mr-comment',
];

/** Чей факт читается — решение «было / не было»; остальные — повтор, затем человек. */
export const READ_BY_FACT: readonly ActionKind[] = [...READ_IN_PHASE_2, ...READ_BY_FORGE];

const RETRY_THEN_ASK: ReconcileExpect = {
  verdict: 'retry',
  then: null,
  pastWindow: { verdict: 'ask', then: 'human.asked' },
};

const NOT_HAPPENED: ReconcileExpect = { verdict: 'not-happened', then: 'action.failed' };
const HAPPENED: ReconcileExpect = { verdict: 'happened', then: 'action.done' };

function probe(action: ActionKind, cut: 'before-effect' | 'after-effect'): Phase2Probe {
  if (!READ_BY_FACT.includes(action)) {
    return { kind: 'reconcile', action, cut, expect: RETRY_THEN_ASK };
  }
  const expect = cut === 'before-effect' ? NOT_HAPPENED : HAPPENED;
  return { kind: 'reconcile', action, cut, expect };
}

export const OUTBOX_CRASH: StubTask = {
  id: 'outbox-crash',
  summary:
    'core killed inside every outbox action, before and after the effect → reconcile by fact',
  adversarial: true,
  input: HAPPY_PATH.input,
  moves: HAPPY_PATH.moves,
  dialects: HAPPY_PATH.dialects,
  verdicts: [
    {
      property: 'P86',
      phase: 2,
      judge: { kind: 'decision', class: 'reconcile' },
      expect:
        'copy, process, push, ref-delete, MR and thread reply read their fact: before effect ' +
        'not-happened, after effect happened; container and tracker retry then ask (human ' +
        'point 4); never a blind repeat',
      journal: { present: ['action.started', 'decision'] },
    },
    {
      property: 'P10',
      phase: 2,
      judge: { kind: 'repo', fact: 'commits' },
      expect: 'killed at any journal event, the task resumes to exactly one commit',
    },
  ],
  observer: { signals: [] },
  phase2: ACTION_KINDS.flatMap((action) => [
    probe(action, 'before-effect'),
    probe(action, 'after-effect'),
  ]),
  ...(HAPPY_PATH.e2e ? { e2e: HAPPY_PATH.e2e } : {}),
};
