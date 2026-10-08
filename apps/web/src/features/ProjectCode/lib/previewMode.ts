import type { ProjectFileContent } from '@agentdeck/contracts';

/** Показуемо ли не текстом. Слишком большой файл не показуем ничем. */
export function canPreview(file: ProjectFileContent | undefined): boolean {
  return Boolean(file?.preview) && !file?.tooBig;
}
