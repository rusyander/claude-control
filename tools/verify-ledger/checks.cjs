'use strict';
/**
 * Какие процессы журнал проверок считает проверкой (стадия 0–1 журнала,
 * `.agent/tmp/verify-ledger-design.agent.md` §2 «Registry»).
 *
 * Панель знает только общие инструменты (vitest run, tsc --noEmit, eslint без
 * --fix, prettier --check): код панели не знает ни одного проекта. Проверки
 * проекта, их входы вне дерева и артефакты описывает сам проект —
 * `.claude/tools/verify-checks.json` (обычно вне git).
 *
 * Модуль вызывается из preload в КАЖДОМ процессе node под CLI, поэтому путь
 * «не проверка» — одна регулярка по argv и пара stat вверх по дереву, без git.
 */
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY = path.join('.claude', 'tools', 'verify-checks.json');

/** Путь со слешами вперёд: на Windows argv и git отдают разные. */
const slash = (p) => String(p).replace(/\\/g, '/');

/**
 * Общие инструменты по пути исполняемого файла. `pnpm` кладёт пакет в
 * `.pnpm/<pkg>@<ver>/node_modules/<pkg>/`, npm — прямо в `node_modules/<pkg>/`;
 * хвост пути один и тот же.
 */
const TOOLS = [
  { id: 'vitest', re: /node_modules\/vitest\/vitest\.mjs$/ },
  { id: 'tsc', re: /node_modules\/typescript\/bin\/tsc$/ },
  { id: 'eslint', re: /node_modules\/eslint\/bin\/eslint\.js$/ },
  { id: 'prettier', re: /node_modules\/prettier\/bin\/prettier\.cjs$/ },
];

/**
 * Ключи, после которых прогон пишет файлы, которые журнал не восстанавливает
 * (отчёт, покрытие, снимки): такой прогон записывается, но не заменяется
 * повтором — иначе потребитель отчёта прочёл бы старый файл.
 */
const VITEST_NO_SKIP = [
  /^--outputFile/,
  /^--coverage/,
  /^-u$/,
  /^--update$/,
  /^--reporter[= ]?junit/,
];

function hasFlag(args, names) {
  return args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
}

/** vitest: только разовый прогон — `run`, `related --run` или `--run`; watch и bench не проверка. */
function vitestMatch(args) {
  const positional = args.filter((a) => !a.startsWith('-'));
  const runs = positional[0] === 'run' || hasFlag(args, ['--run']);
  if (!runs || ['bench', 'list', 'init'].includes(positional[0] ?? '')) return null;
  const joined = args.map((a, i) => (a === '--reporter' ? `--reporter=${args[i + 1] ?? ''}` : a));
  const noSkip = joined.find((a) => VITEST_NO_SKIP.some((re) => re.test(a)));
  return { noSkip: noSkip ? `vitest ${noSkip}` : null };
}

function tscMatch(args) {
  if (!hasFlag(args, ['--noEmit'])) return null;
  if (hasFlag(args, ['--watch', '-w', '--build', '-b'])) return null;
  return { noSkip: null };
}

function eslintMatch(args) {
  if (hasFlag(args, ['--fix', '--fix-type', '--init', '-o', '--output-file'])) return null;
  return { noSkip: null };
}

function prettierMatch(args) {
  if (hasFlag(args, ['--write', '-w'])) return null;
  if (!hasFlag(args, ['--check', '-c', '--list-different', '-l'])) return null;
  return { noSkip: null };
}

const MATCHERS = {
  vitest: vitestMatch,
  tsc: tscMatch,
  eslint: eslintMatch,
  prettier: prettierMatch,
};

/** Реестр проекта: ближайший `.claude/tools/verify-checks.json` вверх от cwd. */
function findRegistry(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i += 1) {
    const file = path.join(dir, REGISTRY);
    if (fs.existsSync(file)) return { root: dir, file };
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function readRegistry(found) {
  const raw = fs.readFileSync(found.file, 'utf8');
  const parsed = JSON.parse(raw);
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  return {
    raw,
    checks: checks.filter((c) => c && typeof c.id === 'string' && typeof c.script === 'string'),
  };
}

/**
 * Проверка ли этот процесс. `argv` — `process.argv` целиком (node, скрипт, ключи).
 * Ответ: `null` — не проверка; иначе `{ id, script, args, noSkip, entry }`, где
 * `entry` — запись реестра проекта (для общих инструментов её нет).
 */
function recognize(argv, cwd) {
  const script = argv[1];
  if (!script) return null;
  const file = slash(path.resolve(cwd, script));
  const args = argv.slice(2);
  for (const tool of TOOLS) {
    if (!tool.re.test(file)) continue;
    const m = MATCHERS[tool.id](args);
    return m ? { id: tool.id, script: file, args, noSkip: m.noSkip, entry: null } : null;
  }
  const found = findRegistry(cwd);
  if (!found) return null;
  let registry;
  try {
    registry = readRegistry(found);
  } catch {
    return null;
  }
  const rel = slash(path.relative(found.root, file));
  const entry = registry.checks.find((c) => slash(c.script) === rel);
  if (!entry || entry.never) return null;
  const noSkip =
    Array.isArray(entry.noSkipFlags) && hasFlag(args, entry.noSkipFlags)
      ? `${entry.id} flag`
      : null;
  return {
    id: entry.id,
    script: file,
    args,
    noSkip,
    entry: { ...entry, registryRaw: registry.raw },
  };
}

module.exports = { recognize, findRegistry, slash, TOOLS };
