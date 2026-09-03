import { useQuery } from '@tanstack/react-query';
import type { AppSettings } from '@claude-control/contracts';
import { api } from '../../shared/api/client';
import type { CostUnit } from '../../shared/lib/format';

/**
 * Настройки самой панели. Приложение их не правит — только читает то, что
 * влияет на показ: единицы расхода выбраны один раз в панели, и телефон обязан
 * считать так же, иначе одна и та же работа выглядит на двух экранах по-разному.
 */

/**
 * Ровно то, что телефон читает из настроек панели, — типом из контрактов, чтобы
 * переименование ключа на сервере ломало сборку, а не показ.
 */
type PanelSettings = Pick<AppSettings, 'costUnit'>;

export function useCostUnit(): CostUnit {
  const settings = useQuery({
    queryKey: ['panel-settings'],
    queryFn: () => api.get<PanelSettings>('/settings'),
    staleTime: 10 * 60_000,
  });
  return settings.data?.costUnit ?? 'tokens';
}
