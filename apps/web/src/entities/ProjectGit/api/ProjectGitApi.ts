import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectGitInfo,
  ProjectGitResult,
  ProjectWorktreesInfo,
  ProjectWorktreesResult,
  WorktreeBootstrapState,
  WorktreeMirrorSettings,
} from '@agentdeck/contracts';
import type { SplitSettings } from '@agentdeck/contracts/task-split';
import { apiClient } from '@shared/api/client';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Git выбранного проекта: состояние (ветка, список веток, какие файлы изменены,
 * отставание от удалённого) и четыре операции — переключиться, создать ветку,
 * закоммитить, подтянуть чужое.
 *
 * Состояние перечитывается по фокусу окна и с редким поллингом: ветку и файлы
 * человек чаще меняет в терминале и в редакторе, чем здесь, — панель не должна
 * показывать вчерашнюю ветку. Каждая операция возвращает уже НОВОЕ состояние,
 * поэтому кэш обновляется ответом, без лишнего запроса следом.
 */

export const projectGitKey = ['project-git'] as const;

/** Ключ кэша на проект — по нормализованному пути. */
function keyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, path ? normalizeProjectPath(path) : ''];
}

/**
 * Как часто перечитывается состояние репозитория, пока агент работает и пока
 * нет.
 *
 * Пятнадцати секунд достаточно, когда репозиторий меняет человек в терминале, и
 * слишком много, когда его меняет агент в этом же окне: он заводит ветку и
 * коммитит за секунды, а панель до следующего такта показывала бы прежнюю
 * ветку — то есть врала бы ровно в момент, ради которого на неё и смотрят.
 */
const IDLE_INTERVAL_MS = 15_000;
const RUNNING_INTERVAL_MS = 4_000;

/**
 * Состояние репозитория проекта; `isRepo:false` — пульт не показывается.
 * `isRunning` — идёт ли прогон в этом каталоге: от него зависит частота опроса.
 */
export function useProjectGit(path: string | undefined, isRunning = false) {
  return useQuery({
    queryKey: keyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectGitInfo>('/project-git', { params: { path } });
      return data;
    },
    enabled: Boolean(path),
    refetchOnWindowFocus: true,
    refetchInterval: isRunning ? RUNNING_INTERVAL_MS : IDLE_INTERVAL_MS,
  });
}

/** Общая обвязка операции записи: ответ кладём в кэш как новое состояние. */
function useGitAction<TBody extends { path: string }>(url: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody) => {
      const { data } = await apiClient.post<ProjectGitResult>(url, body);
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(keyFor(body.path), result.info);
    },
  });
}

/** Переключиться на существующую локальную ветку. */
export function useCheckoutBranch() {
  return useGitAction<{ path: string; branch: string }>('/project-git/checkout');
}

/** Создать ветку от текущего HEAD и перейти на неё. */
export function useCreateBranch() {
  return useGitAction<{ path: string; name: string }>('/project-git/branch');
}

/** Закоммитить все изменения рабочего дерева. */
export function useCommitAll() {
  return useGitAction<{ path: string; message: string }>('/project-git/commit');
}

/**
 * Подтянуть чужие коммиты. Без `branch` — обычный `git pull` в текущей ветке,
 * с `branch` — из этой ветки удалённого.
 */
export function usePullChanges() {
  return useGitAction<{ path: string; branch?: string }>('/project-git/pull');
}

/**
 * Отправить текущую ветку. Только её и только вперёд: `--force` не передаётся
 * нигде, а ветка без upstream уходит с `--set-upstream` — иначе первый push
 * новой ветки требовал бы терминала.
 */
export function usePushBranch() {
  return useGitAction<{ path: string }>('/project-git/push');
}

/** Ключ кэша списка копий — свой, чтобы состояние репозитория не перезапрашивалось зря. */
function worktreesKeyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, 'worktrees', path ? normalizeProjectPath(path) : ''];
}

/**
 * Параллельные рабочие копии репозитория. Обновляются чаще состояния самого
 * репозитория и по той же причине, по какой список вообще нужен: пока смотришь
 * на него, агент внутри копии мог сменить ветку — показывать ту, что была при
 * создании, значит врать.
 */
export function useProjectWorktrees(path: string | undefined) {
  return useQuery({
    queryKey: worktreesKeyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectWorktreesInfo>('/project-git/worktrees', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    refetchOnWindowFocus: true,
    // Пока в какой-то копии идёт установка, список опрашивается часто: значок
    // «ставится» обязан смениться сам, а не по F5.
    refetchInterval: (query) =>
      query.state.data?.worktrees.some((item) => item.bootstrap?.status === 'running')
        ? 3_000
        : 15_000,
  });
}

/**
 * Общая обвязка операций над копиями: ответ кладём в кэш как новый список, а
 * состояние самого репозитория помечаем устаревшим — набор веток после создания
 * копии другой, и селект переключения обязан это увидеть.
 */
function useWorktreeAction<TBody extends { path: string }>(url: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody) => {
      const { data } = await apiClient.post<ProjectWorktreesResult>(url, body);
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(worktreesKeyFor(body.path), result.info);
      void queryClient.invalidateQueries({ queryKey: keyFor(body.path) });
    },
  });
}

/** Завести копию под ветку: своя папка, своя ветка, общая история. */
export function useAddWorktree() {
  return useWorktreeAction<{ path: string; name: string }>('/project-git/worktrees/add');
}

/**
 * Убрать копию. `force` нужен там, где внутри осталась незакоммиченная работа:
 * без него git отказывается, и это правильный отказ — панель лишь передаёт его
 * человеку и спрашивает ещё раз.
 */
export function useRemoveWorktree() {
  return useWorktreeAction<{ path: string; worktreePath: string; force?: boolean }>(
    '/project-git/worktrees/remove',
  );
}

/**
 * Повторно перенести локальный слой в копию — после правки шаблонов или
 * `.mcp.json` в основной копии. Ответ несёт отчёт: карточка копии его показывает.
 */
export function useMirrorWorktree() {
  return useWorktreeAction<{ path: string; worktreePath: string }>('/project-git/worktrees/mirror');
}

/** Ключ шаблонов зеркала — по основной копии, как и сама запись в хранилище. */
function mirrorSettingsKeyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, 'mirror-settings', path ? normalizeProjectPath(path) : ''];
}

/** Что человек дописал к встроенному списку зеркала на этом проекте. */
export function useMirrorSettings(path: string | undefined) {
  return useQuery({
    queryKey: mirrorSettingsKeyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<WorktreeMirrorSettings>('/project-git/mirror-settings', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}

export function useSaveMirrorSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { path: string } & WorktreeMirrorSettings) => {
      const { data } = await apiClient.put<WorktreeMirrorSettings>(
        '/project-git/mirror-settings',
        body,
      );
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(mirrorSettingsKeyFor(body.path), result);
    },
  });
}

/** Ключ настроек разделения — по основной копии, как и шаблоны зеркала. */
function splitSettingsKeyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, 'split-settings', path ? normalizeProjectPath(path) : ''];
}

/** Разделение на проекте: доводить ли группу до MR и сколько групп идёт разом. */
export function useSplitSettings(path: string | undefined) {
  return useQuery({
    queryKey: splitSettingsKeyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<SplitSettings>('/project-git/split-settings', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}

export function useSaveSplitSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { path: string } & SplitSettings) => {
      const { data } = await apiClient.put<SplitSettings>('/project-git/split-settings', body);
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(splitSettingsKeyFor(body.path), result);
    },
  });
}

/** Повторить бутстрап копии (установку зависимостей) — после провала или смены команды. */
export function useBootstrapWorktree() {
  return useWorktreeAction<{ path: string; worktreePath: string }>(
    '/project-git/worktrees/bootstrap',
  );
}

/** Полный лог последнего бутстрапа копии — по запросу, когда его раскрыли. */
export function useWorktreeBootstrapLog(path: string, worktreePath: string, enabled: boolean) {
  return useQuery({
    queryKey: [...projectGitKey, 'bootstrap-log', normalizeProjectPath(path), worktreePath],
    queryFn: async () => {
      const { data } = await apiClient.get<{ log: string; state: WorktreeBootstrapState | null }>(
        '/project-git/worktrees/bootstrap-log',
        { params: { path, worktreePath } },
      );
      return data;
    },
    enabled,
    // Пока установка идёт, лог растёт — дочитываем.
    refetchInterval: (query) => (query.state.data?.state?.status === 'running' ? 2_000 : false),
  });
}
