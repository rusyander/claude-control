/** Единый вход проверки (G21, P02): дороги захвата, инструмент модели, дирижёр, простой. */
export { ANSWER_BUDGET_MS, createCheckService, type CheckService } from './request.ts';
export { derivedId, matchRequest, normaliseArgv, type Match } from './match.ts';
export {
  modelCheck,
  type ModelCheckContext,
  type ModelCheckReply,
  type ModelCheckUnit,
} from './model-tool.ts';
export { idlePreRun, preRunCandidates, type PreRunOutcome, type PreRunScope } from './idle.ts';
export type { CallerResult, CheckDeps, CheckJournalEntry, KeyInput } from './checks.types.ts';
