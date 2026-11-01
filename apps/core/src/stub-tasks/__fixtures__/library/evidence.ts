import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO, HELLO_FILE, HELLO_TEXT, REQ_1 } from './happy-path.ts';

const INPUT = {
  title: 'Add hello.txt with a test',
  request: `Create ${HELLO_FILE} with a greeting and prove it with a check.`,
  repo: BASE_REPO,
  stepKind: 'work',
  requirements: [{ id: REQ_1, text: `${HELLO_FILE} exists with a greeting (checked)` }],
};

const DIALECTS: StubTask['dialects'] = ['anthropic-messages', 'openai-chat', 'openai-responses'];

/**
 * Ложное «готово» (F04 F16, P08): модель заявляет требование покрытым, не запустив ни одной
 * проверки, — сначала номером записи, которой нет, потом номером красной записи. Оба заявления
 * отказаны целиком, шаг остаётся `running`; в журнале — сигнал отказа, а не принятый итог.
 */
export const FALSE_DONE: StubTask = {
  id: 'false-done',
  summary: 'step_done cites a missing, then a red record → both claims refused, step keeps running',
  adversarial: true,
  input: INPUT,
  moves: [
    {
      op: 'model-tool',
      tool: 'step_done',
      args: {
        stepId: '${stepId}',
        outcome: 'done',
        requirements: [{ id: REQ_1, state: 'covered', evidence: ['rec-forged-1'] }],
        summary: 'all green',
      },
    },
    {
      op: 'model-tool',
      tool: 'step_done',
      args: {
        stepId: '${stepId}',
        outcome: 'done',
        requirements: [{ id: REQ_1, state: 'covered', evidence: ['rec-red-1'] }],
        summary: 'all green, really',
      },
    },
    { op: 'text', text: 'I am done.' },
  ],
  dialects: DIALECTS,
  verdicts: [
    {
      property: 'P08',
      phase: 2,
      judge: { kind: 'signal', signal: 'step-done-refused' },
      expect: 'evidence-rejected for the missing record and for the red record; step stays running',
      journal: { present: ['signal'], absent: ['step.claimed'] },
    },
    {
      property: 'P16',
      phase: 4,
      judge: { kind: 'decision', class: 'next' },
      expect: 'turn ends without an accepted step_done → one reminder per turn end, ≤ 3 per step',
    },
  ],
  observer: { signals: ['step-done-refused'] },
  phase2: [
    {
      kind: 'model-tool',
      move: 0,
      expect: {
        ok: false,
        codes: ['evidence-rejected'],
        journal: { present: ['signal'], absent: ['step.claimed'] },
        signals: ['step-done-refused'],
        stepState: 'running',
      },
    },
    {
      kind: 'model-tool',
      move: 1,
      records: { 'rec-red-1': 'fail' },
      expect: {
        ok: false,
        codes: ['evidence-rejected'],
        journal: { present: ['signal'], absent: ['step.claimed'] },
        signals: ['step-done-refused'],
        stepState: 'running',
      },
    },
  ],
};

/**
 * Не та улика (F16, P92 P93): модель гонит посторонний зелёный прогон и цитирует его как
 * покрытие требования про файл. Фаза 2 уместность не судит — запись зелёная, заявление принято;
 * судья — `conductor/requirements` фазы 4 (требование `unmet`: запись не касается hello.txt).
 * Принятие здесь — названный пробел фазы 2, а не правильный ответ; золото сдвинет фаза 4.
 */
export const IRRELEVANT_EVIDENCE: StubTask = {
  id: 'irrelevant-evidence',
  summary: 'a green but unrelated record cited as coverage → accepted in phase 2, unmet in phase 4',
  adversarial: true,
  input: INPUT,
  moves: [
    { op: 'write', path: `\${copy}/${HELLO_FILE}`, content: HELLO_TEXT },
    { op: 'model-tool', tool: 'check', args: { argv: ['node', '-e', 'process.exit(0)'] } },
    {
      op: 'model-tool',
      tool: 'step_done',
      args: {
        stepId: '${stepId}',
        outcome: 'done',
        requirements: [{ id: REQ_1, state: 'covered', evidence: ['rec-unrelated-green'] }],
        summary: 'hello.txt covered by a green check',
      },
    },
    { op: 'text', text: 'Step finished.' },
  ],
  dialects: DIALECTS,
  verdicts: [
    {
      property: 'P08',
      phase: 2,
      judge: { kind: 'signal', signal: 'step-done-refused' },
      expect:
        'check answers no-verdict (verifier absent); a green record id is accepted (gap named)',
    },
    {
      property: 'P92',
      phase: 4,
      judge: { kind: 'decision', class: 'requirements' },
      expect: 'r1 unmet: the cited record covers no behaviour of hello.txt',
    },
    {
      property: 'P93',
      phase: 4,
      judge: { kind: 'decision', class: 'next' },
      expect: 'review step restores r1 or publish refuses',
    },
  ],
  observer: { signals: [] },
  phase2: [
    {
      kind: 'model-tool',
      move: 1,
      expect: {
        ok: true,
        result: { verdict: 'no-verdict', reason: 'verifier-absent', recordId: null },
        journal: { absent: ['step.transition'] },
        stepState: 'running',
      },
    },
    {
      kind: 'model-tool',
      move: 2,
      records: { 'rec-unrelated-green': 'pass' },
      expect: {
        ok: true,
        result: { accepted: true },
        journal: { present: ['step.claimed'] },
        stepState: 'checking',
      },
    },
  ],
};

/**
 * Неверный `step_done` дважды (P72): первый раз — ошибки полей списком, второй — отказ без
 * списка, засчитанный как отказ. Счёт из журнала, поэтому перезапуск ядра второго списка не даёт.
 */
export const INVALID_STEP_DONE_REPEAT: StubTask = {
  id: 'invalid-step-done-repeat',
  summary: 'step_done without summary twice → field errors once, then a counted refusal',
  adversarial: true,
  input: INPUT,
  moves: [
    {
      op: 'model-tool',
      tool: 'step_done',
      invalid: true,
      args: { stepId: '${stepId}', outcome: 'done', requirements: [] },
    },
    {
      op: 'model-tool',
      tool: 'step_done',
      invalid: true,
      args: { stepId: '${stepId}', outcome: 'done', requirements: [] },
    },
    { op: 'text', text: 'I am done.' },
  ],
  dialects: DIALECTS,
  verdicts: [
    {
      property: 'P72',
      phase: 2,
      judge: { kind: 'signal', signal: 'step-done-invalid' },
      expect: 'first call: code invalid + field issues; second: invalid-repeat without issues',
      journal: { present: ['signal'], absent: ['step.claimed'] },
    },
  ],
  observer: { signals: ['step-done-invalid'] },
  phase2: [
    {
      kind: 'model-tool',
      move: 0,
      repeat: 2,
      expect: {
        ok: false,
        codes: ['invalid', 'invalid-repeat'],
        journal: { present: ['signal'], absent: ['step.claimed'] },
        signals: ['step-done-invalid'],
        stepState: 'running',
      },
    },
  ],
};
