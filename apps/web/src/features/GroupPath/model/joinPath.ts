/** Склейка пути тем разделителем, каким записана основа: Windows-путь остаётся Windows-путём. */
export function joinPath(base: string, ...parts: string[]): string {
  const separator = base.includes('\\') ? '\\' : '/';
  const trimmed = base.replace(/[\\/]+$/, '');
  return [trimmed, ...parts.filter(Boolean)].join(separator);
}
