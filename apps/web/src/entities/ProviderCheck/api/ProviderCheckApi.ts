import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderCheckResult, ProviderChecksResponse } from '@claude-control/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getChecks(): Promise<ProviderChecksResponse> {
  const { data } = await apiClient.get<ProviderChecksResponse>('/providers/checks');
  return data;
}

async function runCheck(input: {
  provider: string;
  assistant: boolean;
}): Promise<ProviderCheckResult> {
  // Внутри проверки — настоящий запуск ассистента (на сервере до 90 c на шаг),
  // поэтому общих 60 c не хватает: результат уже записан, а клиент показывал
  // несуществующую ошибку таймаута.
  const { data } = await apiClient.post<ProviderCheckResult>(
    `/providers/${encodeURIComponent(input.provider)}/check`,
    { assistant: input.assistant },
    { timeout: LONG_TIMEOUTS.providerCheck },
  );
  return data;
}

/**
 * Итоги проверок провайдеров. Обычный запрос: сервер только читает сохранённое
 * состояние, ничего не запускает — значит, бейджи можно рисовать где угодно, не
 * опасаясь, что открытие раздела дёрнет CLI.
 */
export function useProviderChecks() {
  return useQuery({ queryKey: queryKeys.providerChecks, queryFn: getChecks });
}

/**
 * Прогнать проверку по кнопке. Долгая (внутри — настоящий запуск ассистента),
 * поэтому кнопка обязана показывать ожидание.
 */
export function useRunProviderCheck() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: runCheck,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.providerChecks }),
  });
}
