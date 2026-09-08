import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectTestSecretsView, ProjectTestsView } from '@agentdeck/contracts';
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

/** Ответ записи: доступы окружения плюс пересобранный вид раздела. */
type SecretsResponse = ProjectTestSecretsView & { view: ProjectTestsView };

function useSecretMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<SecretsResponse>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => {
      client.setQueryData(testKeys.secrets(path, data.environmentId), {
        environmentId: data.environmentId,
        secrets: data.secrets,
      });
      client.setQueryData(testKeys.view(path), data.view);
    },
  });
}

export interface SaveEnvSecretPayload {
  environmentId: string;
  name: string;
  title?: string;
  /** Не передано — меняется только подпись; пустая строка стирает значение. */
  value?: string;
}

export function useSaveEnvSecret(path: string | undefined) {
  return useSecretMutation(path, async (payload: SaveEnvSecretPayload) => {
    const { data } = await apiClient.post<SecretsResponse>('/project-tests/env-secret', {
      path,
      ...payload,
    });
    return data;
  });
}

export function useRemoveEnvSecret(path: string | undefined) {
  return useSecretMutation(path, async (payload: { environmentId: string; name: string }) => {
    const { data } = await apiClient.delete<SecretsResponse>('/project-tests/env-secret', {
      params: { path, ...payload },
    });
    return data;
  });
}
