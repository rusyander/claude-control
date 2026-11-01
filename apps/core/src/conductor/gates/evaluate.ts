import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Gate, GateFacts, GatesDecision, GateUnmet } from './gates.types.ts';

/** Зелёные — только `pass*` (04 §Decision rules); `no-verdict` и `fail` ворота не открывают. */
const GREEN = new Set(['pass', 'pass-flaky']);

const why = (f: Fact<unknown>): string => ('unknown' in f ? `unreadable: ${f.unknown}` : 'absent');

/** Одна причина или `null`, если ворото открыто. Каждый вид — только по своему факту. */
function unmetReason(gate: Gate, index: number, facts: GateFacts): string | null {
  switch (gate.kind) {
    case 'requirements-covered':
      return facts.requirements.covered ? null : facts.requirements.missing.join('; ');
    case 'check-green': {
      const rec = facts.checks[gate.checkId] ?? { absent: true as const };
      if (!('value' in rec)) return `check ${gate.checkId}: record ${why(rec)}`;
      if (!GREEN.has(rec.value.verdict))
        return `check ${gate.checkId}: ${rec.value.recordId} is ${rec.value.verdict}`;
      if (!rec.value.current)
        return `check ${gate.checkId}: ${rec.value.recordId} is green on an older tree`;
      return null;
    }
    case 'regression-red-before': {
      if (!('value' in facts.redBefore)) return `red-before proof ${why(facts.redBefore)}`;
      if (facts.redBefore.value.length === 0) return 'no regression test proven red on the base';
      const unproven = facts.redBefore.value.filter((r) => r.outcome !== 'proven');
      return unproven.length === 0
        ? null
        : unproven.map((r) => `${r.test}: ${r.outcome}`).join('; ');
    }
    case 'review-no-blocking': {
      if (!('value' in facts.review)) return `review ${why(facts.review)}`;
      const n = facts.review.value.blocking;
      return n === 0 ? null : `review ${facts.review.value.stepId}: ${n} blocking finding(s)`;
    }
    case 'text': {
      const said = facts.confirmations[index];
      if (said === 'confirmed') return null;
      return said === 'refuted'
        ? `criterion refuted by review: ${gate.criterion}`
        : `criterion not confirmed by review (${facts.stepDefId}#${index}): ${gate.criterion}`;
    }
  }
}

/**
 * Суд ворот шага (P01 — одна функция на решение): каждое ворото по своему типизированному факту,
 * закрытые названы все сразу, а не первое. Нечитаемый факт — закрыто с причиной, никогда открыто
 * (P44). Пустой список ворот — открыто: шаг без ворот ничего не требует.
 */
export function evaluateGates(gates: readonly Gate[], facts: GateFacts): GatesDecision {
  const unmet: GateUnmet[] = [];
  gates.forEach((gate, index) => {
    const reason = unmetReason(gate, index, facts);
    if (reason !== null) unmet.push({ index, kind: gate.kind, reason });
  });
  return { passed: unmet.length === 0, unmet };
}
