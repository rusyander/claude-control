import { useQuery } from '@tanstack/react-query';
import type {
  ProjectTestHistoryEntry,
  ProjectTestImpact,
  ProjectTestReport,
  ProjectTestRunDiff,
  ProjectTestRunRecord,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { TESTS_POLL_MS, testKeys } from './keys';

/**
 * История прогонов, отдельная запись, отчёт и отбор по диффу — только чтение.
 *
 * Записи прогонов пишет прогон, а не панель, поэтому здесь нет ни одной
 * мутации: история — журнал, из которого ничего не правят руками. Пока прогон
 * идёт, список перечитывается — новая запись должна проступить сама.
 */

export function useTestRuns(path: string | undefined, isEnabled = true, isRunning = false) {
  return useQuery({
    queryKey: testKeys.runs(path),
    queryFn: async () => {
      const { data } = await apiClient.get<{ runs: ProjectTestRunRecord[] }>(
        '/project-tests/runs',
        { params: { path, limit: 50 } },
      );
      return data.runs;
    },
    enabled: Boolean(path) && isEnabled,
    refetchInterval: isRunning && isEnabled ? TESTS_POLL_MS : false,
  });
}

export function useTestRun(path: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: testKeys.run(path, id),
    queryFn: async () => {
      const { data } = await apiClient.get<{ run: ProjectTestRunRecord }>('/project-tests/run', {
        params: { path, id },
      });
      return data.run;
    },
    enabled: Boolean(path) && Boolean(id),
  });
}

/**
 * Что изменилось с прошлого прогона.
 *
 * Запрос идёт, только когда сравнение открыли: считать дифф на каждый показ
 * истории — платить за ответ, которого никто не спрашивал. Ошибку («это первый
 * прогон») показывает сам блок сравнения, поэтому повторы здесь выключены.
 */
export function useTestRunDiff(
  path: string | undefined,
  id: string | undefined,
  baseId?: string,
  isEnabled = true,
) {
  return useQuery({
    queryKey: testKeys.diff(path, id, baseId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestRunDiff>('/project-tests/run/diff', {
        params: { path, id, baseId },
      });
      return data;
    },
    enabled: Boolean(path) && Boolean(id) && isEnabled,
    retry: false,
  });
}

export function useTestReport(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.report(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestReport>('/project-tests/report', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

/**
 * История файла группы из git: кто и когда правил кейсы.
 *
 * Своего версионирования у раздела нет намеренно — кейсы лежат в репозитории
 * проекта, и git отвечает на этот вопрос вместе с ревью и откатом. Запрос идёт
 * только когда историю открыли: `git log` на каждый показ библиотеки был бы
 * платой ни за что.
 */
export function useTestHistory(
  path: string | undefined,
  groupId: string | undefined,
  isEnabled = true,
) {
  return useQuery({
    queryKey: testKeys.history(path, groupId),
    queryFn: async () => {
      const { data } = await apiClient.get<{ entries: ProjectTestHistoryEntry[] }>(
        '/project-tests/history',
        { params: { path, groupId } },
      );
      return data.entries;
    },
    enabled: Boolean(path) && Boolean(groupId) && isEnabled,
  });
}

/** Кейсы, задетые правками рабочей копии, — основа кнопки «только изменённое». */
export function useTestImpact(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.impact(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestImpact>('/project-tests/impact', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
