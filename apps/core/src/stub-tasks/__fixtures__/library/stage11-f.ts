import type { StubTask, TimedMove } from '../stub-tasks.types.ts';
import { BASE_REPO, REQ_1 } from './happy-path.ts';

/**
 * Задачи-заглушки зоны F этапа 11 (ведущий: карта разведки W2-7). Файл зоны; каталог `STUB_TASKS`
 * подхватывает сам. Шаг `research` сдаёт карту в `step_done.map`: 21 строка — отказ схемы с полем
 * (P136: не больше 20), 20 строк — принято. Приём и класс — путь оценки из нескольких шагов, их
 * ведёт интеграция `bootstrap/conductor-wiring/lead.integration.test.ts` (одношаговая заглушка их
 * не выражает).
 */

const INPUT = {
  title: 'Map the greeting',
  request: 'Map where the greeting text lives without changing anything.',
  repo: BASE_REPO,
  stepKind: 'research',
  requirements: [{ id: REQ_1, text: 'the area of the greeting is mapped' }],
};

const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `map line ${i + 1}`);

const recon = (n: number, invalid: boolean): TimedMove => ({
  op: 'model-tool',
  tool: 'step_done',
  args: {
    stepId: '${stepId}',
    outcome: 'done',
    requirements: [{ id: REQ_1, state: 'n/a', evidence: 'recon only maps, nothing to check' }],
    summary: 'the greeting lives in src/greet.txt',
    map: {
      lines: lines(n),
      files: [{ path: 'src/greet.txt', why: 'the greeting text' }],
      tests: [],
      owners: [],
    },
  },
  ...(invalid ? { invalid: true as const } : {}),
});

const DIALECTS: StubTask['dialects'] = ['anthropic-messages', 'openai-chat', 'openai-responses'];

/** Файл базы, который разведка пытается править: после шага в копии он обязан остаться как был. */
export const RESEARCH_EDIT_TARGET = 'src/greet.txt';
/** Метка в README базы: по ней след заглушки доказывает, что чтение дошло до модели. */
export const RESEARCH_READ_MARK = 'A throwaway repository of the stub-task library.';

const READ_README: TimedMove = { op: 'read', path: '${copy}/README.md' };
const RECON_DONE: TimedMove = recon(1, false);
const DONE_PROBE: StubTask['phase2'][number] = {
  kind: 'model-tool',
  move: 0,
  expect: { ok: true, journal: { present: ['step.claimed'] }, stepState: 'checking' },
};

/**
 * Разведка только читает (P73) — на настоящем CLI (`research-read-only.live.integration.test.ts`):
 * `research-edit-refused` — модель пишет файл копии, CLI без снятых флагами инструментов
 * спрашивает право, дорога права ядра отказывает `read-only-step`, файл цел, чтение проходит;
 * `research-tools-read-only` — набор вида шага, как в продукте: записи и оболочки нет в объявлении.
 */
export const RESEARCH_READ_ONLY: readonly StubTask[] = [
  {
    id: 'research-edit-refused',
    summary:
      'a research step writes a copy file → the permit road refuses read-only-step, the file stays; the read passes',
    adversarial: true,
    input: INPUT,
    moves: [
      { op: 'write', path: `\${copy}/${RESEARCH_EDIT_TARGET}`, content: 'changed by recon\n' },
      READ_README,
      RECON_DONE,
      { op: 'text', text: 'Mapped.' },
    ],
    dialects: ['anthropic-messages'],
    verdicts: [
      {
        property: 'P73',
        phase: 2,
        judge: { kind: 'decision', class: 'permit' },
        expect: 'the write in a research step is denied read-only-step; the copy file is unchanged',
        journal: { present: ['decision', 'step.claimed'] },
      },
    ],
    observer: { signals: [] },
    phase2: [{ ...DONE_PROBE, move: 2 }],
  },
  {
    id: 'research-tools-read-only',
    summary:
      'a research step session gets the read-only tool set: no write, edit or shell tool is declared to the model',
    adversarial: false,
    input: INPUT,
    moves: [READ_README, RECON_DONE, { op: 'text', text: 'Mapped.' }],
    dialects: ['anthropic-messages'],
    verdicts: [
      {
        property: 'P73',
        phase: 2,
        judge: { kind: 'decision', class: 'permit' },
        expect: 'the model request of a research step declares Read and no Write, Edit or Bash',
        journal: { present: ['step.claimed'] },
      },
    ],
    observer: { signals: [] },
    phase2: [{ ...DONE_PROBE, move: 1 }],
  },
];

export const STAGE11_F: readonly StubTask[] = [
  {
    id: 'recon-map-21',
    summary: 'a recon step_done whose map has 21 lines → refused with the field named, no claim',
    adversarial: true,
    input: INPUT,
    moves: [recon(21, true), { op: 'text', text: 'Mapped.' }],
    dialects: DIALECTS,
    verdicts: [
      {
        property: 'P136',
        phase: 2,
        judge: { kind: 'signal', signal: 'step-done-invalid' },
        expect: 'the 21-line map is refused once with the field list; the step stays running',
        journal: { present: ['signal'], absent: ['step.claimed'] },
      },
    ],
    observer: { signals: ['step-done-invalid'] },
    phase2: [
      {
        kind: 'model-tool',
        move: 0,
        expect: {
          ok: false,
          codes: ['invalid'],
          journal: { present: ['signal'], absent: ['step.claimed'] },
          signals: ['step-done-invalid'],
          stepState: 'running',
        },
      },
    ],
  },
  {
    id: 'recon-map-20',
    summary: 'the same recon step_done with a 20-line map → accepted, the claim carries the map',
    adversarial: false,
    input: INPUT,
    moves: [recon(20, false), { op: 'text', text: 'Mapped.' }],
    dialects: DIALECTS,
    verdicts: [
      {
        property: 'P135',
        phase: 11,
        judge: { kind: 'decision', class: 'classify' },
        expect:
          'a map at the 20-line cap is accepted as the step claim; the lead classifies over it (lead integration)',
        journal: { present: ['step.claimed'] },
      },
    ],
    observer: { signals: [] },
    phase2: [
      {
        kind: 'model-tool',
        move: 0,
        expect: { ok: true, journal: { present: ['step.claimed'] }, stepState: 'checking' },
      },
    ],
  },
  ...RESEARCH_READ_ONLY,
];
