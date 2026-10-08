import type { ProviderCheckResult } from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function runCheck(input: {
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
 * Прогнать проверку по кнопке. Долгая (внутри — настоящий запуск ассистента),
 * поэтому кнопка обязана показывать ожидание.
 */
export function useRunProviderCheck() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: runCheck,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.providerChecks }),
  });
}
