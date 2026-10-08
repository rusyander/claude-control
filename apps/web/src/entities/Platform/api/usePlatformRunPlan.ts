import type { PlatformRunPlan } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Чем пойдёт прогон этого потребителя. Короткий ответ вместо карточек: шапке
 * чата нужна одна строка, а карточка везёт каталог, пробу и учёт расхода.
 */
export async function getRunPlan(consumer: string): Promise<PlatformRunPlan> {
  const { data } = await apiClient.get<PlatformRunPlan>(
    `/platform-run-plan/${encodeURIComponent(consumer)}`,
  );
  return data;
}

/**
 * Чем пойдёт прогон этого потребителя: модель контура и принимает ли он усилие.
 *
 * Спрашивает шапка чата — там человек выбирает модель, и показать ему выбор,
 * который по дороге будет заменён, значит соврать. Запрос дешёвый и без сети:
 * решение принимается по состоянию панели.
 */
export function usePlatformRunPlan(consumer: string) {
  return useQuery({
    queryKey: queryKeys.platformRunPlan(consumer),
    queryFn: () => getRunPlan(consumer),
    // Пустой потребитель — это «страница ещё не знает, чей это чат» (провайдер
    // разговора приезжает своим запросом), а не потребитель с пустым именем:
    // такой адрес сервер не знает вовсе.
    enabled: consumer !== '',
  });
}
