/**
 * Проверка вложений ДО отправки.
 *
 * Последнее слово всё равно за сервером (он же и кладёт файлы на диск), но
 * отказ, пришедший ответом на запрос, приходит уже после того, как поле ввода
 * очищено, а чипы вложений сняты, — человеку остаётся набирать сообщение и
 * прикладывать файлы заново. Поэтому неподдерживаемое отсеиваем на месте: текст
 * и чипы остаются нетронутыми, а сообщение об отказе появляется мгновенно и без
 * загрузки в сеть двадцати мегабайт base64.
 *
 * Список зеркалит белый список сервера (`ChatUploads.ts`) — там же он
 * перепроверяется, так что расхождение обернётся отказом, а не молчаливой
 * потерей файла.
 */
export const SUPPORTED_UPLOAD_EXTENSIONS: string[] = [
  '.css',
  '.csv',
  '.gif',
  '.html',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.md',
  '.pdf',
  '.png',
  '.py',
  '.ts',
  '.tsx',
  '.txt',
  '.webp',
  '.yaml',
  '.yml',
];

/** Расширение имени файла в нижнем регистре; без точки — пустая строка. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // Точка в начале — это `.gitignore`, то есть имя, а не расширение.
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function isSupportedUpload(name: string): boolean {
  return SUPPORTED_UPLOAD_EXTENSIONS.includes(extensionOf(name));
}

/** Имена вложений, которые панель передать не сможет. */
export function unsupportedUploadNames(files: { name: string }[]): string[] {
  return files.filter((file) => !isSupportedUpload(file.name)).map((file) => file.name);
}
