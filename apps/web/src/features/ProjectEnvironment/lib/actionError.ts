import axios from 'axios';
import type { TFunction } from 'i18next';
import { toErrorMessage } from '@shared/api/toErrorMessage';

/**
 * Текст отказа действия. Сервер Compose шлёт свой `code` без `messageCode` —
 * тексты здесь, на двух языках; незнакомый код показываем сообщением сервера.
 */
export function composeActionError(error: unknown, t: TFunction): string {
  const data: unknown = axios.isAxiosError(error) ? error.response?.data : undefined;
  const code =
    typeof data === 'object' && data !== null ? (data as { code?: unknown }).code : undefined;
  switch (code) {
    case 'compose-busy':
      return t('environment.errors.busy');
    case 'compose-project-unregistered':
      return t('environment.errors.unregistered');
    case 'compose-file-missing':
      return t('environment.errors.fileMissing');
    case 'compose-service-unknown':
      return t('environment.errors.serviceUnknown');
    default:
      return t('environment.errors.generic', { message: toErrorMessage(error) });
  }
}
