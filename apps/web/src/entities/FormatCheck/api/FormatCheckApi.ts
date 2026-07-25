import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormatCheckReport, FormatCheckResponse } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getFormatCheck(): Promise<FormatCheckResponse> {
  const { data } = await apiClient.get<FormatCheckResponse>('/format-check');
  return data;
}

async function refreshFormatCheck(): Promise<FormatCheckReport> {
  const { data } = await apiClient.post<FormatCheckReport>('/format-check/refresh');
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

/** Кнопка «проверить сейчас»: единственный путь, который идёт в сеть синхронно. */
export function useRefreshFormatCheck() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: refreshFormatCheck,
    onSuccess: (report) => {
      queryClient.setQueryData<FormatCheckResponse>(queryKeys.formatCheck, {
        report,
        stale: false,
      });
    },
  });
}
