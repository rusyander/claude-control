import { useQuery } from '@tanstack/react-query';
import { ROOT_KEY } from './ProjectFileApi.constants';
import { apiClient } from '@shared/api/client';
import type { ProjectCodeView } from '@agentdeck/contracts';

/**
 * Что было открыто в окне кода этого проекта.
 *
 * Снимок хранится на сервере, в состоянии панели: у каждого таба своё дерево и
 * свой файл, и терять их при чистке кэша браузера незачем. Перезапрашивать
 * нечего — записываем сюда только мы сами, поэтому свежесть бесконечная.
 */
export function useProjectCodeView(path: string | undefined) {
  return useQuery({
    queryKey: [ROOT_KEY, 'view', path ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectCodeView | null>('/project-files/view', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // Повтор здесь только тормозит открытие: эндпоинт локальный, а отказ по
    // нему означает «снимка не будет», а не «попробуй ещё раз». Окно ждёт
    // ответа, чтобы не затереть сохранённое, — и ждать лишний круг незачем.
    retry: false,
  });
}
