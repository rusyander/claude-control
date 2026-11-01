import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны B этапа 4 (цикл дирижёра): зона кладёт сюда свои задачи с пробами
 * `phase4`, каталог `STUB_TASKS` подхватывает их сам.
 */

/**
 * Модель, которая никогда не зовёт `step_done` (P16, 02:45-47): каждый ход кончается текстом.
 * Дирижёр напоминает один раз на конец хода, не больше трёх на шаг, затем выводит исход по git и
 * записям — правок нет, значит `failed(no-outcome)`, одна свежая попытка, потом точка 6.
 */
export const NEVER_STEP_DONE: StubTask = {
  id: 'never-step-done',
  summary: 'model never calls step_done → ≤1 reminder per turn, ≤3 per step, failed(no-outcome)',
  adversarial: true,
  input: {
    title: 'Describe the change',
    request: 'Describe what you would change; do not edit files.',
    repo: BASE_REPO,
    stepKind: 'work',
    requirements: [{ id: REQ_1, text: 'the change is described' }],
  },
  moves: [
    { op: 'text', text: 'I would change the greeting.' },
    { op: 'text', text: 'Still thinking about it.' },
    { op: 'text', text: 'Nothing more to add.' },
    { op: 'text', text: 'Done talking.' },
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P16',
      phase: 4,
      judge: { kind: 'decision', class: 'next' },
      expect:
        'one step.reminded per turn end (count 1..3, distinct turnSeq), then step.ended failed no-outcome',
      journal: { present: ['step.reminded', 'step.ended'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
  phase4: [
    {
      zone: 'B',
      property: 'P16',
      expect: {
        journal: { present: ['step.reminded', 'step.ended', 'decision'], absent: ['step.claimed'] },
        decisions: ['next'],
      },
    },
  ],
};

export const STAGE4_B: readonly StubTask[] = [NEVER_STEP_DONE];
