import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

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
 * Цикл перечитывания (F17, 06 §Observer «Waste»): один и тот же неизменный файл читается пять
 * раз подряд в одной сессии. Код фазы 2 этого не судит — предикат наблюдателя фазы 8
 * (подсказка со второго чтения). Задача хранит ровно те факты, на которых предикат обязан
 * сработать, а чистая задача — те, на которых он обязан молчать (доля ложных, P33).
 */
export const REREAD_LOOP: StubTask = {
  id: 'reread-loop',
  summary: 'the same unchanged file read five times in one session → waste hint (phase 8)',
  adversarial: true,
  input: INPUT,
  moves: [
    { op: 'read', path: '${copy}/README.md' },
    { op: 'read', path: '${copy}/README.md' },
    { op: 'read', path: '${copy}/README.md' },
    { op: 'read', path: '${copy}/README.md' },
    { op: 'read', path: '${copy}/README.md' },
    DONE,
    { op: 'text', text: 'Reported.' },
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P33',
      phase: 8,
      judge: { kind: 'signal', signal: 'waste-reread' },
      expect: 'hint at the 2nd read of the unchanged file; no stop-step; one hint per turn end',
      journal: { present: ['tool.event', 'signal'] },
    },
  ],
  observer: { signals: ['waste-reread'] },
  phase2: [],
};

/**
 * Тишина потока (F09 F17, P18): модель начала ответ и замолчала на 30 с. Сессия — `quiet`, а не
 * `failed`; порог класса инструмента решает про пробу жизни (фаза 8). Тихо ≠ упало.
 */
export const STALLED_STREAM: StubTask = {
  id: 'stalled-stream',
  summary: 'the model stalls 30 s mid-stream → session quiet, stall signal; quiet is not failed',
  adversarial: true,
  input: INPUT,
  moves: [
    { op: 'read', path: '${copy}/README.md', stallMs: 30_000 },
    DONE,
    { op: 'text', text: 'Reported.' },
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P18',
      phase: 8,
      judge: { kind: 'signal', signal: 'stall' },
      expect: 'session quiet past its threshold → liveness probe; alive → shown, never killed',
      journal: { present: ['session.transition', 'signal'], absent: ['task.ended'] },
    },
  ],
  observer: { signals: ['stall'] },
  phase2: [],
};
