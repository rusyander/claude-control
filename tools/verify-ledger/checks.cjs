'use strict';
/**
 * Какие процессы журнал проверок считает проверкой (стадия 0–1 журнала,
 * `.agent/tmp/verify-ledger-design.agent.md` §2 «Registry»).
 *
 * Панель знает только общие инструменты (vitest run, tsc --noEmit, eslint без
 * --fix, prettier --check, vite build): код панели не знает ни одного проекта. Проверки
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
  { id: 'vite', re: /node_modules\/vite\/bin\/vite\.js$/ },
];

/**
 * Ключи, после которых прогон пишет файлы, которые журнал не восстанавливает
 * (отчёт, покрытие, снимки): такой прогон записывается, но не заменяется
 * повтором — иначе потребитель отчёта прочёл бы старый файл.
 */
const VITEST_NO_SKIP = [/^-u$/, /^--update$/];

/** Значение ключа покрытия: `false`/`0` — выключено, остальное (и пусто) — включено. */
const OFF_VALUE = /^(false|0)$/i;

/**
 * Покрытие пишет файлы, но ВЫКЛЮЧЕННОЕ покрытие не пишет ничего. Блок Tests
 * (`tools/qa/junit-run.mjs`) передаёт `--coverage.enabled=false` на каждом прогоне,
 * а прежнее `/^--coverage/` считало и его пишущим: 19.10 — 115 прогонов за день
 * записаны промахом `vitest --coverage.enabled=false`, ни один не повторён.
 * Решает последний включатель (`--coverage`, `--coverage.enabled`, `--no-coverage`,
 * с `=значением` или значением следующим аргументом), как у самого vitest. Прочие
 * `--coverage.*` без явного выключения — не повтор: конфиг может включать покрытие сам.
 */
function coverageNoSkip(args) {
  let toggle = null;
  let other = null;
  args.forEach((a, i) => {
    if (a === '--no-coverage') {
      toggle = { on: false };
      return;
    }
    const m = /^--coverage(\.enabled)?(?:=(.*))?$/.exec(a);
    if (m) {
      const next = args[i + 1];
      const value =
        m[2] ?? (m[1] && next !== undefined && /^(true|false|0|1)$/i.test(next) ? next : '');
      toggle = { on: !OFF_VALUE.test(value), flag: a };
      return;
    }
    if (/^--coverage\./.test(a) && !other) other = a;
  });
  if (toggle) return toggle.on ? toggle.flag : null;
  return other;
}

/**
 * Файлы отчёта (`--outputFile`, `--outputFile.junit=…`): журнал хранит их байты и
 * при повторе кладёт по пути ТЕКУЩЕГО запуска, а сам путь в ключ не входит —
 * блок Tests каждый раз даёт новый временный путь, и прогон с отчётом прежде не
 * повторялся никогда (19.10: 15 промахов `vitest --reporter=junit` за час).
 */
const REPORT_FLAG = /^--outputFile(\.[\w-]+)?$/;

function reportsOf(args) {
  const out = [];
  args.forEach((a, i) => {
    const eq = a.indexOf('=');
    const flag = eq < 0 ? a : a.slice(0, eq);
    if (!REPORT_FLAG.test(flag)) return;
    const value = eq < 0 ? args[i + 1] : a.slice(eq + 1);
    if (value && !value.startsWith('-'))
      out.push({ at: eq < 0 ? i + 1 : i, sep: eq < 0, flag, value });
  });
  return out;
}

function hasFlag(args, names) {
  return args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
}

/** vitest: только разовый прогон — `run`, `related --run` или `--run`; watch и bench не проверка. */
function vitestMatch(args) {
  const positional = args.filter((a) => !a.startsWith('-'));
  const runs = positional[0] === 'run' || hasFlag(args, ['--run']);
  if (!runs || ['bench', 'list', 'init'].includes(positional[0] ?? '')) return null;
  const joined = args.map((a, i) => (a === '--reporter' ? `--reporter=${args[i + 1] ?? ''}` : a));
  const noSkip =
    coverageNoSkip(args) ?? joined.find((a) => VITEST_NO_SKIP.some((re) => re.test(a)));
  const reports = reportsOf(args);
  // Машинный отчёт (в файл или в stdout) читают целиком: сужать такой прогон нельзя.
  const wholeOnly =
    reports.length > 0 || joined.some((a) => /^--reporter[= ]?(junit|json|tap|html)/.test(a));
  return { noSkip: noSkip ? `vitest ${noSkip}` : null, reports, wholeOnly };
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

/**
 * Ключи `vite build` со значением (у части оно необязательно — cac берёт следующее
 * слово, если оно не ключ): без них значение `--mode staging` читалось бы корнем.
 */
const VITE_VALUE_FLAGS = new Set([
  '--config',
  '-c',
  '--base',
  '--mode',
  '-m',
  '--outDir',
  '--assetsDir',
  '--assetsInlineLimit',
  '--logLevel',
  '-l',
  '--filter',
  '--target',
  '--sourcemap',
  '--minify',
  '--manifest',
  '--ssrManifest',
  '--ssr',
  '--configLoader',
]);

function flagValue(args, name) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

/**
 * Сборка vite (владелец 19.10: гейт групп гонял ту же сборку на том же дереве по
 * нескольку раз). Повтор обязан вернуть не только вывод, но и каталог сборки —
 * его читают следующие шаги (preview, e2e), поэтому каталог — артефакт записи.
 * Где он, журнал знает наверняка только из `--outDir` или по умолчанию (`dist` у
 * корня); конфиг, задающий `outDir` или `root`, — прогон пишется, но не
 * повторяется: восстановить не тот каталог хуже, чем собрать заново.
 */
function viteMatch(args, cwd) {
  const positional = args.filter(
    (a, i) => !a.startsWith('-') && !(i > 0 && VITE_VALUE_FLAGS.has(args[i - 1])),
  );
  if (positional[0] !== 'build') return null;
  if (hasFlag(args, ['--watch', '-w'])) return null;
  const root = path.resolve(cwd, positional[1] ?? '.');
  const outDir = flagValue(args, '--outDir');
  const configArg = flagValue(args, '--config') ?? flagValue(args, '-c');
  const config = configArg
    ? path.resolve(cwd, configArg)
    : fs
        .readdirSync(root)
        .filter((n) => /^vite\.config\.[cm]?[jt]s$/.test(n))
        .map((n) => path.join(root, n))[0];
  let text;
  try {
    text = config ? fs.readFileSync(config, 'utf8') : '';
  } catch {
    return { noSkip: 'vite config unreadable', outputs: [] };
  }
  if (/\broot\s*:/.test(text)) return { noSkip: 'vite root from config', outputs: [] };
  const fromConfig = outDir ? null : configOutDir(text);
  if (fromConfig === false) return { noSkip: 'vite outDir from config', outputs: [] };
  return { noSkip: null, outputs: [path.resolve(root, outDir ?? fromConfig ?? 'dist')] };
}

/**
 * `outDir` конфига: `null` — его нет (каталог по умолчанию), строка — единственное
 * `outDir: '<литерал>'` прямо внутри `build: { … }`, `false` — что-то иное (выражение,
 * несколько вхождений, ключ плагина): каталог не угадываем, прогон не повторяется.
 * 24.10: все сборки проектов с `build: { outDir: 'dist' }` шли промахом — 35 зелёных
 * сборок на уже зелёном ключе (31 мин) за двое суток. Ошибку в другую сторону ловит
 * запись: каталог, в который прогон ничего не написал, хранится как негодный (`packDir`),
 * и повтора нет.
 */
function configOutDir(text) {
  const all = [...text.matchAll(/\boutDir\b/g)];
  if (all.length === 0) return null;
  if (all.length > 1) return false;
  const at = all[0].index;
  const literal = /^outDir\s*:\s*(['"`])([^'"`$\\\n]+)\1\s*[,}\n]/.exec(text.slice(at));
  if (!literal) return false;
  // Ближайшая открытая скобка над `outDir` — от `build:`; иначе это ключ чужого объекта.
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === '}') depth += 1;
    else if (c === '{') {
      if (depth > 0) depth -= 1;
      else return /\bbuild\s*:\s*$/.test(text.slice(Math.max(0, i - 40), i)) ? literal[2] : false;
    }
  }
  return false;
}

const MATCHERS = {
  vitest: vitestMatch,
  tsc: tscMatch,
  eslint: eslintMatch,
  prettier: prettierMatch,
  vite: viteMatch,
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
function realOf(file) {
  try {
    return slash(fs.realpathSync(file));
  } catch {
    return file;
  }
}

function recognize(argv, cwd) {
  const script = argv[1];
  if (!script) return null;
  const asGiven = slash(path.resolve(cwd, script));
  // npm, yarn и bun на Linux/macOS ставят `.bin/vitest` символьной ссылкой, и argv[1] остаётся
  // путём ссылки: инструмент узнаётся (и хешируется его каталог) по настоящему файлу пакета.
  const file = /\/node_modules\/\.bin\/[^/]+$/.test(asGiven) ? realOf(asGiven) : asGiven;
  const args = argv.slice(2);
  for (const tool of TOOLS) {
    if (!tool.re.test(file)) continue;
    const m = MATCHERS[tool.id](args, cwd);
    return m
      ? {
          id: tool.id,
          script: file,
          args,
          noSkip: m.noSkip,
          reports: (m.reports ?? []).map((r) => ({ ...r, file: path.resolve(cwd, r.value) })),
          outputs: m.outputs ?? [],
          wholeOnly: Boolean(m.wholeOnly),
          entry: null,
        }
      : null;
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

/**
 * Срок одного вызова git из preload (снимок дерева, сужение). Preload сидит в
 * каждой проверке: git без срока (чужая блокировка индекса, зависший помощник
 * учётных данных, антивирус на `add -A` большого дерева) держал бы саму проверку,
 * а с ней — вызов инструмента агента. По сроку git бросает, журнал пишет причину
 * в ленту и пропускает проверку как есть. `AGENTDECK_VERIFY_LEDGER_GIT_MS` — для тестов.
 */
function gitTimeoutMs(env = process.env) {
  const knob = Number(env.AGENTDECK_VERIFY_LEDGER_GIT_MS);
  return knob > 0 ? knob : 60_000;
}

/**
 * Замок панели во входе preload (F-30): `bin/preload-locked.cjs`, которым панель грузит журнал
 * в CLI под замком, кладёт сюда дом журнала до загрузки preload. Окружение команды модели
 * (`_LOCK=`, `env -u`, скрипт) этого не достаёт — сменить вход можно только сменой
 * NODE_OPTIONS, а её видит и отбивает страж группы `gate-at-end`.
 */
const ENTRY_LOCK = Symbol.for('agentdeck.verify-ledger.locked');

/** `{ home }` замка входа или `null`. */
function entryLock() {
  const lock = globalThis[ENTRY_LOCK];
  return lock && typeof lock.home === 'string' && lock.home ? lock : null;
}

/** Под замком панели: вход под замком или `AGENTDECK_VERIFY_LEDGER_LOCK=1` в окружении. */
function panelLocked(env = process.env) {
  return entryLock() !== null || String(env.AGENTDECK_VERIFY_LEDGER_LOCK ?? '') === '1';
}

module.exports = {
  recognize,
  findRegistry,
  slash,
  gitTimeoutMs,
  entryLock,
  panelLocked,
  ENTRY_LOCK,
  TOOLS,
};
