import type { ProjectTestImportFormat, ProjectTestImportResult } from '@agentdeck/contracts';
import { useImportMutation } from './useImportMutation';
import { apiClient } from '@shared/api/client';

export type CasesFormat = Extract<
  ProjectTestImportFormat,
  'csv' | 'xlsx' | 'testrail-csv' | 'markdown'
>;

export interface ImportCasesPayload {
  groupId: string;
  format: CasesFormat;
  content?: string;
  /** Файл внутри проекта; у `markdown` — КАТАЛОГ с ручными кейсами. */
  file?: string;
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
