import { relative, resolve, sep } from 'node:path';
import { resolveInsideSectionDir, toClientRelative } from '../../lib/section-fs.ts';

/**
 * Пути внутри каталога проекта.
 *
 * Защита от обхода каталога — общая с разделами чужих CLI
 * (`lib/section-fs.ts`), и это осознанно: своя копия проверки рано или поздно
 * разъедется с оригиналом, а разъехавшаяся защита — дыра, о которой никто не
 * узнает. Отличается только корень: здесь это каталог проекта, а не раздел
 * панели, поэтому цена ошибки выше — за корнем лежит весь диск пользователя.
 */

/** Путь не прошёл проверку: маршрут отвечает 400 с этим текстом. */
export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/** Абсолютный путь файла внутри проекта или отказ. */
export function resolveProjectPath(root: string, rawPath: string): string {
  return resolveInsideSectionDir(root, rawPath, {
    fail: (path, detail) => new ProjectFileError(`Путь «${path}» отклонён: ${detail}`),
    outsideDetail: 'выход за каталог проекта запрещён.',
  });
}

/** Путь от корня проекта в клиентской форме (`/` в любой ОС). */
export function toProjectRelative(root: string, fullPath: string): string {
  return toClientRelative(root, fullPath);
}

/**
 * Путь из транскрипта → путь от корня проекта, или undefined, если файл лежит
 * вне проекта.
 *
 * Регистр сравнивать вручную не нужно: `path.win32.relative` сам сличает пути
 * безрегистрово, а один и тот же каталог попадает в транскрипт то с заглавной
 * буквой диска, то со строчной (та же беда, что у песочницы в
 * `ChatArtifacts.isSandboxPath`). Наружу уходит настоящее написание файла — по
 * нему клиент его и открывает.
 */
export function relativeToProject(root: string, absolutePath: string): string | undefined {
  const rel = relative(resolve(root), resolve(absolutePath));
  if (!rel || rel.startsWith('..') || /^([/\\]|[A-Za-z]:)/.test(rel)) return undefined;
  return rel.split(sep).join('/');
}
