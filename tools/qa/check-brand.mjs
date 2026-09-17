/**
 * Сторож переименования: прежнее имя продукта и прежнее имя драйвера платформы
 * компании не возвращаются в репозиторий — ни в содержимое файлов, ни в их имена.
 *
 *   node tools/qa/check-brand.mjs             — проверка, exit 1 на находке
 *   node tools/qa/check-brand.mjs --selftest  — сторож обязан краснеть на подброшенной строке
 *
 * Статический прогон: ни стенда, ни сети. Читает ВСЕ файлы, которые знает git
 * (отслеживаемые и новые неигнорируемые, двоичные тоже), кроме архива
 * `.agent/archive/` и `node_modules`.
 *
 * Разрешённых мест нет — намеренно. История репозитория переписывается заменой
 * этих слов, и любой литерал в дереве превратился бы в новое имя: код переезда
 * молча перестал бы узнавать старые данные. Поэтому прежние имена СОБИРАЮТСЯ из
 * частей (`LEGACY_PARTS` в `apps/server/src/lib/brand.mjs` и
 * `packages/contracts/src/brand.ts`, `platform-legacy.ts`), тесты пишут их задом
 * наперёд, а снимок старого гейта хранит метку вместо имени. Сам сторож слов тоже
 * не несёт: одна буква каждого слова — классом символов.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
/** Прежнее имя продукта: через дефис, подчёркивание, пробел или слитно, в любом регистре. */
const OLD = /cl[a]ude[-_ ]?c[o]ntrol/giu;
/**
 * Прежнее имя драйвера платформы компании, латиницей и кириллицей. Гласные —
 * классом: так ловится и написание с ошибкой.
 */
const OLD_PLATFORM = /g[oa]rg[oa]n|г[оа]рг[оа]н/giu;

const SKIP = [/^\.agent\//, /(^|\/)node_modules\//];

/** Все пути git (отслеживаемые и новые неигнорируемые), кириллица без экранирования. */
function listPaths() {
  const git = (args) =>
    execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\n')
      .filter(Boolean);
  return [
    ...new Set([...git(['ls-files']), ...git(['ls-files', '--others', '--exclude-standard'])]),
  ].filter((file) => !SKIP.some((re) => re.test(file)) && existsSync(join(ROOT, file)));
}

/** Имя файла или каталога с прежним именем — находка при любом содержимом. */
export function auditPaths(paths) {
  const product = new RegExp(OLD.source, 'iu');
  const platform = new RegExp(OLD_PLATFORM.source, 'iu');
  return paths.flatMap((path) => [
    ...(product.test(path) ? [`${path}: прежнее имя продукта в пути — переименуйте файл`] : []),
    ...(platform.test(path) ? [`${path}: прежнее имя драйвера в пути — переименуйте файл`] : []),
  ]);
}

/** Вхождения по строкам: [{ line, text, match }]. */
export function findOld(source, pattern = OLD) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      hits.push({ line: index + 1, text: line.trim().slice(0, 160), match: match[0] });
    }
  });
  return hits;
}

/** Нарушения по набору файлов { путь: текст }. */
export function audit(files) {
  const problems = [];
  for (const [file, source] of Object.entries(files)) {
    for (const hit of findOld(source)) {
      problems.push(`${file}:${hit.line}: прежнее имя продукта «${hit.match}» — ${hit.text}`);
    }
    for (const hit of findOld(source, OLD_PLATFORM)) {
      problems.push(`${file}:${hit.line}: прежнее имя драйвера «${hit.match}» — ${hit.text}`);
    }
  }
  return problems;
}

function selftest() {
  let failed = 0;
  const expect = (ok, label) => {
    console.log(`${ok ? '✓' : '✕'} ${label}`);
    if (!ok) failed += 1;
  };
  // Подброшенные слова собираются здесь же: буквально их в дереве нет.
  const name = ['Claude', 'Control'].join(' ');
  const slug = ['claude', 'control'].join('-');
  const word = ['gor', 'gona'].join('');
  expect(
    audit({ 'apps/web/src/pages/Planted.tsx': `export const title = '${name}';\n` }).length === 1,
    'название продукта в интерфейсе — находка',
  );
  expect(
    audit({ 'apps/server/src/x.ts': `const dir = join(home, '.${slug}');\n` }).length === 1,
    'прежний каталог в новом коде — находка',
  );
  expect(
    audit({ 'tools/x.mjs': `process.env.${slug.replace('-', '_').toUpperCase()}_URL;\n` })
      .length === 1,
    'прежняя переменная — находка',
  );
  expect(
    audit({ 'apps/mobile/app.json': `"scheme": "${slug.replace('-', '')}"\n` }).length === 1,
    'слитное написание — находка',
  );
  expect(
    audit({ 'docs/x.md': `cd ${slug}\nc:\\work\\${slug}\\apps\n` }).length === 2,
    'путь к репозиторию — тоже находка: разрешённых мест нет',
  );
  expect(
    audit({ 'apps/web/public/help/x/y/frames.json': `"${name}"` }).length === 1,
    'кадры справки — находка',
  );
  expect(
    audit({ 'apps/web/src/pages/Planted.tsx': `const driver = '${word}';\n` }).length === 1,
    'прежнее имя драйвера в коде — находка',
  );
  expect(
    audit({ 'docs/x.ru.md': `Контур Г${'аргоны'} и ГОР${'ГОНА'}\n` }).length === 2,
    'кириллица и написание с ошибкой — находки',
  );
  expect(
    auditPaths([`docs/CONTOUR-${word.toUpperCase()}-SIDE.ru.md`, `${slug}.apk`, 'docs/PLATFORM.md'])
      .length === 2,
    'прежнее имя в имени файла — находка',
  );
  expect(
    audit({ 'apps/server/src/lib/brand.mjs': "const LEGACY_PARTS = ['claude', 'control'];\n" })
      .length === 0,
    'имя, собранное из частей, — не находка',
  );
  console.log(failed ? `\n✕ самопроверка провалена: ${failed}` : '\n✓ сторож умеет краснеть');
  return failed;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);

const paths = listPaths();
const contents = {};
for (const file of paths) {
  const full = join(ROOT, file);
  if (!statSync(full).isFile()) continue;
  contents[file] = readFileSync(full, 'utf8');
}
const problems = [...audit(contents), ...auditPaths(paths)];

console.log(`просмотрено файлов: ${Object.keys(contents).length}`);
if (problems.length) {
  console.log(`\n✕ прежнее имя (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  console.log(
    '\nЗамените на AgentDeck / agentdeck / AGENTDECK_* и enterprise-platform / «Платформа компании». Код, которому нужно узнать старые данные, собирает прежнее имя из частей (brand.mjs, platform-legacy.ts) — литерал в дереве не допускается.',
  );
  process.exit(1);
}
console.log('✓ прежних имён нет ни в файлах, ни в их именах');
