import type { ProjectTestImportFormat, ProjectTestImportResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useImportMutation } from './useImportMutation';

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

export interface ImportResultsPayload {
  format: ResultsFormat;
  content?: string;
  file?: string;
  environmentId?: string;
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
