import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { getClaudeMd } from '../lib/getClaudeMd';

/**
 * Файл инструкций активного провайдера. `enabled: false` — не запрашивать:
 * у провайдера без глобальных инструкций (Continue) сервер отвечает 400, и
 * страница, которой файл нужен лишь для подсказки, не должна его дёргать.
 */
export function useClaudeMd(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.claudeMd,
    queryFn: getClaudeMd,
    enabled: options.enabled ?? true,
  });
}
