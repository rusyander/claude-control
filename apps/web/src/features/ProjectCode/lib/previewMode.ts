import type { ProjectFileContent } from '@claude-control/contracts';

/** Вкладка правой половины окна: исходник или показ файла. */
export type CodeTab = 'code' | 'preview';

/** Что рисовать в правой половине: редактор, показ файла или объяснение. */
export type CodeBody = 'editor' | 'preview' | 'placeholder';

/** Показуемо ли не текстом. Слишком большой файл не показуем ничем. */
export function canPreview(file: ProjectFileContent | undefined): boolean {
  return Boolean(file?.preview) && !file?.tooBig;
}

/** Есть ли исходник, который можно открыть в редакторе. */
export function canEditText(file: ProjectFileContent | undefined): boolean {
  return Boolean(file) && !file?.isBinary && !file?.tooBig;
}

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

/**
 * Что показать, с учётом того, что у файла может не быть второй стороны:
 * у картинки нет исходника, у обычного кода — показа.
 */
export function bodyKind(file: ProjectFileContent | undefined, tab: CodeTab): CodeBody {
  if (!file) return 'placeholder';
  if (tab === 'preview' && canPreview(file)) return 'preview';
  if (canEditText(file)) return 'editor';
  return 'placeholder';
}

/** Есть ли что переключать: обе стороны существуют только у SVG и разметки. */
export function hasBothSides(file: ProjectFileContent | undefined): boolean {
  return canPreview(file) && canEditText(file);
}
