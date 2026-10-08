import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { LIVE_INTERVAL_MS } from './DlpApi.constants';
import { getJournal } from '../lib/getJournal';

/**
 * Лента срабатываний. Отдельным запросом: сводка открывается один раз, а лента
 * интересна именно свежая — при работающем прокси она обновляется сама.
 */
export function useDlpJournal(enabled: boolean, live = false) {
  return useQuery({
    queryKey: queryKeys.dlpJournal,
    queryFn: getJournal,
    enabled,
    refetchInterval: enabled && live ? LIVE_INTERVAL_MS : false,
  });
}
