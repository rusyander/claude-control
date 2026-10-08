import { useQuery } from '@tanstack/react-query';
import type { ProjectTestBaseline } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Сверка скриншотов с эталоном.
 *
 * Эталон живёт в проверяемом проекте (`.agent/tests/baselines/<кейс>/<точка>.png`),
 * как и всё остальное про кейсы: панель ничего своего не хранит, а история
 * эталонов — это история репозитория.
 *
 * Сами картинки тянутся обычной ссылкой на файл проекта, а не через этот
 * маршрут: браузер грузит их сам, и собирать их в памяти вкладки, чтобы потом
 * освобождать, незачем. Здесь только ПРИГОВОР сравнения: где эталон, где
 * свежий снимок, где разница и насколько она велика.
 */

export function useTestBaselines(path: string | undefined, caseId: string | undefined) {
  return useQuery({
    queryKey: [...testKeys.root, 'baselines', path ?? '', caseId ?? ''],
    queryFn: async (): Promise<ProjectTestBaseline[]> => {
      const { data } = await apiClient.get<{ baselines: ProjectTestBaseline[] }>(
        '/project-tests/baselines',
        { params: { path, caseId } },
      );
      return data.baselines;
    },
    enabled: Boolean(path) && Boolean(caseId),
  });
}
