import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { currentOs, type OsKind } from './os-kind.ts';

/**
 * Одно написание пути на всё ядро (09 §path identity, P52, P22). Ключи журнала, копий и
 * проверок раньше расходились: `C:\Users\RUSYAN~1` и `C:\Users\rusyander`, `c:` и `C:`,
 * `/` и `\`, хвостовой разделитель, ссылка и её цель — один каталог, разные строки
 * (F13: 8.3 cwd → CLI спросил разрешения на свой же каталог, группа встала).
 *
 * Три уровня:
 * - `normaliseSpelling` — чистое написание без диска: разделители, `..`, буква диска,
 *   хвост, `\\?\`; на macOS — NFC;
 * - `longForm` — путь, как его знает диск: 8.3 раскрыты, ссылки и junction раскрыты,
 *   регистр с диска; несуществующий хвост дописан к самому глубокому существующему предку;
 * - `pathKey` / `samePath` — сравнение: регистр сворачивается там, где том к нему
 *   нечувствителен (проверяется на самом томе, а не угадывается по ОС).
 *
 * NFD↔NFC сворачивается только на macOS: APFS сравнивает имена без учёта нормализации,
 * а NTFS и ext4 хранят `й` из двух кодовых точек и из одной как два разных имени —
 * свернуть их там значило бы склеить два файла.
 */

/** Предел пути Win32 API без префикса `\\?\` (MAX_PATH, с завершающим нулём). */
export const MAX_PATH = 260;

function api(os: OsKind): typeof path.posix {
  return os === 'win32' ? path.win32 : path.posix;
}

/** `\\?\C:\…` → `C:\…`, `\\?\UNC\srv\share` → `\\srv\share`. */
export function stripLongPrefix(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

/**
 * Путь для вызова Win32 API в обход MAX_PATH: длиннее предела — с `\\?\` (UNC — с
 * `\\?\UNC\`), короче — как есть. На POSIX ничего не меняет. Node сам добавляет префикс
 * своим fs-вызовам; нужен он внешним инструментам и записи в файлы задач.
 */
export function forWin32Api(value: string, os: OsKind = currentOs()): string {
  if (os !== 'win32') return value;
  const plain = stripLongPrefix(value);
  if (plain.length < MAX_PATH) return plain;
  return plain.startsWith('\\\\') ? `\\\\?\\UNC\\${plain.slice(2)}` : `\\\\?\\${plain}`;
}

/** Написание без обращения к диску. */
export function normaliseSpelling(value: string, os: OsKind = currentOs()): string {
  const p = api(os);
  let spelled = os === 'win32' ? stripLongPrefix(value.replace(/\//g, '\\')) : value;
  // resolve убирает `.`/`..`, двойные разделители и хвостовой разделитель (кроме корня).
  spelled = p.resolve(spelled);
  if (os === 'win32')
    spelled = spelled.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
  if (os === 'darwin') spelled = spelled.normalize('NFC');
  return spelled;
}

/**
 * Длинная форма с диска. Существующий префикс — `realpath.native` (раскрывает 8.3,
 * junction и symlink, отдаёт регистр с диска); не существующий хвост дописывается как
 * написан. Ни один предок не читается (нет прав, диска нет) — написание без диска.
 */
export function longForm(value: string, os: OsKind = currentOs()): string {
  const p = api(os);
  const spelled = normaliseSpelling(value, os);
  const tail: string[] = [];
  let head = spelled;
  for (;;) {
    try {
      const real = normaliseSpelling(stripLongPrefix(realpathSync.native(head)), os);
      return tail.length > 0 ? p.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = p.dirname(head);
      if (parent === head) return spelled;
      tail.push(p.basename(head));
      head = parent;
    }
  }
}

/** Самый глубокий существующий предок пути (или сам путь). */
function deepestExisting(value: string, os: OsKind): string | undefined {
  const p = api(os);
  let head = value;
  for (;;) {
    try {
      lstatSync(head);
      return head;
    } catch {
      const parent = p.dirname(head);
      if (parent === head) return undefined;
      head = parent;
    }
  }
}

function toggledCase(value: string): string {
  let out = '';
  for (const char of value) {
    const lower = char.toLowerCase();
    out += char === lower ? char.toUpperCase() : lower;
  }
  return out;
}

/**
 * Нечувствителен ли том к регистру — по самому тому: тот же файл под переставленным
 * регистром даёт тот же `dev`+`ino`. Букв в пути нет или проверить нечем — ответ ОС по
 * умолчанию (Windows и macOS нечувствительны, Linux чувствителен).
 */
export function foldsCaseAt(existing: string | undefined, os: OsKind = currentOs()): boolean {
  const byOs = os !== 'linux';
  if (existing === undefined) return byOs;
  const swapped = toggledCase(existing);
  if (swapped === existing) return byOs;
  try {
    const a = lstatSync(existing, { bigint: true });
    try {
      const b = lstatSync(swapped, { bigint: true });
      return a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false;
    }
  } catch {
    return byOs;
  }
}

/** Ключ сравнения путей: длинная форма, регистр свёрнут там, где его не различает том. */
export function pathKey(value: string, os: OsKind = currentOs()): string {
  const long = longForm(value, os);
  const fold = foldsCaseAt(deepestExisting(long, os), os);
  return fold ? long.toLowerCase() : long;
}

/** Один и тот же путь для этой машины (P52). */
export function samePath(a: string, b: string, os: OsKind = currentOs()): boolean {
  return pathKey(a, os) === pathKey(b, os);
}

/** `child` лежит внутри `parent` (или совпадает с ним) — по ключам, не по строкам. */
export function isInside(parent: string, child: string, os: OsKind = currentOs()): boolean {
  const p = api(os);
  const rel = p.relative(pathKey(parent, os), pathKey(child, os));
  // Выход наружу — первый СЕГМЕНТ `..`, а не префикс строки: `..foo` — имя внутри (F-44).
  const first = rel.split(p.sep)[0];
  return rel === '' || (first !== '..' && !p.isAbsolute(rel));
}

/** Путь абсолютный по правилам ОС `os` (P51: вкус пути знает только платформа). */
export function isAbsolutePath(value: string, os: OsKind = currentOs()): boolean {
  return api(os).isAbsolute(value);
}

/** Разделитель списка путей в PATH (`;` на Windows, `:` иначе) — ядро не берёт `path.delimiter` само (P51). */
export function pathListDelimiter(os: OsKind = currentOs()): string {
  return api(os).delimiter;
}

/** Склейка пути по правилам ОС — чтобы ядро не трогало `path.sep` само (P51). */
export function joinPath(os: OsKind, ...parts: string[]): string {
  return api(os).join(...parts);
}
