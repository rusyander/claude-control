/**
 * Кейс lint-config-002: проверка перевода строки и сырого NUL перед коммитом
 * (`tools/check-lf.mjs`, её зовёт lint-staged). Гоняет настоящий скрипт тем же
 * вызовом, что pre-commit, на файлах во временной папке: CRLF в исходнике и
 * сырой NUL внутри строки отклоняют коммит с именем файла, двоичная картинка
 * с NUL и CRLF в байтах пропускается, чистый файл проходит. Стенд и установленный
 * CLI не нужны, после себя ничего не оставляет.
 *
 * Запуск: `node tools/qa/check-lf-guard.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../check-lf.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'check-lf-'));
const failures = [];

function run(...names) {
  const result = spawnSync(process.execPath, [script, ...names.map((name) => join(dir, name))], {
    encoding: 'utf8',
  });
  return { code: result.status, err: result.stderr };
}

function expect(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

try {
  writeFileSync(join(dir, 'clean.ts'), "export const a = '\\u0000';\n");
  writeFileSync(join(dir, 'crlf.ts'), 'export const a = 1;\r\n');
  writeFileSync(join(dir, 'nul.ts'), "export const split = (s: string) => s.split('\0');\n");
  writeFileSync(join(dir, 'nul-late.mjs'), `${'// '.padEnd(9000, 'x')}\nconst k = \`a\0b\`;\n`);
  writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0x0d, 0x0a, 0]));

  const clean = run('clean.ts', 'image.png');
  expect(
    'чистый исходник и двоичная картинка проходят',
    clean.code === 0,
    `код ${clean.code}, ${clean.err}`,
  );

  const crlf = run('crlf.ts');
  expect(
    'CRLF в исходнике отклоняет коммит с именем файла',
    crlf.code === 1 && crlf.err.includes('CRLF') && crlf.err.includes('crlf.ts'),
    `код ${crlf.code}, ${crlf.err}`,
  );

  const nul = run('nul.ts', 'clean.ts');
  expect(
    'сырой NUL в начале исходника отклоняет коммит с именем файла',
    nul.code === 1 &&
      nul.err.includes('Сырой NUL') &&
      nul.err.includes('nul.ts') &&
      !nul.err.includes('clean.ts'),
    `код ${nul.code}, ${nul.err}`,
  );

  const late = run('nul-late.mjs');
  expect(
    'сырой NUL дальше первых 8000 байт тоже отклоняет коммит',
    late.code === 1 && late.err.includes('nul-late.mjs'),
    `код ${late.code}, ${late.err}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nНе прошло ${failures.length}:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('\nПроверка перевода строки и NUL перед коммитом: всё как ожидается.');
