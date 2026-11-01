import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { RequirementsInput } from './requirements.types.ts';

/**
 * Входы судьи из строк журнала (01 §State: журнал — истина). Свёртка v5 требований не держит;
 * чтение строк — та же дорога, что у `step_done` (счёт отказов) и копии (`journal-view.ts`).
 * Чистая: строки даёт вызывающий.
 */

export type JudgedInput = Omit<RequirementsInput, 'evidence'>;

function data<K extends keyof JournalDataV1>(line: JournalLine, kind: K): JournalDataV1[K] | null {
  return line.kind === kind ? (line.data as JournalDataV1[K]) : null;
}

export function requirementsInputOf(lines: readonly JournalLine[]): JudgedInput {
  const out: JudgedInput = { requirements: [], waivers: [], claims: [], derived: [], reviews: [] };
  const kindOf = new Map<string, string>();
  for (const line of lines) {
    const started = data(line, 'step.started');
    if (started) kindOf.set(started.stepId, started.stepKind);
    const extracted = data(line, 'requirement.extracted');
    if (extracted)
      out.requirements.push({
        id: extracted.requirementId,
        ordinal: extracted.ordinal,
        text: extracted.text,
        source: extracted.source,
        stepId: extracted.stepId,
        seq: line.seq,
      });
    const verdict = data(line, 'requirement.verdict');
    if (verdict?.verdict === 'waived')
      out.waivers.push({ id: verdict.requirementId, reason: verdict.reason, seq: line.seq });
    const claimed = data(line, 'step.claimed');
    if (claimed)
      out.claims.push({
        seq: line.seq,
        stepId: claimed.stepId,
        stepKind: kindOf.get(claimed.stepId) ?? 'unknown',
        claim: claimed.claim,
      });
    const ended = data(line, 'step.ended');
    if (ended?.basis === 'derived') out.derived.push({ stepId: ended.stepId, seq: line.seq });
    const reviewed = data(line, 'requirement.reviewed');
    if (reviewed)
      out.reviews.push({
        stepId: reviewed.stepId,
        complete: reviewed.complete,
        added: reviewed.added,
        seq: line.seq,
      });
  }
  return out;
}

/** Записи, на которые сейчас опирается «покрыто»: последнее заявление о каждом требовании. */
export function citedEvidence(input: JudgedInput): string[] {
  const latest = new Map<string, string[]>();
  for (const row of input.claims)
    for (const c of row.claim.requirements)
      latest.set(c.id, c.state === 'covered' ? c.evidence : []);
  return [...new Set([...latest.values()].flat())].sort();
}
