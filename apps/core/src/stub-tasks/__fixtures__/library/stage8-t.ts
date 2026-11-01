import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны T этапа 8 (наблюдатель: тишина и остановка сессии, проба жизни, парковка).
 * Файл зоны; каталог `STUB_TASKS` подхватывает сам. Срабатывающая пара — `STALLED_STREAM`
 * (`waste.ts`, модель молчит 30 с); здесь её почти-двойник, на котором `stall` обязан молчать.
 */

const INPUT = {
  title: 'Summarise README',
  request: 'Read README.md and report what the repository is for.',
  repo: BASE_REPO,
  stepKind: 'work',
  requirements: [{ id: REQ_1, text: 'purpose of the repository reported' }],
};

const DONE = {
  op: 'model-tool',
  tool: 'step_done',
  args: {
    stepId: '${stepId}',
    outcome: 'done',
    requirements: [{ id: REQ_1, state: 'n/a', evidence: 'report-only step, nothing to check' }],
    summary: 'README read; the repository is a throwaway stub repo',
  },
} as const;

/**
 * Короткая пауза модели (F9, P18, почти-двойник `STALLED_STREAM`): тот же ход, но молчание 1 с —
 * ниже любого порога тишины (пол выученного 2 мин; прогон библиотеки ставит пороги ниже 30 с, но
 * выше секунды). Пробы жизни нет, сигнала `stall` нет: пауза — не застой (F13: ложное = дефект).
 */
export const STALL_SHORT_PAUSE: StubTask = {
  id: 'stall-short-pause',
  summary: 'the model pauses 1 s mid-stream → below every stall threshold: no probe, no stall',
  adversarial: false,
  input: INPUT,
  moves: [
    { op: 'read', path: '${copy}/README.md', stallMs: 1_000 },
    DONE,
    { op: 'text', text: 'Reported.' },
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P18',
      phase: 8,
      judge: { kind: 'signal', signal: 'stall' },
      expect: 'a pause below the stall threshold: no liveness probe, stall stays silent',
      journal: { absent: ['session.probe'] },
    },
  ],
  observer: { signals: [] },
  phase2: [],
};

export const STAGE8_T: readonly StubTask[] = [STALL_SHORT_PAUSE];
