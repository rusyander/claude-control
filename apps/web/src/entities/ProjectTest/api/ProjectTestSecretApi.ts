import { useQuery } from '@tanstack/react-query';
import type { ProjectTestSecretsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Доступы стенда: логин, пароль, токен для прогона против настоящего окружения.
 *
 * Значение уходит на сервер и НЕ возвращается: ответ несёт только маску и
 * признак «задан». Поэтому здесь нет ни кэша значений, ни попытки показать
 * сохранённое в поле ввода — заменить можно, подсмотреть нельзя.
 *
 * Ответ записи несёт ещё и полный вид раздела: объявление доступа меняет файл
 * окружений проекта, и список окружений на экране обязан обновиться тем же
 * ответом, а не следующим запросом.
 */

export function useEnvSecrets(path: string | undefined, environmentId: string | undefined) {
  return useQuery({
    queryKey: testKeys.secrets(path, environmentId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestSecretsView>('/project-tests/env-secrets', {
        params: { path, environmentId },
      });
      return data;
    },
    enabled: Boolean(path) && Boolean(environmentId),
  });
}
