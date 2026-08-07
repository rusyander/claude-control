import { readFileSync, statSync } from 'node:fs';
import type { ProjectFilePreview } from '@claude-control/contracts';
import { MAX_MEDIA_BYTES } from './constants.ts';
import { ProjectFileError, resolveProjectPath } from './paths.ts';

/**
 * Файлы, которые показываются не текстом: картинки, PDF, SVG, разметка.
 *
 * Формат определяет расширение, и только оно. Гадать по байтам здесь нельзя:
 * ошибка распознавания — это не «показали неудачно», а отданный браузеру
 * чужой тип содержимого, то есть дыра. По той же причине тип ответа берётся из
 * закрытого списка ниже, а не собирается из имени файла: в списке нет ни
 * `text/html`, ни `image/svg+xml` — оба выполняются в браузере, а адрес у
 * панели общий, так что скрипт из такого файла работал бы её правами.
 *
 * SVG в списке отсутствует намеренно, хотя показывается: рисунок собирает
 * клиент из текста файла и вставляет через `<img>`, где скрипты не работают ни
 * в одном браузере. Так и правка исходника оказывается там же, где показ.
 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  apng: 'image/apng',
};

/** Расширение в нижнем регистре без точки; пусто — расширения нет. */
function extensionOf(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Чем показывать файл вместо текста. Пусто — обычный текст. */
export function previewKindOf(file: string): ProjectFilePreview | undefined {
  const extension = extensionOf(file);
  if (extension in IMAGE_TYPES) return 'image';
  if (extension === 'svg') return 'svg';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown';
  return undefined;
}

/**
 * Тип содержимого для отдачи байтов — только из списка выше. Всё остальное
 * наружу не уходит вовсе: отдать неизвестный формат «как есть» значит доверить
 * выбор поведения браузеру.
 */
function mediaTypeOf(file: string): string | undefined {
  const extension = extensionOf(file);
  if (extension === 'pdf') return 'application/pdf';
  return IMAGE_TYPES[extension];
}

/** Байты картинки или PDF вместе с типом содержимого. */
export function readProjectMedia(root: string, file: string): { bytes: Buffer; mediaType: string } {
  const mediaType = mediaTypeOf(file);
  if (!mediaType) throw new ProjectFileError('Такой формат панель не показывает.');

  const path = resolveProjectPath(root, file);
  const stats = statSync(path);
  if (!stats.isFile()) throw new ProjectFileError('Это не файл.');
  if (stats.size > MAX_MEDIA_BYTES) {
    throw new ProjectFileError('Файл слишком велик для просмотра.');
  }

  return { bytes: readFileSync(path), mediaType };
}
