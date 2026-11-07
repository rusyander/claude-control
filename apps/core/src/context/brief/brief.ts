import { createHash } from 'node:crypto';
import { maskSink, type Sink } from '../sinks/index.ts';
import {
  BRIEF_SECTION_IDS,
  type Brief,
  type BriefPart,
  type BriefPartId,
  type BudgetBin,
  type BudgetBreach,
  type RenderedPart,
} from './brief.types.ts';

/**
 * Бриф шага (03 §Context, R:S2-28/29, P13): части из журнала в постоянном порядке, каждая — в своей
 * корзине бюджета, весь текст — через маску выхода (`context/sinks`), до того как его увидит
 * модель. Сверх бюджета — отказ сборки `BriefOverBudget` с названными корзинами (03:136:
 * «over budget = build failure, no unmarked truncation»): срез молча терял бы требование или
 * находку, а модель не знала бы, что чего-то нет. Текст человека (сообщение в шаг, ответ) в итог
 * не входит: его предел — команда (16k).
 *
 * Части с одним id сливаются в одну секцию: набор отданного (`brief.sent`) ведётся по id, и две
 * секции «profile» двух репозиториев иначе затирали бы отпечаток друг друга (повтор в сессии).
 */

const BIN_OF: Record<BriefPartId, BudgetBin> = {
  task: 'task',
  step: 'step',
  'human-message': 'human',
  answer: 'human',
  requirements: 'requirements',
  knowledge: 'knowledge',
  handoff: 'unit-state',
  findings: 'unit-state',
  'external-edits': 'unit-state',
  'previous-attempt': 'unit-state',
  'recon-map': 'recon',
  failing: 'check-scope',
  ownership: 'platform',
  'copy-setup': 'platform',
  profile: 'platform',
  reminder: 'platform',
  // Слова ревьюеров — слова людей: обрезка середины нити дала бы ответ не на то (заметка — до
  // `THREAD_NOTE_MAX`, обрезает её `publisher/after`).
  threads: 'human',
};

/** Байты корзин (03 §Context); `human` — без предела (`Infinity`). */
export const BIN_BUDGET: Record<BudgetBin, number> = {
  task: 1000,
  step: 2000,
  requirements: 2000,
  knowledge: 1000,
  'unit-state': 3000,
  recon: 3000,
  'check-scope': 1000,
  platform: 1000,
  human: Number.POSITIVE_INFINITY,
};

/** Итог брифа по виду шага; у прочих видов итога нет — только корзины. */
export const KIND_TOTAL: Readonly<Record<string, number>> = {
  plan: 12_000,
  work: 10_000,
  review: 8000,
  fix: 6000,
};

export const binOf = (id: BriefPartId): BudgetBin => BIN_OF[id];

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Сборка не уложилась в бюджет: что и насколько — в `breaches`, текста брифа нет. */
export class BriefOverBudget extends Error {
  readonly code = 'brief-over-budget' as const;
  readonly stepKind: string;
  readonly breaches: readonly BudgetBreach[];

  constructor(stepKind: string, breaches: readonly BudgetBreach[]) {
    super(
      `brief over budget for step kind ${stepKind}: ` +
        breaches
          .map((b) =>
            b.part === null
              ? `total ${b.bytes} bytes > ${b.budget}`
              : `${b.part} (${b.from}) fills the ${b.bin} bin to ${b.bytes} bytes > ${b.budget}`,
          )
          .join('; '),
    );
    this.name = 'BriefOverBudget';
    this.stepKind = stepKind;
    this.breaches = breaches;
  }
}

const ORDER = new Map<BriefPartId, number>(BRIEF_SECTION_IDS.map((id, i) => [id, i]));

/** Пустые части выпадают, части одного id сливаются (порядок прихода), порядок — по списку секций. */
export function orderParts(parts: readonly BriefPart[]): BriefPart[] {
  const merged = new Map<BriefPartId, BriefPart>();
  for (const part of parts) {
    if (part.text.trim() === '') continue;
    const had = merged.get(part.id);
    merged.set(
      part.id,
      had
        ? {
            id: part.id,
            text: `${had.text}\n\n${part.text}`,
            from: had.from === part.from ? had.from : `${had.from}, ${part.from}`,
          }
        : part,
    );
  }
  return [...merged.values()].sort((a, b) => (ORDER.get(a.id) ?? 0) - (ORDER.get(b.id) ?? 0));
}

/** Часть, какой её увидит модель: под маской выхода, с заголовком, с отпечатком показанного. */
export function renderPart(
  part: BriefPart,
  sink: Sink,
  known: readonly string[] = [],
): RenderedPart {
  const clean = maskSink(part.text, sink, known);
  const block = `## ${part.id}\n${clean.text}`;
  return {
    id: part.id,
    from: part.from,
    block,
    bytes: bytesOf(block),
    sha256: sha256(block),
    masked: clean.masked,
  };
}

/**
 * Бюджет корзин и итога по виду шага; нарушение — `BriefOverBudget`. Возвращает байты без
 * человеческого текста. Дельта зовёт его же на своём подмножестве секций.
 */
export function enforceBudget(rendered: readonly RenderedPart[], stepKind: string): number {
  const used = new Map<BudgetBin, number>();
  const crossed = new Map<BudgetBin, RenderedPart>();
  let bytes = 0;
  for (const part of rendered) {
    const bin = BIN_OF[part.id];
    const now = (used.get(bin) ?? 0) + part.bytes;
    used.set(bin, now);
    if (now > BIN_BUDGET[bin] && !crossed.has(bin)) crossed.set(bin, part);
    if (bin !== 'human') bytes += part.bytes;
  }
  const breaches: BudgetBreach[] = [...crossed].map(([bin, part]) => ({
    part: part.id,
    from: part.from,
    bin,
    bytes: used.get(bin) ?? 0,
    budget: BIN_BUDGET[bin],
  }));
  const total = KIND_TOTAL[stepKind];
  if (total !== undefined && bytes > total)
    breaches.push({ part: null, from: null, bin: 'total', bytes, budget: total });
  if (breaches.length > 0) throw new BriefOverBudget(stepKind, breaches);
  return bytes;
}

/**
 * Бриф первого хода сессии. `known` — значения, которые ядро знает секретом (окружение сеанса):
 * прячутся по значению, до детектора формы.
 */
export function buildBrief(
  parts: readonly BriefPart[],
  stepKind: string,
  known: readonly string[] = [],
): Brief {
  const rendered = orderParts(parts).map((p) => renderPart(p, 'brief', known));
  const bytes = enforceBudget(rendered, stepKind);
  return {
    text: rendered.map((p) => p.block).join('\n\n'),
    bytes,
    total: KIND_TOTAL[stepKind] ?? null,
    placed: rendered.map(({ block: _block, ...placed }) => placed),
    masked: rendered.reduce((sum, p) => sum + p.masked, 0),
  };
}
