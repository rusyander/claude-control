import { queryKeys } from '@shared/api/query-keys';

export function listKey(projectId?: string): readonly string[] {
  return projectId ? queryKeys.projectProviderRules(projectId) : queryKeys.providerRules;
}
