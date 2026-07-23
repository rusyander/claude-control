/**
 * Стоит ли пропустить горячую клавишу: фокус в поле ввода. Проверяем по «утиному»
 * набору свойств, а не через `instanceof HTMLElement`, чтобы логика оставалась
 * чистой и тестировалась без DOM. Учитываем `input`, `textarea`, `select` и
 * любой contenteditable-контейнер.
 */
interface EditableLike {
  tagName?: string;
  isContentEditable?: boolean;
}

export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as EditableLike;

  if (element.isContentEditable) return true;

  const tag = element.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
