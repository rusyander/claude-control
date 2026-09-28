import type { WatcherSpend } from '@agentdeck/contracts';
import { formatSpend } from '@shared/lib/format';

/**
 * Расход наблюдателя в единицах, выбранных в настройках. Деньги — только
 * если прайс модели нашёлся: иначе «$0.000» выглядело бы как «бесплатно», а
 * это неизвестность. `estimate` — подпись «оценка по тарифам API» обязательна:
 * при подписке деньги не списываются.
 */
export function watcherSpendText(
  spend: WatcherSpend,
  unit: 'tokens' | 'money',
): { text: string; estimate: boolean } {
  const tokens = spend.input + spend.output + spend.cacheRead + spend.cacheCreation;
  if (unit === 'money' && spend.estimatedUsd !== undefined) {
    return { text: formatSpend('money', tokens, spend.estimatedUsd), estimate: true };
  }
  return { text: formatSpend('tokens', tokens, 0), estimate: false };
}
