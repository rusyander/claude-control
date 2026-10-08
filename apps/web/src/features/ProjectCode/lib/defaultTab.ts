import type { ProjectFileContent } from '@agentdeck/contracts';
import type { CodeTab } from './previewMode.types';
import { canPreview } from './previewMode';

/**
 * Вкладка, с которой открывается файл: показ, если он есть.
 *
 * Одно правило на все форматы, без исключения для разметки: файл, у которого
 * есть вид, человек открывает чтобы этот вид увидеть, а исходник — в один
 * щелчок рядом.
 */
export function defaultTab(file: ProjectFileContent | undefined): CodeTab {
  return canPreview(file) ? 'preview' : 'code';
}
