import type { WatcherSpend } from '@agentdeck/contracts';
import type { CostUnit } from '../../shared/lib/formatSpend';
import { formatSpend } from '../../shared/lib/formatSpend';

/**
 * Расход в единицах, выбранных в панели. Деньги — только когда модель нашлась
 * в прайсе, и всегда с пометкой «оценка»: при подписке токены не списываются.
 */
export function watcherSpendText(
  spend: WatcherSpend,
  unit: CostUnit,
): { text: string; estimate: boolean } {
  const tokens = spend.input + spend.output + spend.cacheRead + spend.cacheCreation;
  if (unit === 'money' && spend.estimatedUsd !== undefined) {
    return { text: formatSpend('money', tokens, spend.estimatedUsd), estimate: true };
  }
  return { text: formatSpend('tokens', tokens, 0), estimate: false };
}
