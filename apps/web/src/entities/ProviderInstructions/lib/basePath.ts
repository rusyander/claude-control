export function basePath(projectId?: string): string {
  return projectId ? `/projects/${projectId}/provider/instructions-list` : '/provider-instructions';
}
