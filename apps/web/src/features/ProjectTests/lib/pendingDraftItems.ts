import type { ProjectTestDraftSummary } from '@agentdeck/contracts';

/**
 * Ждущих правок во всех непринятых черновиках. Окно приёмки открывает черновики
 * по одному, а плашка со счётом одного говорила «правок: 1» при двух черновиках
 * (кейс из чата и правка агентом кейса человека), и после «Принять всё (1)»
 * человек считал, что решил всё.
 */
export function pendingDraftItems(drafts: readonly ProjectTestDraftSummary[]): number {
  return drafts
    .filter((item) => item.status === 'pending')
    .reduce((sum, item) => sum + item.pending, 0);
}
