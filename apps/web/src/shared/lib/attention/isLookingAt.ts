/** Смотрит ли человек на панель: окно на виду и в фокусе. */
export function isLookingAt(doc: Pick<Document, 'visibilityState' | 'hasFocus'>): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus();
}
