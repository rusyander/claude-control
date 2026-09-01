import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectGitInfo,
  ProjectGitResult,
  ProjectWorktreesInfo,
  ProjectWorktreesResult,
} from '@claude-control/contracts';
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

/** Состояние репозитория проекта; `isRepo:false` — пульт не показывается. */
export function useProjectGit(path: string | undefined) {
  return useQuery({
    queryKey: keyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectGitInfo>('/project-git', { params: { path } });
      return data;
    },
    enabled: Boolean(path),
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
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
    refetchInterval: 15_000,
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
