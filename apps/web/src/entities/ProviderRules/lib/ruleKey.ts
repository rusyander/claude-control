import { queryKeys } from '@shared/api/query-keys';

export function ruleKey(path: string, projectId?: string): readonly string[] {
  return projectId ? queryKeys.projectProviderRule(projectId, path) : queryKeys.providerRule(path);
}
