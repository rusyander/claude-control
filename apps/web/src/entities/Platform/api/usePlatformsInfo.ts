import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { getPlatformsInfo } from '../lib/getPlatformsInfo';

/**
 * То же самое, но целиком: активный контур и рассказ о переносе. Запрос тот же
 * — react-query держит один ответ под одним ключом, и раздел с карточками не
 * ходит на сервер дважды.
 */
export function usePlatformsInfo() {
  return useQuery({ queryKey: queryKeys.platforms, queryFn: getPlatformsInfo });
}
