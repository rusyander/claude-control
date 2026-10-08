export function basePath(projectId?: string): string {
  return projectId ? `/projects/${projectId}/provider/plugins` : '/provider-plugins';
}
