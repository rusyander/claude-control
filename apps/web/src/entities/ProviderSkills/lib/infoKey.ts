import { queryKeys } from '@shared/api/query-keys';

export function infoKey(projectId?: string): readonly string[] {
  return projectId ? queryKeys.projectProviderSkills(projectId) : queryKeys.providerSkills;
}
