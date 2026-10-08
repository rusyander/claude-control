import { ApiError } from '../../shared/api/client';

/**
 * Отказ панели «журналы этого CLI аналитика не читает» (409
 * `analytics-provider-unsupported`): текст уже переведён по коду клиентом
 * запросов. У телефона нет гейта возможностей, как у веба, поэтому отказ —
 * единственное, что не даёт показать под goose или kimi расход Claude.
 */
export function analyticsRefusal(error: unknown): string | undefined {
  return error instanceof ApiError && error.status === 409 && error.code === 'provider_unsupported'
    ? error.message
    : undefined;
}
