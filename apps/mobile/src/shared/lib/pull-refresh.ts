import { useCallback, useState } from 'react';
import { pullOnce } from './pullOnce';

/**
 * Крутилка «потяните вниз» — только пока идёт перезапрос, который начал сам человек.
 * `isFetching`/`isRefetching` запроса правдивы и для фонового опроса: экран с опросом
 * раз в 5 с дёргал крутилку сам по себе.
 */
export function usePullRefresh(...refetches: Array<() => Promise<unknown>>) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    void pullOnce(refetches, setRefreshing);
    // refetch у react-query стабилен между рендерами; список держится как есть
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refetches);
  return { refreshing, onRefresh };
}
