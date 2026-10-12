import axios from 'axios';
import type { TFunction } from 'i18next';
import { toErrorMessage } from '@shared/api/toErrorMessage';

/**
 * Отказ маршрутов вкладки «Логи» → текст. Сервер шлёт `code` (и `detail` —
 * что сказал docker) без `messageCode`: тексты здесь, на двух языках.
 */

interface ErrorBody {
  code?: string;
  detail?: string;
  message?: string;
}

const bodyOf = (error: unknown): ErrorBody => {
  const data: unknown = axios.isAxiosError(error) ? error.response?.data : undefined;
  return typeof data === 'object' && data !== null ? (data as ErrorBody) : {};
};

export const logsErrorCode = (error: unknown): string | undefined => bodyOf(error).code;

export function logsErrorText(error: unknown, t: TFunction): string {
  const body = bodyOf(error);
  switch (body.code) {
    case 'logs-project-unregistered':
      return t('environment.logs.errors.unregistered');
    case 'logs-docker-failed':
      return t('environment.logs.errors.docker', { detail: body.detail ?? body.message ?? '' });
    case 'logs-source-unknown':
      return t('environment.logs.errors.sourceGone');
    default:
      return t('environment.logs.errors.generic', {
        message: body.message ?? toErrorMessage(error),
      });
  }
}
