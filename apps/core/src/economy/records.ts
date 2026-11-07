import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { numbersRecord } from './continuation.ts';
import type { ContinuationDecision } from './continuation.types.ts';
import type { TierDecision } from './tier.types.ts';

/**
 * Строки решений `tier` и `continuation` для журнала: числа судьи — в `numbers` (P14, «every
 * decision event carries numbers»), выход — то, по чему выученное потом узнаёт понижение и
 * правку человека (`applied`, `learning`). Id решения ставит пишущий.
 */

export type DecisionBody = Omit<JournalDataV1['decision'], 'decisionId'>;

const routeLabel = (r: { kind: string; id: string }): string => `${r.kind}:${r.id}`;

export function tierDecisionBody(tier: TierDecision): DecisionBody {
  const output: DecisionBody['output'] = tier.ok
    ? {
        adapter: tier.adapter,
        route: routeLabel(tier.route),
        model: tier.model,
        effort: tier.effort,
        asked: tier.asked,
        applied: tier.applied,
        learning: tier.learning,
        warnings: tier.warnings,
        alternatives: tier.alternatives.map((a) => `${a.adapter}/${routeLabel(a.route)}`),
        skipped: tier.skipped.map((s) => `${routeLabel(s.route.route)}=${s.verdict}`),
        basis: tier.basis,
        // Этап 11: роль и откуда её ступень, эскалация (причина — `cause`: по `recordId` бриф
        // берёт отрывок провала), подъём по обучению и ключ, по которому копятся пробы.
        role: tier.role,
        roleSource: tier.roleSource,
        sources: { ...tier.sources },
        cause: tier.escalation ? { ...tier.escalation.cause } : null,
        atCeiling: tier.escalation?.atCeiling ?? false,
        promotion: tier.promotion
          ? { rungs: tier.promotion.rungs, evidence: [...tier.promotion.evidence] }
          : null,
        learnedKey: tier.learnedKey ? { ...tier.learnedKey } : null,
      }
    : {
        refused: true,
        alternatives: tier.alternatives.map((a) => `${a.adapter}/${routeLabel(a.route)}`),
        skipped: tier.skipped.map((s) => `${routeLabel(s.route.route)}=${s.verdict}`),
        basis: tier.basis,
      };
  return {
    class: 'tier',
    inputs: [],
    facts: [],
    numbers: tier.numbers,
    reasons: tier.reasons,
    output,
  };
}

export function continuationDecisionBody(c: ContinuationDecision): DecisionBody {
  return {
    class: 'continuation',
    inputs: [],
    facts: [],
    numbers: numbersRecord(c.numbers),
    reasons: c.reasons,
    output:
      c.mode === 'same-session'
        ? { mode: 'same-session', sessionId: c.sessionId, basis: c.basis }
        : {
            mode: 'fresh',
            reason: c.reason,
            forced: c.numbers.forced ?? null,
            basis: c.basis,
          },
  };
}
