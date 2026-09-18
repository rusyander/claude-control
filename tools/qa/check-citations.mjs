/**
 * Сторож цитат: внутренние имена и адреса ЧУЖОГО закрытого репозитория не
 * попадают в публичный репозиторий панели — ни в содержимое файлов, ни в их
 * имена.
 *
 *   node tools/qa/check-citations.mjs             — проверка, exit 1 на находке
 *   node tools/qa/check-citations.mjs --selftest  — сторож обязан краснеть на подброшенной строке
 *
 * Статический прогон: ни стенда, ни сети. Читает ВСЕ файлы, которые знает git
 * (отслеживаемые и новые неигнорируемые), кроме `.agent/` и `node_modules`.
 *
 * ЧТО СЧИТАЕТСЯ ЦИТАТОЙ. Инженерный факт о платформе компании публиковать
 * можно: «на стороне платформы схема запроса отбрасывает поле `tools`»,
 * «потолок не-потокового ответа — 120 с». Нельзя публиковать АДРЕС этого
 * факта: имя их модуля или сервиса, путь к файлу их репозитория, номер строки,
 * ревизию, идентификатор их трекера, имя их стенда. Правило простое: факт
 * остаётся, адрес уходит.
 *
 * Разрешённых мест нет — намеренно: цитата, «временно» оставленная в одном
 * файле, расползается копированием, а публичный репозиторий помнит всё.
 * Поэтому сам сторож запрещённых слов тоже не несёт: каждое СОБИРАЕТСЯ из
 * кусков (`alt`), и ни один литерал в этом файле не равен запрещённому слову.
 * Список при этом остаётся ДАННЫМИ — дописать строку в `FORBIDDEN` можно, не
 * трогая код.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

/** Слово из кусков: литерала запрещённого слова в этом файле не появляется. */
const w = (...parts) => parts.join('');

/** Чередование `(a|b|c)` из слов, каждое из которых собрано из кусков. */
const alt = (...words) => `(${words.map((parts) => w(...parts)).join('|')})`;

/**
 * Список запрещённого — ДАННЫЕ. Каждая строка: `why` (что именно палится) и
 * `re` (регистронезависимое выражение). Дописывать сюда строки безопасно: код
 * ниже о содержимом списка ничего не знает.
 */
export const FORBIDDEN = [
  {
    why: 'имя модуля чужой платформы',
    re: new RegExp(
      '\\bmod-' +
        alt(
          ['llm', 'box'],
          ['guardrails', 'box'],
          ['kb', 'box'],
          ['agent', 'box'],
          ['tool', 'registry'],
          ['mcp', 'box'],
          ['image', 'box'],
          ['asr', 'box'],
          ['tts', 'box'],
          ['eval', 'box'],
          ['ner', 'box'],
          ['parse', 'box'],
          ['sentiment', 'box'],
        ) +
        '\\b',
      'iu',
    ),
  },
  {
    why: 'имя модуля чужой платформы без префикса',
    re: new RegExp(
      '\\b' + alt(['llm', 'box'], ['guardrails', 'box'], ['kb', 'box'], ['agent', 'box']) + '\\b',
      'iu',
    ),
  },
  {
    why: 'имя сервиса чужой установки',
    re: new RegExp(
      '\\b' +
        w('inst', '-') +
        alt(
          ['api'],
          ['admin', '-api'],
          ['admin', '-ui'],
          ['chat', '-ui'],
          ['gateway'],
          ['telemetry'],
        ) +
        '\\b',
      'iu',
    ),
  },
  {
    why: 'имя их чарта или сервиса учёта',
    re: new RegExp(alt(['instance', '-platform'], ['saas', '-usage-tracker']), 'iu'),
  },
  {
    why: 'путь к их рабочей копии',
    re: new RegExp(w('company', '-') + alt(['platform'], ['deployment']), 'iu'),
  },
  {
    why: 'файл их репозитория со строкой',
    re: /\b[\w/]+\.(py|go):\d/iu,
  },
  {
    why: 'имя файла их репозитория',
    re: new RegExp(
      '\\b' +
        alt(
          ['rou', 'ter'],
          ['sche', 'mas'],
          ['hel', 'pers'],
          ['stre', 'aming'],
          ['anony', 'mization'],
          ['respon', 'ses_api'],
          ['llm', '_router'],
          ['pri', 'cer'],
          ['bud', 'get'],
          ['api', 'key'],
          ['handler', '_public_api'],
          ['handler', '_agent_api'],
          ['key', '_service'],
          ['model', '_catalog'],
        ) +
        '\\.(py|go)\\b',
      'iu',
    ),
  },
  {
    why: 'ревизия их репозитория',
    re: new RegExp('\\b' + alt(['eb18684', 'f5'], ['0cde902', '36']) + '\\b', 'iu'),
  },
  {
    why: 'идентификатор их трекера',
    re: new RegExp('\\b' + w('VA', 'B') + '-\\d', 'iu'),
  },
  {
    why: 'префикс проекта их трекера',
    re: new RegExp('\\b' + w('GO', 'R') + '-\\d', 'iu'),
  },
  {
    why: 'имя их стенда',
    re: new RegExp('\\b' + w('inst', '\\.dev'), 'iu'),
  },
  {
    why: 'ссылка на строку их исходников',
    re: new RegExp(w('Где у ', 'вас'), 'iu'),
  },
  {
    why: 'ссылка на чтение их исходников',
    re: new RegExp(w('по исходни', 'кам') + '[^.\\n]{0,40}(платформ|контур|llm)', 'iu'),
  },
];

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

/** Имя файла с чужим именем — находка при любом содержимом. */
export function auditPaths(paths) {
  return paths.flatMap((path) =>
    FORBIDDEN.filter((entry) => entry.re.test(path)).map(
      (entry) => `${path}: ${entry.why} в имени файла — переименуйте файл`,
    ),
  );
}

/** Вхождения по строкам: [{ line, text, match, why }]. */
export function findCitations(source) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    for (const entry of FORBIDDEN) {
      const match = entry.re.exec(line);
      if (!match) continue;
      hits.push({
        line: index + 1,
        text: line.trim().slice(0, 160),
        match: match[0],
        why: entry.why,
      });
    }
  });
  return hits;
}

/** Нарушения по набору файлов { путь: текст }. */
export function audit(files) {
  const problems = [];
  for (const [file, source] of Object.entries(files)) {
    for (const hit of findCitations(source)) {
      problems.push(`${file}:${hit.line}: ${hit.why} «${hit.match}» — ${hit.text}`);
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
  const mod = w('mod-', 'llm', 'box');
  const svc = w('inst', '-', 'api');
  const py = w('rou', 'ter', '.py');
  const go = w('pri', 'cer', '.go');
  const rev = w('eb18684', 'f5');
  const chart = w('instance', '-platform', '-yc');

  expect(
    audit({ 'docs/x.ru.md': `схема ${mod} отбрасывает \`tools\`\n` }).length >= 1,
    'имя чужого модуля — находка',
  );
  expect(
    audit({ 'tools/qa/x.mjs': `// потолок стоит в ${svc}\n` }).length === 1,
    'имя чужого сервиса — находка',
  );
  expect(
    audit({ 'docs/x.md': `(\`${py}:243\`)\n` }).length === 2,
    'путь к их файлу со строкой — находка дважды: и путь со строкой, и имя файла',
  );
  expect(
    audit({ 'packages/contracts/src/x.ts': ` * тарифицирует ${go}\n` }).length === 1,
    'имя их go-файла без строки — тоже находка',
  );
  expect(audit({ 'TASKS-X.md': `на ревизии \`${rev}\`\n` }).length === 1, 'ревизия — находка');
  expect(
    audit({ 'TASKS-X.md': `тарифицирует (${w('VA', 'B-', '94')})\n` }).length === 1,
    'идентификатор их трекера — находка',
  );
  expect(
    audit({ 'tools/mcp/x.mjs': `например ${w('GO', 'R-', '1234')}\n` }).length === 1,
    'префикс проекта их трекера — находка',
  );
  expect(
    audit({ 'docs/x.md': `${w('Где у ', 'вас')}: путь и строка\n` }).length === 1,
    'формула ссылки на их исходники — находка',
  );
  expect(
    audit({ 'TASKS-X.md': `проверено ${w('по исходни', 'кам')} платформы компании\n` }).length ===
      1,
    'ссылка на чтение их исходников — находка',
  );
  expect(
    audit({ 'TASKS-X.md': `чарт ${chart} переопределяет\n` }).length === 1,
    'имя их чарта — находка',
  );
  expect(
    auditPaths([`docs/${mod}.md`]).length >= 1 && auditPaths(['docs/PLATFORM.ru.md']).length === 0,
    'чужое имя в имени файла — находка, своё имя — нет',
  );
  // Ложные срабатывания, которые сторож обязан НЕ делать.
  expect(
    audit({ 'docs/x.ru.md': 'на стороне платформы схема запроса отбрасывает поле `tools`\n' })
      .length === 0,
    'инженерный факт без адреса — не находка',
  );
  expect(
    audit({ 'apps/web/src/x.tsx': "const mod = 'Mod-s';\nconst box = 'sandbox';\n" }).length === 0,
    'sandbox и Mod-s — не находки',
  );
  expect(
    audit({
      'docs/LIMITATIONS-PROVIDERS.ru.md': `чужой формат ${w('по исходни', 'кам')} панель не пишет\n`,
    }).length === 0,
    `«${w('по исходни', 'кам')}» без платформы и контура — не находка`,
  );
  expect(
    audit({ 'tools/x.mjs': "const f = ['rou', 'ter', '.py'].join('');\n" }).length === 0,
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
  let source;
  try {
    source = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  if (source.includes(String.fromCharCode(0))) continue; // двоичные файлы цитат не несут
  contents[file] = source;
}
const problems = [...audit(contents), ...auditPaths(paths)];

console.log(`просмотрено файлов: ${Object.keys(contents).length}`);
if (problems.length) {
  console.log(
    `\n✕ цитаты чужого репозитория (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`,
  );
  console.log(
    '\nОставьте ФАКТ, уберите АДРЕС: «на стороне платформы схема запроса отбрасывает поле `tools`» вместо имени их модуля, файла и строки. Знание, которому место только на этой машине, живёт в `.agent/private/` — он вне git.',
  );
  process.exit(1);
}
console.log('✓ цитат чужого репозитория нет ни в файлах, ни в их именах');
