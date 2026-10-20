/**
 * Перевод строки в репозитории — только LF. Проверка для pre-commit: получает
 * список файлов от lint-staged и отклоняет коммит, если в каком-то из них
 * есть `\r\n`. `.gitattributes` (`* text=auto eol=lf`) нормализует перевод
 * строки при коммите, но только для файлов, которые git считает текстовыми,
 * и молча — а редактор на Windows, сохранивший CRLF, при этом остаётся
 * с CRLF на диске. Здесь это видно до коммита и с именем файла.
 *
 * Двоичные файлы (NUL в первых байтах) пропускаются. Но исходник с сырым NUL
 * внутри строки — не двоичный, а испорченный: git видит NUL в первых 8000
 * байтах и считает файл двоичным, его правки пропадают из диффа MR, а перевод
 * строки в нём больше не нормализуется (так было с `tms/sync.ts` и
 * `export-cases.ts`). Поэтому у текстовых расширений NUL где угодно — отказ:
 * в коде он пишется экранированием `\u0000`.
 *
 * Запуск: `node tools/check-lf.mjs <файл> [<файл> …]`.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** Расширения, где сырому NUL взяться неоткуда, кроме ошибки правки. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.html',
  '.yml',
  '.yaml',
]);

const files = process.argv.slice(2);
const crlf = [];
const nul = [];

for (const file of files) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    // Удалённый или переименованный файл в этом коммите — проверять нечего.
    continue;
  }
  if (TEXT_EXTENSIONS.has(extname(file).toLowerCase()) && buffer.includes(0)) {
    nul.push(file);
    continue;
  }
  const head = buffer.subarray(0, 8000);
  if (head.includes(0)) continue;
  if (buffer.includes('\r\n')) crlf.push(file);
}

if (crlf.length > 0) {
  console.error(`CRLF вместо LF в ${crlf.length} файл(ах) — коммит отклонён:`);
  for (const file of crlf) console.error(`  ${file}`);
  console.error('Исправить: `pnpm format` или `dos2unix <файл>`; в редакторе — режим EOL: LF.');
}
if (nul.length > 0) {
  console.error(`Сырой NUL в текстовом файле (${nul.length}) — git сочтёт его двоичным:`);
  for (const file of nul) console.error(`  ${file}`);
  console.error('Исправить: в строке писать экранирование `\\u0000` вместо самого символа.');
}
if (crlf.length > 0 || nul.length > 0) process.exit(1);
