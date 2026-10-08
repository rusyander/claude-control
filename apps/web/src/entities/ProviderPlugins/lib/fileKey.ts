import { queryKeys } from '@shared/api/query-keys';

export function fileKey(path: string, projectId?: string): readonly string[] {
  return projectId
    ? queryKeys.projectProviderPluginFile(projectId, path)
    : queryKeys.providerPluginFile(path);
}
