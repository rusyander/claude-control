import type { RequirementVerdict } from '@agentdeck/contracts/core/journal';
import type {
  EvidenceStanding,
  RequirementJudgement,
  RequirementRow,
  RequirementsDecision,
  RequirementsInput,
} from './requirements.types.ts';

/**
 * `conductor/requirements` — единственный судья требований (02:57, P01). Каждое id получает
 * `covered | waived | n/a | open | unknown` только из типизированных строк:
 * - `waived` — только снятие человеком (G2), окончательно;
 * - шаг, закрытый выводом (02:47, P16), обнуляет всё, что было до него: требование `unknown`, пока
 *   шаг ревью не типизирует его заново;
 * - дальше в порядке журнала: заявление «покрыто» (записи прошли суд `step_done`) → `covered`,
 *   если каждая запись ещё свежая; «не применимо» — только с подтверждением ревью; подтверждение
 *   ревью «требование выполнено» → `covered`, опровержение → `open`;
 * - ворота `requirements-covered` открыты, когда каждое требование типизировано И извлечение
 *   сверено с источником после последнего извлечения (P93). Проза модели не читается (P32).
 */

const TYPED: ReadonlySet<RequirementVerdict> = new Set(['covered', 'waived', 'n/a']);
/** Извлечение из источника: его сверяет ревью; добавленное ревью или человеком — нет. */
const FROM_SOURCE: ReadonlySet<RequirementRow['source']> = new Set(['request', 'ticket']);

type Statement =
  | { seq: number; review: boolean; kind: 'covered'; evidence: string[]; stepId: string }
  | { seq: number; review: boolean; kind: 'n/a-claimed'; reason: string; stepId: string }
  | {
      seq: number;
      review: true;
      kind: 'confirm-requirement' | 'confirm-n/a';
      confirmed: boolean;
      reason: string;
      stepId: string;
    };

function statementsOf(input: RequirementsInput, id: string): Statement[] {
  const out: Statement[] = [];
  for (const row of input.claims) {
    const review = row.stepKind === 'review';
    // Второе ревью (P185) ничего не одобряет: его «покрыто» и подтверждения не в счёт, опровержения — в счёт.
    for (const claim of row.cross ? [] : row.claim.requirements) {
      if (claim.id !== id) continue;
      out.push(
        claim.state === 'covered'
          ? { seq: row.seq, review, kind: 'covered', evidence: claim.evidence, stepId: row.stepId }
          : {
              seq: row.seq,
              review,
              kind: 'n/a-claimed',
              reason: claim.evidence,
              stepId: row.stepId,
            },
      );
    }
    // Подтверждения несёт только шаг ревью (`STEP_DONE_KIND_FIELDS`); иной вид — не подтверждение.
    if (!review) continue;
    for (const c of row.claim.confirmations ?? []) {
      if (c.target.kind === 'gate' || c.target.id !== id) continue;
      if (row.cross && c.verdict === 'confirmed') continue;
      out.push({
        seq: row.seq,
        review: true,
        kind: c.target.kind === 'n/a' ? 'confirm-n/a' : 'confirm-requirement',
        confirmed: c.verdict === 'confirmed',
        reason: c.reason,
        stepId: row.stepId,
      });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function staleOf(
  evidence: readonly string[],
  standing: Record<string, EvidenceStanding>,
): string | null {
  for (const id of evidence) {
    const s = standing[id];
    if (s === undefined) return `evidence ${id} was not re-read after the step`;
    if (s === 'current') continue;
    return 'stale' in s
      ? `evidence ${id} is stale: ${s.stale}`
      : `evidence ${id} unreadable: ${s.unknown}`;
  }
  return null;
}

function judgeOne(input: RequirementsInput, row: RequirementRow): RequirementJudgement {
  const base = { id: row.id, ordinal: row.ordinal };
  const waiver = input.waivers.find((w) => w.id === row.id);
  if (waiver) return { ...base, verdict: 'waived', evidence: [], reason: waiver.reason };
  // Вывод исхода без заявления, случившийся ПОСЛЕ появления требования, его обнуляет.
  const derived = input.derived.filter((d) => d.seq > row.seq).at(-1);
  let statements = statementsOf(input, row.id);
  if (derived) {
    statements = statements.filter((s) => s.seq > derived.seq);
    if (!statements.some((s) => s.review))
      return {
        ...base,
        verdict: 'unknown',
        evidence: [],
        reason: `step ${derived.stepId} ended derived (no step_done); no review step typed it since`,
      };
  }
  let verdict: RequirementVerdict = 'open';
  let evidence: string[] = [];
  let reason = 'no step reported it yet';
  let pendingNa: string | null = null;
  for (const s of statements) {
    if (s.kind === 'covered') {
      const stale = staleOf(s.evidence, input.evidence);
      verdict = stale ? 'open' : 'covered';
      evidence = stale ? [] : [...s.evidence];
      reason = stale ?? `covered by step ${s.stepId}`;
      pendingNa = null;
    } else if (s.kind === 'n/a-claimed') {
      verdict = 'open';
      evidence = [];
      pendingNa = s.reason;
      reason = `n/a claimed by step ${s.stepId}, not confirmed by a review`;
    } else if (s.kind === 'confirm-n/a') {
      verdict = s.confirmed ? 'n/a' : 'open';
      evidence = s.confirmed ? [`review:${s.stepId}`] : [];
      reason = s.confirmed
        ? `n/a (${pendingNa ?? s.reason}) confirmed by review ${s.stepId}`
        : `n/a refuted by review ${s.stepId}: ${s.reason}`;
      pendingNa = null;
    } else {
      verdict = s.confirmed ? 'covered' : 'open';
      evidence = s.confirmed ? [`review:${s.stepId}`] : [];
      reason = s.confirmed
        ? `confirmed by review ${s.stepId}: ${s.reason}`
        : `refuted by review ${s.stepId}: ${s.reason}`;
      pendingNa = null;
    }
  }
  return { ...base, verdict, evidence, reason };
}

function extractionReviewOf(input: RequirementsInput): { reviewed: boolean; why: string | null } {
  const extracted = input.requirements.filter((r) => FROM_SOURCE.has(r.source));
  const lastExtraction = extracted.at(-1)?.seq ?? -1;
  const extractingSteps = new Set(extracted.flatMap((r) => (r.stepId ? [r.stepId] : [])));
  // Свой список шаг не сверяет: сверка — следующим шагом плана или ревью (G4).
  const review = input.reviews
    .filter((r) => r.seq > lastExtraction && !extractingSteps.has(r.stepId))
    .at(-1);
  if (!review)
    return {
      reviewed: false,
      why:
        extracted.length === 0 && input.reviews.length === 0
          ? 'requirements were never extracted and reviewed'
          : 'the extraction was not reviewed against its source by a later step',
    };
  if (!review.complete)
    return {
      reviewed: false,
      why: `review ${review.stepId} found the extraction incomplete`,
    };
  return { reviewed: true, why: null };
}

export function decideRequirements(input: RequirementsInput): RequirementsDecision {
  const rows = [...input.requirements].sort((a, b) => a.ordinal - b.ordinal);
  const requirements = rows.map((row) => judgeOne(input, row));
  const review = extractionReviewOf(input);
  const missing: string[] = [];
  if (review.why) missing.push(review.why);
  for (const r of requirements)
    if (!TYPED.has(r.verdict)) missing.push(`R${r.ordinal} ${r.id}: ${r.verdict} (${r.reason})`);
  return {
    requirements,
    extractionReviewed: review.reviewed,
    covered: missing.length === 0,
    missing,
  };
}
