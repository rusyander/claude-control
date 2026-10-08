import { queryKeys } from '@shared/api/query-keys';

export function listKey(projectId?: string): readonly string[] {
  return projectId
    ? queryKeys.projectProviderInstructionsList(projectId)
    : queryKeys.providerInstructions;
}
