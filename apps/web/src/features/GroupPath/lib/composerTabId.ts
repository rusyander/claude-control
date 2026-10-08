import type { ComposerMode } from '../ui/ComposerModes/ComposerModes.types';

export function composerTabId(idBase: string, mode: ComposerMode): string {
  return `${idBase}-tab-${mode}`;
}
