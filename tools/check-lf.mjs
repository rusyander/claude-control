/**
 * Перевод строки в репозитории — только LF. Проверка для pre-commit: получает
 * список файлов от lint-staged и отклоняет коммит, если в каком-то из них
 * есть `\r\n`. `.gitattributes` (`* text=auto eol=lf`) нормализует перевод
 * строки при коммите, но только для файлов, которые git считает текстовыми,
 * и молча — а редактор на Windows, сохранивший CRLF, при этом остаётся
 * с CRLF на диске. Здесь это видно до коммита и с именем файла.
 *
 * Двоичные файлы (NUL в первых байтах) пропускаются.
 *
 * Запуск: `node tools/check-lf.mjs <файл> [<файл> …]`.
 */
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
const bad = [];

for (const file of files) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    // Удалённый или переименованный файл в этом коммите — проверять нечего.
    continue;
  }
  const head = buffer.subarray(0, 8000);
  if (head.includes(0)) continue;
  if (buffer.includes('\r\n')) bad.push(file);
}

if (bad.length > 0) {
  console.error(`CRLF вместо LF в ${bad.length} файл(ах) — коммит отклонён:`);
  for (const file of bad) console.error(`  ${file}`);
  console.error('Исправить: `pnpm format` или `dos2unix <файл>`; в редакторе — режим EOL: LF.');
  process.exit(1);
}
