import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import type { CostUnit } from '../../shared/lib/format';

/**
 * Настройки самой панели. Приложение их не правит — только читает то, что
 * влияет на показ: единицы расхода выбраны один раз в панели, и телефон обязан
 * считать так же, иначе одна и та же работа выглядит на двух экранах по-разному.
 */

interface PanelSettings {
  costUnit?: CostUnit;
}

export function useCostUnit(): CostUnit {
  const settings = useQuery({
    queryKey: ['panel-settings'],
    queryFn: () => api.get<PanelSettings>('/settings'),
    staleTime: 10 * 60_000,
  });
  return settings.data?.costUnit ?? 'tokens';
}
