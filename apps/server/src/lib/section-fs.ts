import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Работа с КАТАЛОГОМ раздела чужого CLI — одна на все такие разделы: правила
 * Cursor/Continue (`domains/provider-rules.ts`), плагины OpenCode
 * (`domains/provider-plugins.ts`), скиллы (`domains/provider-skills.ts`).
 *
 * Разделы разные, а обход каталога и защита путей у них обязаны быть
 * ОДИНАКОВЫМИ: разъехавшаяся копия защиты — это дыра, о которой никто не узнает.
 * Сами сообщения об отказе остаются в разделах: у каждого свой класс ошибки и
 * свой словарь.
 */

/** Абсолютный ли путь по любым правилам (POSIX, Windows-диск, UNC). */
export function looksAbsolute(value: string): boolean {
  return /^([/\\]|[A-Za-z]:)/.test(value);
}

/**
 * Есть ли символическая ссылка на пути от каталога раздела до цели: через неё
 * запись/удаление ушли бы наружу каталога. Сам каталог раздела ссылкой быть
 * может — это выбор пользователя и корень доверия. Если дальше по пути ничего не
 * существует, подменять нечего.
 */
export function hasSymlinkOnPath(baseDir: string, fullPath: string): boolean {
  let current = baseDir;
  for (const segment of relative(baseDir, fullPath).split(sep)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

/** Путь относительно каталога раздела в клиентской форме (разделитель `/`). */
export function toClientRelative(baseDir: string, fullPath: string): string {
  return relative(baseDir, fullPath).split(sep).join('/');
}

/** Что у раздела своё в защите пути: класс отказа, текст про выход, правило имени. */
export interface SectionPathRules {
  /** Собрать отказ раздела: у каждого свой класс — он же код в теле ответа 400. */
  fail: (path: string, detail: string) => Error;
  /** Причина отказа при выходе за каталог: у раздела своё название каталога. */
  outsideDetail: string;
  /** Правило имени раздела (расширение, форма) — бросает свой отказ сам. */
  checkSegments?: (segments: string[], value: string) => void;
}

/**
 * Разрешить относительный путь ВНУТРИ каталога раздела — единственная защита от
 * обхода каталога на все разделы чужих CLI.
 *
 * Отклоняем: пустое имя, абсолютный путь, нулевой байт, `..`/`.`/пустой сегмент,
 * нарушение правила имени раздела, выход за каталог по итоговому пути и
 * символическую ссылку в любом сегменте (иначе запись ушла бы туда, куда ссылка
 * указывает). Раздел задаёт только СВОЙ класс ошибки и свои тексты: разъехавшаяся
 * копия самой проверки — это дыра, о которой никто не узнает.
 */
export function resolveInsideSectionDir(
  baseDir: string,
  rawPath: string,
  rules: SectionPathRules,
): string {
  const { fail, outsideDetail, checkSegments } = rules;
  const value = String(rawPath ?? '').trim();
  if (!value) throw fail(rawPath, 'пустое имя.');
  if (looksAbsolute(value)) throw fail(value, 'абсолютные пути запрещены.');
  if (value.includes('\0')) throw fail(value, 'недопустимый символ.');

  // Разделители НЕ схлопываем: `sub//name` даёт пустой сегмент и отклоняется —
  // нормализовать за пользователя странную форму пути панель не должна.
  const segments = value.split(/[/\\]/);
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw fail(value, 'сегменты «.», «..» и пустые запрещены.');
    }
  }
  checkSegments?.(segments, value);

  const fullPath = join(baseDir, ...segments);
  // Контрольная проверка после сборки: даже если что-то выше пропустило форму
  // пути, наружу каталога он уйти не должен.
  const rel = relative(baseDir, fullPath);
  if (!rel || rel.startsWith('..') || looksAbsolute(rel)) throw fail(value, outsideDetail);

  if (hasSymlinkOnPath(baseDir, fullPath)) {
    throw fail(value, 'на пути есть символическая ссылка.');
  }
  return fullPath;
}

/** Размер файла в байтах; недоступен → 0 (лишь витрина, не решение о записи). */
export function fileSizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Больше этого панель не открывает: разделы — редакторы, а не просмотр дампов. */
export const SECTION_MAX_FILE_BYTES = 1_000_000;

/** Предохранители обхода каталога: он пользовательский, глубина и размер не наши. */
export const SECTION_MAX_DEPTH = 8;
export const SECTION_MAX_ENTRIES = 2000;

/**
 * Перечислить файлы каталога раздела рекурсивно, разложив их на «свои» (имя
 * прошло `isOwn`) и прочие. Символические ссылки не обходим вовсе: они могут
 * вести наружу каталога.
 */
export function walkSectionFiles(
  root: string,
  isOwn: (name: string) => boolean,
): { own: string[]; other: string[] } {
  const own: string[] = [];
  const other: string[] = [];
  let seen = 0;

  const visit = (dir: string, depth: number): void => {
    if (depth > SECTION_MAX_DEPTH || seen >= SECTION_MAX_ENTRIES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (seen >= SECTION_MAX_ENTRIES) return;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (isOwn(entry.name)) own.push(full);
      else other.push(full);
    }
  };

  visit(root, 0);
  return { own, other };
}
