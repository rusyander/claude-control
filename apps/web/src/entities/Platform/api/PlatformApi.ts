import { useQuery } from '@tanstack/react-query';
import type { PlatformsInfo } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';
import { getPlatformsInfo } from '../lib/getPlatformsInfo';

/**
 * Контуры с масками ключей и итогом последней пробы. В сеть этот запрос НЕ
 * ходит: сервер только читает настройки, — поэтому его можно звать при каждом
 * открытии раздела, а живая проверка остаётся отдельной кнопкой.
 */
export function usePlatforms() {
  return useQuery({
    queryKey: queryKeys.platforms,
    queryFn: getPlatformsInfo,
    select: (info: PlatformsInfo) => info.platforms,
  });
}
