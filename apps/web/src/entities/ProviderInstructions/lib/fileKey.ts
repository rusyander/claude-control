import { queryKeys } from '@shared/api/query-keys';

export function fileKey(raw: string, projectId?: string): readonly string[] {
  return projectId
    ? queryKeys.projectProviderInstructionsListFile(projectId, raw)
    : queryKeys.providerInstructionsFile(raw);
}
