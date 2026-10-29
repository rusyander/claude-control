import { ACTION_KINDS, type ActionKind } from '@agentdeck/contracts/core/journal';
import type { Phase2Probe, ReconcileExpect, StubTask } from '../stub-tasks.types.ts';
import { HAPPY_PATH } from './happy-path.ts';

/**
 * Крах внутри каждого действия outbox (01 §Outbox, P86 P10): ядро умирает после `action.started`
 * — до эффекта или после эффекта, но до `action.done`. При загрузке сверка читает названный факт
 * и пишет решение; повтора вслепую нет. Фаза 2 строит читателей копии (каталог) и процесса (метка
 * окружения); пуш, MR, ответ, трекер (фаза 6) и контейнер (фаза 3) отвечают `unknown` → повтор
 * до срока класса, затем точка человека 4. Срез «после эффекта» для них даёт то же: факт не
 * читается, и это честно, а не «нет».
 */

/** Действия, чей факт читается уже в фазе 2 (`bootstrap/action-readers.ts`). */
export const READ_IN_PHASE_2: readonly ActionKind[] = [
  'copy-create',
  'copy-remove',
  'process-start',
];

const RETRY_THEN_ASK: ReconcileExpect = {
  verdict: 'retry',
  then: null,
  pastWindow: { verdict: 'ask', then: 'human.asked' },
};

const NOT_HAPPENED: ReconcileExpect = { verdict: 'not-happened', then: 'action.failed' };
const HAPPENED: ReconcileExpect = { verdict: 'happened', then: 'action.done' };

function probe(action: ActionKind, cut: 'before-effect' | 'after-effect'): Phase2Probe {
  if (!READ_IN_PHASE_2.includes(action)) {
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
        'copy and process read their fact: before effect not-happened, after effect happened; ' +
        'phase-3/6 kinds retry then ask (human point 4); never a blind repeat',
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
