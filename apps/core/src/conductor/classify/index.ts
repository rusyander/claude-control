/**
 * Классификатор ведущего (класс решений `classify`, W2-8): признаки → класс → форма. Судья один —
 * `decideClass`; строка решения несёт его вывод целиком, свёртка берёт `output.class`.
 */

export { decideClass, type ClassifyInput } from './classify.ts';
export {
  leadConfigOf,
  leadSettingsFor,
  proposeSoloIfDue,
  settleLeadAnswer,
  type LeadConfigRead,
} from './flow.ts';
export { humanClassOf, journalClass, lastClassDecision, proposalOf } from './journal.ts';
export { soloSplitDue, soloUnitOf } from './shape.ts';
export {
  classSignalsOf,
  RISK_PATH_RULES,
  riskWhy,
  touchedUnitsOf,
  type RiskPathRule,
  type SignalsInput,
} from './signals.ts';
