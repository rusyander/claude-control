import { useQueryClient, useMutation } from '@tanstack/react-query';
import { CREDENTIALS_KEY } from './CredentialsApi.constants';
import { saveCredentials } from '../lib/saveCredentials';

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
