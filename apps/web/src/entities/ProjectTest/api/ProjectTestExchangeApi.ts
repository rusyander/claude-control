import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  IntegrationPublishResult,
  ProjectTestImportFormat,
  ProjectTestImportResult,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Обмен с внешним миром: результаты из CI, кейсы из таблиц, выгрузка группы.
 *
 * Файл уходит либо содержимым, либо ПУТЁМ внутри проекта. Путь здесь важнее:
 * отчёт CI лежит в самом репозитории (`test-results/junit.xml`), и заставлять
 * человека открывать его и копировать в поле значило бы просить сделать руками
 * то, что сервер и так умеет прочитать сам.
 *
 * Импорт меняет статусы кейсов и заводит запись прогона, поэтому сбрасывается
 * всё поддерево: библиотека, история и отчёт читают одни и те же файлы.
 */

/** Отчёты прогонов и таблицы кейсов — разные половины одного списка форматов. */
export type ResultsFormat = Extract<ProjectTestImportFormat, 'junit' | 'playwright' | 'allure'>;
export type CasesFormat = Extract<ProjectTestImportFormat, 'csv' | 'xlsx' | 'testrail-csv'>;

export interface ImportResultsPayload {
  format: ResultsFormat;
  content?: string;
  file?: string;
  environmentId?: string;
}

export interface ImportCasesPayload {
  groupId: string;
  format: CasesFormat;
  content?: string;
  file?: string;
}

function useImportMutation<TPayload>(
  send: (payload: TPayload) => Promise<ProjectTestImportResult>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => void client.invalidateQueries({ queryKey: testKeys.root }),
  });
}

export function useImportTestResults(path: string | undefined) {
  return useImportMutation(async (payload: ImportResultsPayload) => {
    const { data } = await apiClient.post<ProjectTestImportResult>(
      '/project-tests/import/results',
      { path, ...payload },
    );
    return data;
  });
}

export function useImportTestCases(path: string | undefined) {
  return useImportMutation(async (payload: ImportCasesPayload) => {
    const { data } = await apiClient.post<ProjectTestImportResult>('/project-tests/import/cases', {
      path,
      ...payload,
    });
    return data;
  });
}

/**
 * Адрес выгрузки — обычная ссылка, а не запрос из кода: браузер сам покажет
 * диалог сохранения с именем файла из `Content-Disposition`, а собранный в
 * памяти blob пришлось бы ещё и освобождать.
 */
export function exportUrl(
  path: string | undefined,
  groupId: string,
  format: 'csv' | 'md' | 'xlsx',
): string {
  const query = new URLSearchParams({ path: path ?? '', groupId, format });
  return `/api/project-tests/export?${query.toString()}`;
}

/**
 * Адрес отчёта по одному прогону. Отдельно от выгрузки кейсов: там срез набора
 * «как он выглядит сейчас», здесь событие «вот что было в этот раз».
 */
export function runExportUrl(
  path: string | undefined,
  id: string,
  format: RunExportFormat,
): string {
  const query = new URLSearchParams({ path: path ?? '', id, format });
  return `/api/project-tests/run/export?${query.toString()}`;
}

/**
 * PDF рядом с md и csv: отчёт уходит приёмке и заказчику, а туда посылают не
 * markdown. Рисует его браузер, найденный на машине, — нет браузера, сервер
 * честно отвечает отказом, и ссылка приводит к его тексту, а не к битому файлу.
 */
export type RunExportFormat = 'md' | 'csv' | 'pdf';

/** Куда публикуется отчёт прогона: страницей Confluence или комментарием в Jira. */
export type PublishTarget = 'confluence' | 'jira';

/**
 * Публикация отчёта наружу.
 *
 * Отдельно от выгрузки файлом: файл человек уносит сам, а публикация пишет в
 * ЧУЖУЮ систему — и делается только по явному нажатию, с адресом созданного в
 * ответе. Куда именно писать, решает привязка проекта, а не эта кнопка.
 */
export function usePublishTestRun(path: string | undefined) {
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      target: PublishTarget;
    }): Promise<IntegrationPublishResult> => {
      const { data } = await apiClient.post<IntegrationPublishResult>(
        '/project-tests/run/publish',
        { path, ...payload },
      );
      return data;
    },
  });
}
