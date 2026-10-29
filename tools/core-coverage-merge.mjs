/**
 * Слитый порог покрытия ядра (09 §OS coverage, P60): часть кода `apps/core` исполняется только
 * на одной ОС (exec-бит, группы процессов и environ — POSIX; таблица процессов и WMI — Windows),
 * и порог одной ОС краснел бы на ветках другой. Связывает объединение двух карт: прогон на этой
 * машине (`apps/core/coverage/coverage-final.json`) + прогон в Linux-контейнере
 * (`core-linux.mjs --coverage-out`). Порог — `apps/core/coverage-thresholds.json`.
 *
 *   node tools/core-coverage-merge.mjs --run               # оба прогона, слияние, порог (pnpm core:test:all)
 *   node tools/core-coverage-merge.mjs --run-linux [--host <map>] [-- …]  # только Linux заново
 *   node tools/core-coverage-merge.mjs [--host <map>] [--linux <map>]     # только слияние готовых карт
 *   node tools/core-coverage-merge.mjs --normalize <map> <out>             # пути → от корня (CI, на раннере)
 *   node tools/core-coverage-merge.mjs --map windows=<map> --map linux=<map> --map macos=<map>
 *                                                                          # слияние N карт (CI, задание core-coverage)
 *
 * CI (`.github/workflows/ci.yml`): каждое задание ОС приводит свою карту `--normalize` на своём
 * раннере (корень у каждого свой: `D:\a\…`, `/home/runner/…`, `/Users/runner/…`), слияние читает
 * уже приведённые карты — путь от корня, начинается с `apps/core/`.
 *
 * `--run` пишет обе карты в СВОЙ каталог `apps/core/coverage/merge-<pid>/`: общий
 * `coverage/` ядра делят параллельные прогоны (несколько агентов в одной копии), и чужой
 * прогон, начавшийся посреди нашего, стёр бы карту (замер 28.10: host.ts 99% → 0%).
 * Аргументы после `--` уходят vitest в контейнере (mustfail: `--exclude=…`).
 *
 * Выход 1 — слитое покрытие ниже порога ИЛИ упал хоть один прогон; 2 — карты нет / путь не из
 * репозитория / наборы файлов разные / исходник правили между прогонами. Пути карт приводятся к пути от корня репозитория: `C:\work\…\apps\core\src\…`
 * и `/home/node/w/apps/core/src/…` — один и тот же файл, иначе слияние посчитало бы их двумя.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'apps', 'core');
/** Корень копии внутри контейнера (core-linux.mjs, `W=/home/node/w`). */
const CONTAINER_ROOT = '/home/node/w/';
const KEYS = ['lines', 'branches', 'functions', 'statements'];

const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const own = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
const linuxExtra = dashDash >= 0 ? argv.slice(dashDash + 1) : [];
const runHost = own.includes('--run');
const runLinux = runHost || own.includes('--run-linux');
const option = (name) => {
  const at = own.indexOf(name);
  return at >= 0 && own[at + 1] ? resolve(own[at + 1]) : undefined;
};
// Внутри coverage/ (в .gitignore). Без `--run` — карты обычного `pnpm core:test` и прошлого
// `--run-linux`, если пути не названы явно.
const RUN_DIR = join(CORE, 'coverage', `merge-${process.pid}`);

/**
 * Карта последнего `pnpm core:test`: у каждого прогона свой `coverage/run-<pid>`
 * (apps/core/vitest.coverage-dir.ts), берётся самая свежая; плоский `coverage/` — запасной путь.
 */
function latestHostMap() {
  const root = join(CORE, 'coverage');
  const maps = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.startsWith('run-'))
        .map((name) => join(root, name, 'coverage-final.json'))
        .filter((map) => existsSync(map))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  return maps[0] ?? join(root, 'coverage-final.json');
}

const HOST_MAP = runHost
  ? join(RUN_DIR, 'host', 'coverage-final.json')
  : (option('--host') ?? latestHostMap());
const LINUX_MAP =
  option('--linux') ??
  (runLinux
    ? join(RUN_DIR, 'linux', 'coverage-final.json')
    : join(CORE, 'coverage', 'linux', 'coverage-final.json'));

/**
 * `--map label=path`, сколько угодно раз: метка — имя ОС в выводе, у каждой своя. Ошибки —
 * списком: без метки, без пути, повтор метки; меньше двух карт сливать нечего.
 */
export function parseMapArgs(args) {
  const maps = [];
  const errors = [];
  args.forEach((arg, at) => {
    if (arg !== '--map') return;
    const value = args[at + 1] ?? '';
    const eq = value.indexOf('=');
    const label = eq > 0 ? value.slice(0, eq) : '';
    const path = eq > 0 ? value.slice(eq + 1) : '';
    if (!label || !path) errors.push(`--map ${JSON.stringify(value)} is not label=path`);
    else if (maps.some((map) => map.label === label)) errors.push(`--map label ${label} repeated`);
    else maps.push({ label, path: resolve(path) });
  });
  if (maps.length === 1) errors.push('--map needs at least two maps');
  return { maps, errors };
}

const mapArgs = parseMapArgs(own);

/** Корень ядра в карте, уже приведённой `--normalize`: путь от корня репозитория без `..`. */
const ROOT_RELATIVE = /^apps\/core\//;

/** Путь карты → путь от корня репозитория с `/`; чужой корень — отказ, не тихое слияние. */
export function repoRelative(path, root = ROOT) {
  const slashed = path.replace(/\\/g, '/');
  if (slashed.startsWith(CONTAINER_ROOT)) return slashed.slice(CONTAINER_ROOT.length);
  const base = `${root.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  // Буква диска на Windows бывает в любом регистре (c:\ из pnpm, C:\ из node).
  if (slashed.toLowerCase().startsWith(base.toLowerCase())) return slashed.slice(base.length);
  // Карта CI приведена на своём раннере (`--normalize`): у каждого раннера корень свой.
  if (ROOT_RELATIVE.test(slashed) && !slashed.split('/').includes('..')) return slashed;
  return null;
}

/** Карта с путями от корня репозитория; `foreign` — пути вне репозитория и контейнера. */
export function normalizeMap(raw, root = ROOT) {
  const out = {};
  const foreign = [];
  for (const [key, file] of Object.entries(raw)) {
    const rel = repoRelative(file.path ?? key, root);
    if (!rel) {
      foreign.push(file.path ?? key);
      continue;
    }
    out[rel] = { ...file, path: rel };
  }
  return { map: out, foreign };
}

function pct(summary, key) {
  return summary[key].pct;
}

/** Сводка по карте: проценты по четырём осям. */
export function summarize(map) {
  const summary = map.getCoverageSummary().toJSON();
  return Object.fromEntries(KEYS.map((key) => [key, pct(summary, key)]));
}

/**
 * Ошибки файла порогов: каждая из четырёх осей — конечное число 0…100, лишних ключей нет.
 * Без проверки `{}` проходил любой замер (`x < undefined` ложно), а опечатка `statement`
 * молча снимала ось с порога (ревью F-80).
 */
export function thresholdErrors(thresholds) {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    return ['thresholds must be an object'];
  }
  const errors = [];
  for (const key of KEYS) {
    const value = thresholds[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      errors.push(`${key}: ${JSON.stringify(value)} is not a number 0..100`);
    }
  }
  for (const key of Object.keys(thresholds)) {
    if (!KEYS.includes(key)) errors.push(`unknown key ${JSON.stringify(key)}`);
  }
  return errors;
}

/**
 * Оси ниже порога: `[{key, actual, threshold}]`. Ось без числа с любой стороны — недобор, а не
 * «прошла»: сравнение с `undefined`/`NaN` всегда ложно и пропускало бы её молча.
 */
export function shortfalls(numbers, thresholds) {
  const short = (key) => {
    const actual = numbers[key];
    const threshold = thresholds[key];
    if (!Number.isFinite(actual) || !Number.isFinite(threshold)) return true;
    return actual < threshold;
  };
  return KEYS.filter(short).map((key) => ({
    key,
    actual: numbers[key],
    threshold: thresholds[key],
  }));
}

/** `--selftest`: проверки порога должны краснеть на пустом, опечатке и нечисле. */
function selftest() {
  const good = { lines: 85, branches: 80, functions: 85, statements: 85 };
  const all = { lines: 90, branches: 90, functions: 90, statements: 90 };
  const cases = [
    ['valid thresholds have no errors', thresholdErrors(good).length === 0],
    ['{} is refused', thresholdErrors({}).length === 4],
    [
      'typo `statement` is refused',
      thresholdErrors({ ...good, statement: 85, statements: undefined }).length === 2,
    ],
    ['string threshold is refused', thresholdErrors({ ...good, lines: '85' }).length === 1],
    [
      'NaN / >100 refused',
      thresholdErrors({ ...good, lines: Number.NaN, branches: 101 }).length === 2,
    ],
    ['array refused', thresholdErrors([]).length === 1],
    ['above threshold passes', shortfalls(all, good).length === 0],
    ['below threshold fails', shortfalls({ ...all, branches: 79.9 }, good).length === 1],
    ['empty thresholds fail every axis', shortfalls(all, {}).length === 4],
    ['missing measured axis fails', shortfalls({ ...all, lines: undefined }, good).length === 1],
    ['normalized CI path is kept', repoRelative('apps/core/src/a.ts') === 'apps/core/src/a.ts'],
    ['relative path outside the core is foreign', repoRelative('src/a.ts') === null],
    ['`..` in a relative path is foreign', repoRelative('apps/core/../../x.ts') === null],
    [
      'three --map labels parse',
      parseMapArgs(['--map', 'a=x', '--map', 'b=y', '--map', 'c=z']).maps.length === 3,
    ],
    [
      'repeated --map label refused',
      parseMapArgs(['--map', 'a=x', '--map', 'a=y']).errors.some((e) => e.includes('repeated')),
    ],
    ['--map without = refused', parseMapArgs(['--map', 'x', '--map', 'b=y']).errors.length === 2],
  ];
  const red = cases.filter(([, ok]) => !ok);
  for (const [name, ok] of cases) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  console.log(`[core-coverage] selftest: ${cases.length - red.length}/${cases.length}`);
  process.exit(red.length ? 1 : 0);
}

/**
 * Слить нормализованные карты (по местоположению — istanbul складывает попадания). Входы
 * копируются: `merge` istanbul правит данные первой карты на месте, и без копии сводка «одной
 * ОС» после слияния показала бы уже слитые цифры (пойман 28.10: windows == MERGED).
 */
export function mergeMaps(maps) {
  const merged = libCoverage.createCoverageMap({});
  for (const map of maps) merged.merge(libCoverage.createCoverageMap(structuredClone(map)));
  return merged;
}

/**
 * Файлы, чья структура (операторы, функции, ветки) в картах разная: исходник правили между
 * прогонами. istanbul сливает по номерам операторов, и карты разных версий файла сложились бы
 * в бессмыслицу — замер 28.10: параллельный агент правил `read-classes.ts` между прогонами.
 */
export function driftedFiles(a, b) {
  const shape = (file) => JSON.stringify([file.statementMap, file.fnMap, file.branchMap]);
  return Object.keys(a).filter((file) => b[file] && shape(a[file]) !== shape(b[file]));
}

function loadMap(path, label) {
  if (!existsSync(path)) {
    console.error(`[core-coverage] ${label} map missing: ${path}`);
    process.exit(2);
  }
  // Пустая или битая карта — названный отказ с кодом 2, а не падение в JSON.parse (ревью m5).
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`[core-coverage] ${label} map unreadable (${error.message}): ${path}`);
    process.exit(2);
  }
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
    console.error(`[core-coverage] ${label} map is empty: ${path}`);
    process.exit(2);
  }
  const { map, foreign } = normalizeMap(raw);
  if (foreign.length) {
    console.error(`[core-coverage] ${label} map has paths outside the repo:`, foreign.slice(0, 5));
    process.exit(2);
  }
  console.log(
    `[core-coverage] ${label}: ${Object.keys(map).length} files · written ${statSync(path).mtime.toISOString()}`,
  );
  return map;
}

/** Файл порогов — названный отказ с кодом 2, как у карты: битый или неполный порог не судит. */
function loadThresholds(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`[core-coverage] thresholds unreadable (${error.message}): ${path}`);
    process.exit(2);
  }
  const errors = thresholdErrors(raw);
  if (errors.length) {
    console.error(`[core-coverage] thresholds invalid: ${path}:`, errors);
    process.exit(2);
  }
  return raw;
}

function line(label, numbers) {
  return `${label.padEnd(16)} ${KEYS.map((key) => `${key} ${numbers[key].toFixed(2)}`).join(' · ')}`;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

/** `--normalize <map> <out>`: карта этого раннера с путями от корня — для слияния на другом раннере. */
function normalizeOnly() {
  const at = own.indexOf('--normalize');
  const [input, output] = [own[at + 1], own[at + 2]];
  if (!input || !output) {
    console.error('[core-coverage] usage: --normalize <map> <out>');
    process.exit(2);
  }
  const map = loadMap(resolve(input), 'input');
  writeFileSync(resolve(output), JSON.stringify(map));
  console.log(`[core-coverage] normalized → ${resolve(output)}`);
}

function main() {
  if (mapArgs.errors.length || (mapArgs.maps.length && runLinux)) {
    console.error('[core-coverage] bad arguments:', [
      ...mapArgs.errors,
      ...(mapArgs.maps.length && runLinux ? ['--map merges ready maps, never with --run'] : []),
    ]);
    process.exit(2);
  }
  let failedRuns = 0;
  if (runHost) {
    console.log(`[core-coverage] ${process.platform} run (this machine)`);
    // Одним аргументом: отдельное значение vitest.config.ts принял бы за фильтр файлов и
    // выключил бы покрытие (`wholeSuite`).
    const reports = `--coverage.reportsDirectory=${dirname(HOST_MAP)}`;
    if (run('pnpm', ['exec', 'vitest', 'run', reports], CORE) !== 0) failedRuns += 1;
  }
  if (runLinux) {
    console.log('[core-coverage] linux run (container)');
    const code = run(
      process.execPath,
      [join(ROOT, 'tools', 'core-linux.mjs'), '--coverage-out', LINUX_MAP, ...linuxExtra],
      ROOT,
    );
    if (code !== 0) failedRuns += 1;
  }
  const hostLabel = process.platform === 'win32' ? 'windows' : process.platform;
  const named = mapArgs.maps.length
    ? mapArgs.maps
    : [
        { label: hostLabel, path: HOST_MAP },
        { label: 'linux', path: LINUX_MAP },
      ];
  const inputs = named.map(({ label, path }) => ({ label, map: loadMap(path, label) }));
  const [first, ...rest] = inputs;
  // Наборы файлов обязаны совпасть: карта, где файла нет, не «не покрыла» его, а не видела —
  // слияние молча засчитало бы чужое покрытие.
  const onlyOne = rest.flatMap(({ map }) => [
    ...Object.keys(first.map).filter((file) => !(file in map)),
    ...Object.keys(map).filter((file) => !(file in first.map)),
  ]);
  if (onlyOne.length) {
    console.error(
      '[core-coverage] maps cover different files:',
      [...new Set(onlyOne)].slice(0, 10),
    );
    process.exit(2);
  }
  const drifted = rest.flatMap(({ map }) => driftedFiles(first.map, map));
  if (drifted.length) {
    console.error('[core-coverage] sources changed between the runs, rerun both:', [
      ...new Set(drifted),
    ]);
    process.exit(2);
  }
  const thresholds = loadThresholds(join(CORE, 'coverage-thresholds.json'));
  for (const { label, map } of inputs) {
    console.log(line(label, summarize(libCoverage.createCoverageMap(structuredClone(map)))));
  }
  const merged = mergeMaps(inputs.map(({ map }) => map));
  const numbers = summarize(merged);
  console.log(line('MERGED', numbers));
  console.log(line('threshold', thresholds));
  const worst = merged
    .files()
    .map((file) => ({ file, lines: merged.fileCoverageFor(file).toSummary().lines.pct }))
    .sort((a, b) => a.lines - b.lines)
    .slice(0, 8);
  console.log('[core-coverage] lowest merged lines:');
  for (const { file, lines } of worst) console.log(`  ${lines.toFixed(1).padStart(5)}  ${file}`);
  const short = shortfalls(numbers, thresholds);
  for (const { key, actual, threshold } of short) {
    console.error(`[core-coverage] MERGED ${key} ${actual.toFixed(2)} < ${threshold}`);
  }
  if (failedRuns) console.error(`[core-coverage] ${failedRuns} run(s) failed`);
  const ok = short.length === 0 && failedRuns === 0;
  console.log(`[core-coverage] merged gate: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) {
  if (own.includes('--selftest')) selftest();
  else if (own.includes('--normalize')) normalizeOnly();
  else main();
}
