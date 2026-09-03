import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DlpInfo,
  DlpJournalEntry,
  DlpPreviewResult,
  DlpRule,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getDlp(): Promise<DlpInfo> {
  const { data } = await apiClient.get<DlpInfo>('/dlp');
  return data;
}

async function getJournal(): Promise<DlpJournalEntry[]> {
  const { data } = await apiClient.get<{ entries: DlpJournalEntry[] }>('/dlp/journal');
  return data.entries;
}

async function saveRules(rules: DlpRule[]): Promise<void> {
  await apiClient.put('/dlp/rules', { rules });
}

async function preview(input: { text: string; rules?: DlpRule[] }): Promise<DlpPreviewResult> {
  const { data } = await apiClient.post<DlpPreviewResult>('/dlp/preview', input);
  return data;
}

async function setRunning(running: boolean): Promise<DlpInfo> {
  const { data } = await apiClient.post<DlpInfo>(running ? '/dlp/start' : '/dlp/stop');
  return data;
}

async function clearJournal(): Promise<void> {
  await apiClient.delete('/dlp/journal');
}

/**
 * Пока слушатель работает, счётчики и журнал растут без участия панели — CLI
 * ходит через прокси сам. Опрашиваем раз в несколько секунд, иначе раздел
 * показывал бы «запросов: 0» до F5, как будто через прокси ничего не идёт.
 */
const LIVE_INTERVAL_MS = 4000;

/** Настройки, правила и состояние прокси. В сеть этот запрос не ходит. */
export function useDlp() {
  return useQuery({
    queryKey: queryKeys.dlp,
    queryFn: getDlp,
    refetchInterval: (query) => (query.state.data?.status.running ? LIVE_INTERVAL_MS : false),
  });
}

/**
 * Лента срабатываний. Отдельным запросом: сводка открывается один раз, а лента
 * интересна именно свежая — при работающем прокси она обновляется сама.
 */
export function useDlpJournal(enabled: boolean, live = false) {
  return useQuery({
    queryKey: queryKeys.dlpJournal,
    queryFn: getJournal,
    enabled,
    refetchInterval: enabled && live ? LIVE_INTERVAL_MS : false,
  });
}

export function useSaveDlpRules() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveRules,
    // Промис возвращается намеренно: страница сбрасывает черновик в своём
    // onSuccess, и к тому моменту в кеше уже должны лежать новые правила —
    // иначе черновик пересеялся бы старыми.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dlp }),
  });
}

/**
 * Проверка правил на пробном тексте — без сети и без записи. Правила можно
 * прислать черновиком: смотреть результат ДО сохранения важнее, чем после.
 */
export function useDlpPreview() {
  return useMutation({ mutationFn: preview });
}

export function useSetDlpRunning() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: setRunning,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.dlp, info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dlpJournal });
    },
  });
}

export function useClearDlpJournal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: clearJournal,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dlpJournal }),
  });
}
