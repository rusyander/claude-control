import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RecordedRecordBody,
  RecordedRecordReply,
  RecordedReplayState,
  RecordedVerdict,
  RecordedView,
  RecordedWalkReply,
} from '@agentdeck/contracts';
import type { WalkReply } from '@agentdeck/contracts/core/browse';
import { apiClient } from '@shared/api/client';
import { coreGet } from '@entities/CoreTask';

/**
 * Записанные проходы вкладки «Сценарии»: список с полоской прогонов, запись прохода ядра,
 * «Прогнать все» и решение по расхождению. Ключ — под корнем `project-tests`: общий сброс
 * кэша тестов (новый прогон, правка кейса) перечитывает и этот список.
 */

/** Как часто перечитывать, пока идёт «Прогнать все» или проход ядра. */
export const RECORDED_POLL_MS = 2000;

/** Ошибку каждой ручки вкладка показывает на месте — второй тост повторил бы тот же текст. */
const INLINE_ERROR = { silentError: true };

const recordedKey = (path: string | undefined) => ['project-tests', 'recorded', path ?? ''];
const walkKey = (taskId: string | undefined) => ['project-tests', 'recorded-walk', taskId ?? ''];

export function useRecorded(path: string | undefined) {
  return useQuery({
    queryKey: recordedKey(path),
    queryFn: async () => {
      const { data } = await apiClient.get<RecordedView>('/project-tests/recorded', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    // Прогон идёт в фоне сервера: пока он не кончился, список и карточка расхождения
    // перечитываются сами — иначе человек смотрел бы на «идёт» до F5.
    refetchInterval: (query) =>
      query.state.data?.replay?.status === 'running' ? RECORDED_POLL_MS : false,
  });
}

/** Строки прохода задачи ядра; перечитываются, пока задача не кончилась. */
export function useWalkRows(taskId: string | undefined) {
  return useQuery({
    queryKey: walkKey(taskId),
    queryFn: () => coreGet<WalkReply>('/tasks/:id/walk', { id: taskId ?? '' }),
    enabled: Boolean(taskId),
    refetchInterval: (query) => (query.state.data?.ended ? false : RECORDED_POLL_MS),
  });
}

/**
 * Начатый, но не записанный проход проекта — в `sessionStorage` вкладки: закрытое окно или F5 не
 * теряют платную задачу ядра. Хранилище недоступно (приватный режим) — проход живёт до закрытия
 * вкладки раздела, как раньше.
 */
export const keptWalk = {
  key: (path: string | undefined) => `agentdeck.recorded-walk:${path ?? ''}`,
  read(path: string | undefined): string | undefined {
    try {
      return sessionStorage.getItem(keptWalk.key(path)) ?? undefined;
    } catch {
      return undefined;
    }
  },
  write(path: string | undefined, taskId: string | undefined): void {
    try {
      if (taskId) sessionStorage.setItem(keptWalk.key(path), taskId);
      else sessionStorage.removeItem(keptWalk.key(path));
    } catch {
      // Хранилища нет — проход держит только состояние окна.
    }
  },
};

export function useStartWalk(path: string | undefined) {
  return useMutation({
    meta: INLINE_ERROR,
    mutationFn: async (input: { goal: string; environmentId?: string; lang: 'ru' | 'en' }) => {
      const { data } = await apiClient.post<RecordedWalkReply>('/project-tests/recorded/walk', {
        path,
        ...input,
      });
      return data;
    },
  });
}

export function useRecordWalk(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR,
    mutationFn: async (body: Omit<RecordedRecordBody, 'path'>) => {
      const { data } = await apiClient.post<RecordedRecordReply>('/project-tests/recorded', {
        path,
        ...body,
      });
      return data;
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: ['project-tests'] }),
  });
}

export function useStartReplay(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR,
    mutationFn: async (input: { environmentId?: string; lang: 'ru' | 'en' }) => {
      const { data } = await apiClient.post<RecordedReplayState>('/project-tests/recorded/replay', {
        path,
        ...input,
      });
      return data;
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: recordedKey(path) }),
  });
}

export function useRecordedVerdict(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR,
    mutationFn: async (verdict: RecordedVerdict) => {
      const { data } = await apiClient.post<RecordedReplayState>(
        '/project-tests/recorded/verdict',
        { path, verdict },
      );
      return data;
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: recordedKey(path) }),
  });
}
