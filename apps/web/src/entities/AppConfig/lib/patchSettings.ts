import type { AppSettings, AppSettingsPatch } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Предел тела `keepalive`-запроса у браузера — 64 КБ на все такие запросы страницы;
 * берём с запасом. Патч больше (длинный список профилей) уходит обычным запросом.
 */
const KEEPALIVE_BODY_LIMIT = 48_000;

/**
 * PATCH настроек переживает перезагрузку страницы (`keepalive`). Первый PATCH проходит
 * ворота «только человек» (`human-only.ts`), а они читают таблицы ОС — до ~3 с на
 * нагруженной машине. F5 в это окно обрывал обычный запрос, и правка, уже видная на
 * экране, на сервер не доходила. Запрос с `keepalive` браузер доводит и после ухода со
 * страницы; новая страница узнаёт итог из потока событий (`refreshSettingsFromServer`).
 */
export async function patchSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  const keepalive = JSON.stringify(patch).length < KEEPALIVE_BODY_LIMIT;
  const { data } = await apiClient.patch<AppSettings>(
    '/settings',
    patch,
    keepalive ? { adapter: 'fetch', fetchOptions: { keepalive: true } } : undefined,
  );
  return data;
}
