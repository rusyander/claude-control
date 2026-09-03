import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { CredentialsStatus } from '../model/credentials.types';

/**
 * Доступ Claude Code к аккаунту — состояние и ручной ввод.
 *
 * Сервер отдаёт только источник и причину: сам токен браузеру не показывается
 * никогда. Ключ кеша общий с карточкой в «Настройках» (`['credentials']`):
 * сохранение из мастера первого запуска обновляет и её, и наоборот.
 */

const CREDENTIALS_KEY = ['credentials'] as const;

async function getCredentials(): Promise<CredentialsStatus> {
  const { data } = await apiClient.get<CredentialsStatus>('/credentials');
  return data;
}

async function saveCredentials(raw: string): Promise<void> {
  await apiClient.post('/credentials', { value: raw });
}

async function clearCredentials(): Promise<void> {
  await apiClient.delete('/credentials');
}

export function useCredentialsStatus() {
  return useQuery({ queryKey: CREDENTIALS_KEY, queryFn: getCredentials });
}

/**
 * Сохранить ручной доступ. Ошибку валидации (не JSON, файл не найден, каталог
 * вместо файла) сервер отвечает 400 с текстом — форма показывает его у поля,
 * поэтому общий тост об ошибке здесь выключен.
 */
export function useSaveCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveCredentials,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
    meta: { silentError: true },
  });
}

export function useClearCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: clearCredentials,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
  });
}
