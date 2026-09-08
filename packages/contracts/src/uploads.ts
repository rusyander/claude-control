/**
 * Вложения чата: ЕДИНСТВЕННЫЙ источник списка поддерживаемых расширений.
 *
 * Список нужен в трёх местах сразу — сервер сохраняет файл на диск и обязан
 * перепроверить его сам, фронт отсеивает неподдерживаемое до отправки (иначе
 * отказ приходит уже после очистки поля ввода), а поле выбора файла подставляет
 * тот же перечень в `accept`. Три копии одного списка расходятся молча: файл
 * проходит проверку фронта и отвергается сервером — или наоборот, диалог выбора
 * его даже не показывает.
 *
 * ВАЖНО про импорт на сервере. Сервер идёт под `node --experimental-strip-types`
 * и ЗНАЧЕНИЯ из бочки `@agentdeck/contracts` брать не может: её реэкспорты
 * без расширений Node не резолвит. Поэтому файл самодостаточен (ни одного
 * импорта) и вынесен в отдельную точку экспорта —
 * `@agentdeck/contracts/uploads`. Не добавлять сюда импорты: сервер
 * перестанет стартовать.
 */

/** Расширения, которые Claude Code читает с диска сам (картинки, PDF, тексты). */
export const SUPPORTED_UPLOAD_EXTENSIONS: readonly string[] = [
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
export function uploadExtensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // Точка в начале — это `.gitignore`, то есть имя, а не расширение.
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Поддерживает ли панель такое вложение. */
export function isSupportedUpload(name: string): boolean {
  return SUPPORTED_UPLOAD_EXTENSIONS.includes(uploadExtensionOf(name));
}

/** Имена вложений, которые панель передать не сможет. */
export function unsupportedUploadNames(files: { name: string }[]): string[] {
  return files.filter((file) => !isSupportedUpload(file.name)).map((file) => file.name);
}

/** Значение атрибута `accept` для поля выбора файла — из того же списка. */
export const UPLOAD_ACCEPT_ATTRIBUTE: string = SUPPORTED_UPLOAD_EXTENSIONS.join(',');

/**
 * Строка, которой сервер отделяет вложения от текста человека в промпте.
 * Claude Code читает файлы с диска сам, поэтому агенту уходят пути; но та же
 * строка оседает в транскрипте как реплика ЧЕЛОВЕКА — и без общего маркера
 * заголовок разговора обрывался на «…Приложен», а в пузыре торчал сырой список
 * абсолютных путей. Маркер один на сервер и фронт: сервер им пишет, фронт и
 * заголовок по нему режут.
 */
export const ATTACHMENTS_MARKER = 'Приложенные файлы (прочитай их):';

export interface AttachmentsSplit {
  /** Текст человека без блока вложений. */
  text: string;
  /** Пути вложений из блока — в порядке перечисления. */
  files: string[];
}

/** Разрезать реплику на собственный текст и список приложенных путей. */
export function splitAttachments(text: string): AttachmentsSplit {
  const at = text.indexOf(ATTACHMENTS_MARKER);
  if (at < 0) return { text, files: [] };
  const files = text
    .slice(at + ATTACHMENTS_MARKER.length)
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  return { text: text.slice(0, at).trimEnd(), files };
}

/** Имя файла из пути вложения — для подписи чипа; путь бывает и Windows, и POSIX. */
export function attachmentBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
