import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscoveryView, Group, GroupKey, ProjectGroupChoiceView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import type { GroupAdviceResult, GroupOverrideResult } from '../model/types';

// Откуда берутся группы: обнаружение по проектам и общим каталогам, импорт
// находки, копия проектной группы в общие, выбор стороны пары в проекте и файл
// переопределения. Всё вложено в ключ `groups`, поэтому любая правка группы
// освежает и находки, и выбор — отдельной инвалидации тут не нужно.

/** Пока обнаружение идёт, строка прогресса по источникам опрашивается вот так часто. */
const DISCOVERY_POLL_MS = 1_500;

async function getDiscovery(): Promise<DiscoveryView> {
  const { data } = await apiClient.get<DiscoveryView>('/groups/discovery');
  return data;
}

/**
 * Находки обнаружения. Прогресс приходит опросом: сервер отвечает на запуск
 * сразу (202), а по источникам отчитывается в том же GET — пока `running`,
 * страница переспрашивает, потом замолкает.
 */
export function useGroupDiscovery() {
  return useQuery({
    queryKey: queryKeys.groupDiscovery,
    queryFn: getDiscovery,
    refetchInterval: (query) => (query.state.data?.running ? DISCOVERY_POLL_MS : false),
  });
}

export function useRunDiscovery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiClient.post('/groups/discovery/run', {});
    },
    // Сразу помечаем «идёт»: иначе до первого ответа опроса кнопка снова
    // выглядела бы свободной и звала второй прогон.
    onSuccess: () => {
      queryClient.setQueryData<DiscoveryView>(queryKeys.groupDiscovery, (view) =>
        view ? { ...view, running: true } : view,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.groupDiscovery });
    },
  });
}

export function useImportDiscovered() {
  const queryClient = useQueryClient();
  return useMutation({
    // `lang` — язык интерфейса: имя и «Когда» новой группы берутся на нём.
    mutationFn: async ({ key, lang }: { key: string; lang?: 'ru' | 'en' }) => {
      const { data } = await apiClient.post<Group>(
        `/groups/discovery/${encodeURIComponent(key)}/import`,
        lang ? { lang } : {},
      );
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.groups }),
    meta: { successMessage: 'groupSources.imported' },
  });
}

/**
 * Копия проектной группы в общие каталоги провайдера. Ответ — новая группа и
 * советы по каждому участнику; ничего из советов ещё не применено.
 */
export function useCopyToGlobal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; provider: string }) => {
      const { data } = await apiClient.post<GroupAdviceResult>(
        `/groups/${input.id}/copy-to-global`,
        { provider: input.provider },
      );
      return data;
    },
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

/** Предложение агента, как слить правки оригинала в нашу копию. Ничего не пишет. */
export function useMergeOrigin() {
  return useMutation({
    // Отказ окно слияния показывает само — с причиной и «Повторить».
    meta: { silentError: true },
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post<GroupAdviceResult>(`/groups/${id}/merge-origin`, {});
      return data;
    },
  });
}

export function useApplyAdvice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; items: { kind: string; id: string }[] }) => {
      const { data } = await apiClient.post<Group>(`/groups/${input.id}/advice/apply`, {
        items: input.items,
      });
      return data;
    },
    onSuccess: () => invalidateAfterWrite(queryClient),
    meta: { successMessage: 'groupSources.adviceApplied' },
  });
}

async function getChoice(path: string, group?: string): Promise<ProjectGroupChoiceView> {
  const { data } = await apiClient.get<ProjectGroupChoiceView>('/projects/group-choice', {
    params: { path, ...(group ? { group } : {}) },
  });
  return data;
}

/**
 * Какая сторона пары действует в проекте. Выбор у каждой пары свой: `group`
 * (id любой стороны) называет пару для `groupKey`; `choices` — выбор всех пар.
 */
export function useProjectGroupChoice(path: string | undefined, group?: string) {
  return useQuery({
    queryKey: queryKeys.groupChoice(path ?? '', group),
    queryFn: () => getChoice(path ?? '', group),
    enabled: Boolean(path),
  });
}

export function useSetProjectGroupChoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { path: string; groupKey: GroupKey }) => {
      await apiClient.put('/projects/group-choice', input);
    },
    // Выбор одной пары меняет `choices` всех видов проекта. Мутация ждёт их
    // перечитывания: пока оно идёт, переключатель занят, а не показывает старое.
    onSuccess: async (_data, input) => {
      invalidateAfterWrite(queryClient);
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupChoicesOf(input.path) });
    },
    meta: { successMessage: 'toasts.updated' },
  });
}

export function useSetGroupOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; path: string; enabled: boolean }) => {
      const { data } = await apiClient.put<GroupOverrideResult>(`/groups/${input.id}/override`, {
        path: input.path,
        enabled: input.enabled,
      });
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.groups }),
    meta: { successMessage: 'toasts.updated' },
  });
}

/**
 * Копия и применение советов пишут файлы в общие каталоги: устаревают не только
 * группы, но и списки скиллов, правил и хуков.
 */
function invalidateAfterWrite(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const key of [
    queryKeys.groups,
    queryKeys.skills,
    queryKeys.rules,
    queryKeys.hooks,
    queryKeys.overview,
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
