/** Бриф шага (03 §Context): части, бюджеты (сверх — отказ сборки), маска выхода, секции брифа. */
export {
  BIN_BUDGET,
  binOf,
  BriefOverBudget,
  buildBrief,
  enforceBudget,
  KIND_TOTAL,
  orderParts,
  renderPart,
} from './brief.ts';
export { findingsPart, handoffPart, platformRulesPart } from './sections.ts';
export {
  BRIEF_SECTION_IDS,
  type Brief,
  type BriefPart,
  type BriefPartId,
  type BriefPlaced,
  type BudgetBin,
  type BudgetBreach,
  type RenderedPart,
  type SentSection,
} from './brief.types.ts';
export type { DoneStepRef, FindingRef, HandoffInput, NotebookRef } from './sections.types.ts';
