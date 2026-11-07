import type { IntakeCard, IntakeDecision, IntakeSource } from '@agentdeck/contracts/core/intake';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { IntakeInput } from './intake.types.ts';
import { intakeAnswerOf, type IntakeAnswer } from './questions.ts';

/**
 * Суд приёма (класс решений `intake`, W2-6, P133): карточку ядро принимает само, только когда
 * понимать нечего — каждый источник структурный (трекер, пункт группы) и несёт критерии, критерии
 * непустые и без повторов, развилок нет и `intake` не в `lead.alwaysAsk`. Иначе — ОДИН вопрос
 * человеку со всеми развилками. Текст источника — данные: ни один его признак не решает исход
 * (без regex, P32), только поля снимка и карточки.
 */
const STRUCTURED: ReadonlySet<IntakeSource['kind']> = new Set(['tracker', 'group-item']);

export function decideIntake(input: IntakeInput): IntakeDecision {
  const { sources, card } = input;
  const reasons: string[] = [];
  const acceptance = sources.flatMap((s) => s.acceptance ?? []);
  if (sources.length === 0) reasons.push('no source snapshot: the request is prose');
  const prose = sources.filter((s) => !STRUCTURED.has(s.kind) || !s.acceptance);
  if (prose.length > 0)
    reasons.push(
      `${prose.length} source(s) without structured acceptance: ${prose.map((s) => s.kind).join(', ')}`,
    );
  const trimmed = acceptance.map((a) => a.trim());
  if (sources.length > 0 && trimmed.length === 0) reasons.push('no acceptance criteria');
  if (trimmed.some((a) => a.length === 0)) reasons.push('an acceptance criterion is blank');
  if (new Set(trimmed).size !== trimmed.length) reasons.push('acceptance criteria repeat');
  if (card.unknowns.length > 0) reasons.push(`${card.unknowns.length} open fork(s) on the card`);
  const alwaysAsk = input.alwaysAsk.includes('intake');
  if (alwaysAsk) reasons.push('intake is in lead.alwaysAsk');
  const verdict = reasons.length === 0 ? 'auto' : 'ask';
  if (verdict === 'auto')
    reasons.push(
      `structured acceptance (${trimmed.length}), no forks: the card is accepted without a question`,
    );
  return {
    verdict,
    sourceKinds: sources.map((s) => s.kind),
    structuredAcceptance: acceptance.length,
    unknowns: card.unknowns.length,
    alwaysAsk,
    reasons,
  };
}

/**
 * Источник в строке решения: всё, что нужно повторному суду (вид, ключ, критерии, отпечаток), без
 * тела и полей трекера — тело уже лежит запросом задачи (`request` оценки — тело снимка), а журнал
 * не копит чужой текст дважды.
 */
function sourceMetaOf(source: IntakeSource): IntakeSource {
  const { body: _body, fields: _fields, ...meta } = source;
  return { ...meta, body: '' };
}

/**
 * Строка решения `intake` с карточкой в выводе: её примет ответ человека, если спросили. `null` —
 * источники карточку не собрали (её соберёт шаг разбора), строка несёт только источники.
 */
export function journalIntakeDecision(
  task: LiveTask,
  decision: IntakeDecision,
  card: IntakeCard | null,
  inputs: readonly number[],
  stepId?: string,
  sources: readonly IntakeSource[] = [],
): number {
  return task.append({
    kind: 'decision',
    actor: 'core',
    ...(stepId ? { stepId } : {}),
    data: {
      decisionId: newId(),
      class: 'intake',
      inputs: [...inputs],
      facts: [],
      numbers: { unknowns: decision.unknowns, structuredAcceptance: decision.structuredAcceptance },
      reasons: decision.reasons,
      output: JSON.parse(
        JSON.stringify({ ...decision, card, sources: sources.map(sourceMetaOf) }),
      ) as never,
    },
  }).seq;
}

/** Источники задачи из первого решения `intake` (его пишет оценка); нет решения — пусто. */
export function intakeSourcesOf(task: LiveTask): IntakeSource[] {
  for (const l of readJournalLines(task.dir, task.taskId).lines) {
    if (l.kind !== 'decision') continue;
    const d = l.data as { class: string; output: { sources?: IntakeSource[] } | null };
    if (d.class === 'intake') return d.output?.sources ?? [];
  }
  return [];
}

/** Карточка принята: сама (`askId` null) или ответом человека на вопрос `askId`. */
export function journalCard(
  task: LiveTask,
  card: IntakeCard,
  askId: string | null,
  cause: number,
): number {
  return task.append({
    kind: 'intake.card',
    actor: 'core',
    cause,
    data: { card, by: askId === null ? 'auto' : 'human', askId },
  }).seq;
}

/** Карточка последнего решения `intake` задачи (та, о которой спросили). */
function pendingCard(task: LiveTask): IntakeCard | null {
  const lines = readJournalLines(task.dir, task.taskId).lines;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind !== 'decision') continue;
    const d = l.data as { class: string; output: { card?: IntakeCard } | null };
    if (d.class === 'intake') return d.output?.card ?? null;
  }
  return null;
}

/**
 * Ответ на вопрос карточки: «подтвердить» — `intake.card{by:'human'}` с карточкой решения;
 * «остановить» — карточки нет, задачу кончает судья `next` (`lead-gate`). Ответ вне вариантов
 * отказан командой до этой функции.
 */
export function settleIntakeAnswer(
  task: LiveTask,
  ask: { askId: string; answer: string; cause: number },
): IntakeAnswer | undefined {
  const key = intakeAnswerOf(ask.answer);
  if (key !== 'confirm') return key;
  const card = pendingCard(task);
  if (card) journalCard(task, card, ask.askId, ask.cause);
  return key;
}
