import { useQuery } from '@tanstack/react-query';
import type { FormatCheckResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getFormatCheck(): Promise<FormatCheckResponse> {
  const { data } = await apiClient.get<FormatCheckResponse>('/format-check');
  return data;
}

/**
 * Сверка форматов чужих CLI со схемами. Обычный запрос сеть не ждёт: сервер
 * отдаёт кэш, а устаревший результат обновляет фоном — раздел настроек
 * открывается одинаково быстро и без интернета.
 */
export function useFormatCheck() {
  return useQuery({
    queryKey: queryKeys.formatCheck,
    queryFn: getFormatCheck,
    staleTime: 10 * 60 * 1000,
  });
}
