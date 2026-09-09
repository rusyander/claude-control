import type { ReviewDecisionItem } from '../ui/ReviewDecisionCard.types';

/**
 * Карточка ревью ещё ждёт человека (Т7).
 *
 * Ждут не все: ревью без замечаний закрывается само, а решённое перерешать
 * нечего — правки заведены, комментарий написан. Признак нужен в двух местах
 * сразу (сколько соседей охватит «ко всем» и стоит ли вообще показывать
 * тумблер), и считаться он обязан одинаково.
 */
export function waitsDecision(item: ReviewDecisionItem): boolean {
  return item.review.findings.length > 0 && !item.review.decidedAt;
}
