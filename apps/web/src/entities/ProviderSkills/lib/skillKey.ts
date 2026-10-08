import { queryKeys } from '@shared/api/query-keys';

export function skillKey(path: string, projectId?: string): readonly string[] {
  return projectId
    ? queryKeys.projectProviderSkill(projectId, path)
    : queryKeys.providerSkill(path);
}
