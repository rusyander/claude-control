import axios from 'axios';
import type { TFunction } from 'i18next';
import { toErrorMessage } from '@shared/api/toErrorMessage';

/**
 * Отказ маршрутов вкладки «API» → текст. Сервер шлёт `code` и `kind` (и
 * `detail` — код сети, порт) без `messageCode`: тексты здесь, на двух языках.
 */

interface ErrorBody {
  code?: string;
  kind?: string;
  detail?: string;
  message?: string;
}

export function apiErrorCode(error: unknown): string | undefined {
  const data: unknown = axios.isAxiosError(error) ? error.response?.data : undefined;
  return typeof data === 'object' && data !== null
    ? ((data as { code?: unknown }).code as string | undefined)
    : undefined;
}

/**
 * Сетевой отказ по коду Node → своя причина. «Он запущен? Порт тот?» верно
 * только для отказа в соединении: имя, которого нет в DNS, или чужой
 * сертификат — другое дело, и совет про порт там уводит в сторону.
 */
function connectKind(code: string): 'dns' | 'refused' | 'tls' | 'reset' | 'connect' {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'reset';
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_TLS|ERR_SSL/.test(code)) return 'tls';
  return 'connect';
}

export function apiErrorText(error: unknown, t: TFunction): string {
  const data: unknown = axios.isAxiosError(error) ? error.response?.data : undefined;
  const body: ErrorBody = typeof data === 'object' && data !== null ? (data as ErrorBody) : {};
  const message = body.message ?? toErrorMessage(error);
  const detail = body.detail ?? '';
  switch (body.code) {
    case 'api-send-failed':
      if (body.kind === 'bad-url' && detail === 'bad-port')
        return t('environment.api.errors.badPort');
      if (body.kind === 'connect' || body.kind === undefined) {
        // Сервер пишет «<код> <хост>» — хост берём оттуда же.
        const host = message.startsWith(`${detail} `) ? message.slice(detail.length + 1) : '';
        const kind = detail ? connectKind(detail) : 'connect';
        return t(`environment.api.errors.send.${host ? kind : 'connect'}`, {
          detail,
          host,
          message,
        });
      }
      return t(`environment.api.errors.send.${body.kind ?? 'connect'}`, { detail, message });
    case 'api-spec-failed':
      return t(`environment.api.errors.spec.${body.kind ?? 'unreadable'}`, { message });
    case 'api-project-unregistered':
      return t('environment.api.errors.unregistered');
    case 'api-not-postman':
      return t('environment.api.errors.notPostman');
    case 'api-source-not-removable':
      return t('environment.api.errors.notRemovable');
    default:
      return t('environment.api.errors.generic', { message });
  }
}
