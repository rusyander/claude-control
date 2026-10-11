import type { AnalyticsPeriod } from './api.types';
import { periodKey } from './periodKey';
import { api } from '../../shared/api/client';
import type { Analytics } from '@agentdeck/contracts';
import { periodParams } from './periodParams';
import { analyticsRefusal } from './analyticsRefusal';

/**
 * Активный CLI входит в ключ: отчёт одного CLI не должен минуту доживать в
 * кэше под другим. Отказ не повторяется — он не временный, повтор только
 * оттянул бы честный ответ.
 */
export function analyticsQueryOptions(period: AnalyticsPeriod, providerId: string | undefined) {
  const provider = providerId ?? '';
  return {
    queryKey: ['analytics', provider, periodKey(period)],
    // Новый период грузится поверх прошлого отчёта, а не пустым экраном: цифры
    // того же CLI за другой срок — честная подложка, экран её приглушает. Отчёт
    // ДРУГОГО CLI подложкой не бывает — это была бы ложь, ради которой CLI и
    // стоит в ключе.
    placeholderData: (
      previous: Analytics | undefined,
      previousQuery: { queryKey: readonly unknown[] } | undefined,
    ): Analytics | undefined => (previousQuery?.queryKey[1] === provider ? previous : undefined),
    queryFn: () => api.get<Analytics>('/analytics', periodParams(period)),
    // Скан транскриптов не бесплатен, а цифры за сутки не меняются посекундно.
    staleTime: 60_000,
    retry: (failures: number, error: Error) => !analyticsRefusal(error) && failures < 1,
  };
}
