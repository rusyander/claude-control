/**
 * Приём ведущего (этап 11, W2-6, P133-P134): источник → карточка → решение «принять самой или
 * спросить» (`judge.ts`), вопросы карточки и класса (`questions.ts`), приём на оценке
 * (`estimate-seed.ts`), ожидание места первого сеанса (`session-wait.ts`).
 */

export { acceptanceProblem, cardFromClaim, cardFromSources } from './card.ts';
export {
  INTAKE_DEFERRED_SIGNAL,
  INTAKE_LINT_SIGNAL,
  isLeadScenario,
  leadEstimate,
  leadReplyOf,
  type LeadEstimate,
} from './estimate-seed.ts';
export {
  estimateGroup,
  GROUP_ID_PREFIX,
  GROUP_MIXED_PROBLEM,
  groupIdOf,
  groupIncomplete,
  groupItemsOf,
  groupMixProblem,
  groupReplyOf,
  isGroupItem,
  itemCmdId,
  tasksOfGroup,
} from './group.ts';
export {
  decideIntake,
  intakeSourcesOf,
  journalCard,
  journalIntakeDecision,
  settleIntakeAnswer,
} from './judge.ts';
export {
  classAnswerOf,
  classAsk,
  classifyDedupe,
  intakeAnswerOf,
  intakeAsk,
  intakeDedupe,
  INTAKE_ANSWERS,
  leadAnswerFits,
} from './questions.ts';
export {
  maskedSource,
  sourceDigestOf,
  sourcesOf,
  structuredAcceptanceOf,
  trackerSourceProblem,
} from './source.ts';
export {
  recordedSessionWait,
  SESSION_WAIT_SIGNAL,
  sessionMedianOf,
  sessionWaitOf,
  type SessionWait,
  type SessionWaitFacts,
} from './session-wait.ts';
export type { AcceptanceRow, CardBuilt, IntakeInput, SourcesRead } from './intake.types.ts';
