import type { ProjectFileContent } from '@agentdeck/contracts';

/** Есть ли исходник, который можно открыть в редакторе. */
export function canEditText(file: ProjectFileContent | undefined): boolean {
  return Boolean(file) && !file?.isBinary && !file?.tooBig;
}
