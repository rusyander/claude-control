/** Кодируем каждый сегмент, но сохраняем слэши: id скрипта может быть вложенным путём. */
export function encodeScriptId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}
