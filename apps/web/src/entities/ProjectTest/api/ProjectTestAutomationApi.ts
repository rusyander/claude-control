import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectTestAdoptResult,
  ProjectTestAutomationCommand,
  ProjectTestAutomationInfo,
  ProjectTestsView,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Своя команда прогона проекта (`.agent/tests/automation.json`) и готовые
 * рецепты бэкенда, найденные по файлам проекта.
 *
 * Рецепты — отдельным запросом, а не в виде раздела: сервер обходит каталоги и
 * ищет программы в PATH, а вид раздела опрашивается каждые две секунды, пока
 * идёт прогон. Сама команда едет и в виде (`view.automation`) — запись и снятие
 * возвращают вид целиком, карточка прогона видит новую строку тем же кадром.
 */
export function useTestAutomation(path: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: testKeys.automation(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestAutomationInfo>('/project-tests/automation', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && enabled,
    staleTime: 60_000,
  });
}

function useAutomationMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestsView>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (view) => {
      client.setQueryData(testKeys.view(path), view);
      void client.invalidateQueries({ queryKey: testKeys.automation(path) });
    },
  });
}

/** Записать команду: те же правила, что у чтения, негодная — отказ 400 словами. */
export function useSaveTestAutomation(path: string | undefined) {
  return useAutomationMutation(path, async (automation: ProjectTestAutomationCommand) => {
    const { data } = await apiClient.put<ProjectTestsView>('/project-tests/automation', {
      path,
      ...automation,
    });
    return data;
  });
}

/** Убрать команду: файл откладывается рядом (`automation.removed.json`), а не стирается. */
export function useRemoveTestAutomation(path: string | undefined) {
  return useAutomationMutation(path, async (_: void) => {
    const { data } = await apiClient.delete<ProjectTestsView>('/project-tests/automation', {
      params: { path },
    });
    return data;
  });
}

/**
 * «Завести кейсы» для тестов последнего прогона без кейса. Новые кейсы меняют
 * отчёт и покрытие — их ключи сбрасываются вместе с видом.
 */
export function useAdoptE2eTests(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (_: void) => {
      const { data } = await apiClient.post<{
        adopt: ProjectTestAdoptResult;
        view: ProjectTestsView;
      }>('/project-tests/e2e/adopt', { path });
      return data;
    },
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data.view);
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
      void client.invalidateQueries({ queryKey: testKeys.lint(path) });
    },
  });
}
