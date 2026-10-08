import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ProjectTestReleaseDocument } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Готовность вехи одним документом — только чтение.
 *
 * Документ собирается на лету и нигде не хранится: он обязан отвечать на
 * «отдаём или нет» СЕЙЧАС, а сохранённый устаревал бы на первом же прогоне и
 * врал бы ровно там, где на него смотрят.
 *
 * Запрос идёт, только когда веху выбрали: за требованиями сервер ходит в Jira,
 * и платить этим за каждый показ отчёта незачем.
 */
export function useTestRelease(path: string | undefined, release: string | undefined) {
  const { i18n } = useTranslation();
  return useQuery({
    queryKey: testKeys.release(path, release, i18n.language),
    queryFn: async () => {
      const { data } = await apiClient.get<{
        releases: string[];
        document?: ProjectTestReleaseDocument;
      }>('/project-tests/release', { params: { path, release } });
      return data;
    },
    enabled: Boolean(path) && Boolean(release),
  });
}
