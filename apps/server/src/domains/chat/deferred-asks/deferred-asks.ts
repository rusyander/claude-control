import type { DeferredScope } from '@agentdeck/contracts/deferred-asks';

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
  allowMainCopyPrompt,
  allowResumePrompt,
  alreadyQueuedDenial,
  deferralDenial,
  denyResumePrompt,
  expiredResumePrompt,
  groupMainCopyRefusal,
  humanRefusedDenial,
  keepDraftRefusal,
  lapsedGrantPrompt,
  mergeRefusal,
  mrMentionRefusal,
  outcomesPrompt,
  selfApprovalRefusal,
  twinDecidedDenial,
  unresolvedPushRefusal,
  type OutcomeItem,
} from './texts.ts';
export type {
  DeferredAskInput,
  DeferredAskOutcome,
  DeferredAskRecord,
  DeferredAsksDeps,
  DeferredDecisionInput,
  DeferredDecisionOutcome,
} from './deferred-asks.types.ts';

/**
 * Чьё это: связь разговора с группой разделения (родитель + номер) — группа,
 * иначе — ключи самого чата. Разрешение группы действует на любой её разговор:
 * доставка и продолжение после паузы — новые разговоры той же группы.
 */
export function deferredScopeOf(
  linkOf: (key: string) => { parentChatId?: string; groupIndex?: number } | undefined,
  keys: readonly (string | undefined)[],
): DeferredScope {
  const known = [...new Set(keys.filter((key): key is string => Boolean(key)))];
  for (const key of known) {
    const link = linkOf(key);
    if (link?.parentChatId && typeof link.groupIndex === 'number') {
      return { kind: 'group', parentChatId: link.parentChatId, groupIndex: link.groupIndex };
    }
  }
  return { kind: 'chat', chatKeys: known };
}
