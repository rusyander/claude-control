/**
 * Отложенные вопросы человеку D-n — фасад папки `deferred-asks/`: запись
 * (`store.ts`), отпечаток вызова (`hash.ts`), тексты агенту (`texts.ts`).
 * Назначение и правила — в `packages/contracts/src/deferred-asks.ts`.
 */
export {
  DEFERRED_ASKS_FILE,
  DEFERRED_TTL_MS,
  DeferredAsks,
  GRANT_MS,
  deferredView,
  detailOf,
  sameScope,
  summaryOf,
} from './store.ts';
export { callHash, canonicalJson, significantInput } from './hash.ts';
export {
  alreadyQueuedDenial,
  deferralDenial,
  groupMainCopyRefusal,
  humanRefusedDenial,
  keepDraftRefusal,
  mergeRefusal,
  mrMentionRefusal,
  selfApprovalRefusal,
  twinDecidedDenial,
  unresolvedPushRefusal,
} from './texts.ts';
export type {
  DeferredAskInput,
  DeferredAskOutcome,
  DeferredAskRecord,
  DeferredAsksDeps,
  DeferredDecisionInput,
  DeferredDecisionOutcome,
} from './deferred-asks.types.ts';
