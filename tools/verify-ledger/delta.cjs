'use strict';
/**
 * Стадия 3 журнала — прогон «от последнего зелёного» (`.agent/tmp/verify-ledger-design.agent.md`
 * §5 «Delta soundness»). Группы 16–19.10 гоняли `vitest run` целого пакета после каждой
 * правки: 761 файл тестов на прогон ради одного изменённого файла.
 *
 * Утверждение прогона — «тесты пакета зелёные» (`vitest run`) или «тесты, связанные с
 * F, зелёные» (`vitest related F`). Пусть G — дерево последнего зелёного того же
 * семейства, Δ = diff(G, сейчас). Тест вне related(Δ) не поменял ни одного файла своего
 * графа импортов (новая связь меняет импортирующий файл, а он в Δ) — его вердикт с G
 * в силе. Значит, related(Δ) вместе с записью G покрывает утверждение ровно настолько,
 * насколько точен сам `vitest related`. То, чего граф не видит (конфиги, setupFiles,
 * снимки, удаления, файлы, читаемые через fs, соседний пакет, подключённый через
 * node_modules), прогон расширяет до целого.
 *
 * Третья форма — список файлов (`vitest run F`, 24–25.10: 660 из 729 записанных промахов
 * vitest, и ни один не сужался — ключ такого прогона берёт всё дерево, правка где угодно
 * гнала весь F заново). Утверждение — «тесты F зелёные», семейство включает сам F.
 * Δ вне видимого тестам — повтор G; иначе идёт `vitest run F --changed` со своим
 * поставщиком изменений (`vcs-delta.mjs` отдаёт vitest наш Δ): vitest сам пересекает
 * фильтры F с related(Δ) по своему графу. Пустое пересечение — пустой прогон с кодом 0.
 *
 * Граф не видит и путь, собранный строкой: тест запускает `__fixtures__/fake-claude.mjs`
 * дочерним процессом, читает `join(ROOT, 'changelog')`. Поэтому файл пакета, чьё имя
 * названо текстом в Δ-затронутом коде, тоже идёт в Δ (`mentioners`): тест, назвавший
 * изменённый скрипт или каталог вне пакета, прогоняется, а не повторяется.
 *
 * Только vitest и только в режиме `on`: сужение меняет то, что реально идёт, поэтому
 * строка о нём печатается всегда, а `AGENTDECK_VERIFY_LEDGER_DELTA=off` отключает его.
 */
const { execFileSync, spawnSync } = require('node:child_process');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { slash, gitTimeoutMs, panelLocked } = require('./checks.cjs');
const { canonical } = require('./ledger.cjs');

/** Цепочка сужений длиннее или старше — следующий прогон целиком: ошибки сужения не копятся. */
const MAX_CHAIN = 10;
const MAX_CHAIN_AGE_MS = 24 * 3600e3;

/** Файлы, правка которых меняет условия всех тестов разом — граф их не видит. */
const WIDE = [
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(vite|vitest)[^/]*\.(config|workspace)\.[cm]?[jt]s$/,
  /(^|\/)vitest\.(workspace|projects)\.[^/]+$/,
  /(^|\/)(babel\.config[^/]*|\.babelrc[^/]*|\.swcrc|postcss\.config[^/]*)$/,
  /(^|\/)\.env[^/]*$/,
  /(^|\/)setup[^/]*\.[cm]?[jt]sx?$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /(^|\/)__mocks__\//,
];

/** Что граф импортов vitest видит как модуль. Остальное (md, html, картинки) — через fs, целиком. */
const MODULE_EXT = /\.([cm]?[jt]sx?|vue|svelte|css|scss|sass|less)$/;

/** Исполняемый код JS/TS: тест может запустить его дочерним процессом по пути из своего кода. */
const EXEC_EXT = /\.[cm]?[jt]sx?$/;

/**
 * Тест, чей вердикт граф импортов не связывает с проверяемым: обходит каталоги
 * (`server-ru-literals.test.ts` читает каждый модуль `src`), запускает процессы,
 * импортирует путь из переменной. При любой правке он идёт: related его не выберет
 * никогда, и повтор G прятал бы новый красный (ревью 25.10, R3). Шаблон — для `git grep -E`.
 */
const OPAQUE =
  'readdir|opendir|(^|[^[:alnum:]_.])glob(Sync)?\\(|fast-glob|tinyglobby|globby|child_process|execa|cross-spawn|worker_threads|import\\([[:space:]]*[^\'"`[:space:])]';

/** Сторона тестов: сам тест или его помощник (каталог или имя про тесты, фикстуры, заглушки). */
const TEST_SIDE =
  /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__fixtures__|test-utils?|testing|test-helpers?|fixtures)\/|(^|\/)[^/]*(test|fixture|harness|stub|fake)[^/]*\.[cm]?[jt]sx?$/i;

/** Флаги vitest со значением через пробел: значение — не фильтр файлов. */
const VALUE_FLAG =
  /^(-t|-c|--(testNamePattern|project|reporter|config|root|dir|pool|environment|shard|outputFile|testTimeout|hookTimeout|teardownTimeout|maxWorkers|minWorkers|bail|retry|exclude|mode|maxConcurrency|includeSource))$/;

/**
 * Флаги без значения, известные по смыслу. Прочий голый флаг не разобрать — может быть,
 * за ним значение (`--testTimeout 100000` лёг бы в F), и сужения нет. `-u` пишет снимки
 * всех тестов — частичный прогон их бы не обновил.
 */
const BOOL_FLAG =
  /^--(run|passWithNoTests|silent|color|no-color|coverage|no-coverage|globals|dom|isolate|no-isolate|fileParallelism|no-file-parallelism|allowOnly|hideSkippedTests|clearScreen|no-watch|typecheck|logHeapUsage|expandSnapshotDiff|disableConsoleIntercept|printConsoleTrace)$/;

/**
 * Файл лежит в каком-то пакете (каталог с `package.json` ниже корня репозитория).
 * Код вне всех пакетов (`tools/*.mjs`, `scripts/*.mjs`) — общий: тест пакета зовёт
 * его по относительному пути, и ни граф импортов, ни конфиги этого не видят
 * (20.10: тест `apps/server` гонял `tools/tests-cli.mjs`, правка скрипта давала
 * старый зелёный). Код чужого пакета тест достаёт только импортом через
 * node_modules — это `linkedDirs`.
 */
function insidePackage(top, rel) {
  for (let dir = path.posix.dirname(rel); dir && dir !== '.'; dir = path.posix.dirname(dir))
    if (fs.existsSync(path.join(top, dir, 'package.json'))) return true;
  return false;
}

const sha = (data) => nodeCrypto.createHash('sha256').update(data).digest('hex');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: gitTimeoutMs(),
  });
}

/**
 * `run` — весь пакет, `related` — тесты файлов, `files` — `run F` (или `F --run`):
 * фильтры vitest. Своё сужение (`--changed`, `--related`) не перекрываем — как есть.
 */
function vitestShape(args) {
  const positional = [];
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('-')) {
      flags.push(a);
      if (a.includes('=')) continue;
      // Значение флага через пробел — тоже флаг, а не путь: `--project web`, `--reporter dot`.
      if (VALUE_FLAG.test(a) && args[i + 1] !== undefined) {
        flags.push(args[i + 1]);
        i += 1;
      } else if (!BOOL_FLAG.test(a)) return null;
    } else positional.push(a);
  }
  // Свой корень — пути Δ от пакета легли бы мимо графа (`vcs-delta.mjs` упал бы красным).
  if (flags.some((f) => /^(--(changed|related|root|dir)|-r)(=|$)/.test(f))) return null;
  if (positional[0] === 'run' && positional.length === 1) return { mode: 'run', files: [], flags };
  if (positional[0] === 'related' && positional.length > 1)
    return { mode: 'related', files: positional.slice(1), flags };
  const listed = positional[0] === 'run' ? positional.slice(1) : positional;
  const command = ['run', 'related', 'watch', 'dev', 'bench', 'list', 'init', 'typecheck'];
  if (
    listed.length > 0 &&
    !command.includes(listed[0]) &&
    (positional[0] === 'run' || flags.includes('--run'))
  )
    return { mode: 'files', files: listed, flags };
  return null;
}

/** Фильтр из командной строки — в одной форме для семейства: `./src/a.ts` и `src\a.ts` одно. */
const filterForm = (f) => path.posix.normalize(slash(f)).replace(/^\.\//, '');

/**
 * Семейство: тот же запуск, кроме дерева и списка файлов. Другое окружение — другое семейство.
 * `canonical`, а не `JSON.stringify(ctx, ключи)`: массив-заменитель — список имён на ВСЕХ
 * уровнях, и вложенные `env`/`tool` сериализовались пустыми — мутант через окружение или
 * ключ node получал «ничего не изменилось» от зелёного тождества (24.10).
 */
function familyOf(parts, shape) {
  const { tree: _t, args: _a, ...ctx } = parts;
  // У списка файлов флаги — из аргументов ключа: там путь отчёта уже заменён меткой, и
  // прогоны набора Tests с отчётом в новый файл каждый раз — одно семейство.
  const own = shape.mode === 'files' ? (vitestShape(parts.args) ?? shape) : shape;
  const flags = own.flags.filter((f) => f !== '--run' && f !== '--passWithNoTests');
  return sha(
    JSON.stringify({
      ctx: sha(canonical(ctx)),
      mode: shape.mode,
      flags,
      ...(shape.mode === 'files' ? { files: [...new Set(own.files.map(filterForm))].sort() } : {}),
    }),
  ).slice(0, 24);
}

/**
 * Каталог в той же форме, что отдаёт git: на Windows cwd бывает коротким
 * (`RUSYAN~1`), а `--show-toplevel` — длинным, и `path.relative` между ними
 * уводит пакет «вне репозитория» — каждая правка выглядела бы чужой.
 */
function realDir(dir) {
  try {
    return fs.realpathSync.native(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

/** Свой указатель у копии; общий — запасной: первый прогон новой копии сужается от соседней. */
const lastFile = (repo, family, shared = false) =>
  path.join(shared ? repo.store : (repo.local ?? repo.store), 'v1', 'last', `${family}.json`);

function readLast(repo, family) {
  for (const shared of [false, true]) {
    try {
      return JSON.parse(fs.readFileSync(lastFile(repo, family, shared), 'utf8'));
    } catch {
      /* нет — следующий */
    }
  }
  return null;
}

function writeLast(repo, family, body) {
  const files = new Set([lastFile(repo, family), lastFile(repo, family, true)]);
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, file);
  }
}

/** Каталоги `setupFiles` из конфига vitest пакета: правка внутри — всё целиком. */
function setupDirs(pkgAbs) {
  const out = [];
  for (const name of fs.readdirSync(pkgAbs)) {
    if (!/^(vite|vitest)[^/]*\.config\.[cm]?[jt]s$/.test(name)) continue;
    const text = fs.readFileSync(path.join(pkgAbs, name), 'utf8');
    for (const m of text.matchAll(
      /setupFiles\s*:\s*\[([^\]]*)\]|setupFiles\s*:\s*['"`]([^'"`]+)['"`]/g,
    )) {
      const list = m[1] ?? `'${m[2]}'`;
      for (const s of list.matchAll(/['"`]([^'"`]+)['"`]/g)) {
        out.push(slash(path.dirname(path.normalize(s[1]))).replace(/^\.\/?/, ''));
      }
    }
  }
  return out.filter((d) => d && d !== '.');
}

const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Файл модуля по пути импорта без расширения, с `.js` вместо `.ts` или каталогом с index. */
function resolveModule(abs) {
  const tries = [abs, ...CODE_EXT.map((e) => abs + e)];
  if (/\.[cm]?js$/.test(abs)) tries.push(abs.replace(/js$/, 'ts'));
  tries.push(...CODE_EXT.map((e) => path.join(abs, `index${e}`)));
  return tries.find((f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile()) ?? null;
}

/**
 * `setupFiles` и `globalSetup` из конфигов vitest пакета вместе со всем, что они импортируют
 * относительным путём, на любую глубину: vitest перезапускает всё при правке самих файлов
 * настройки, но не их импортов, а граф тестов их не содержит (ревью 25.10, R4: setup →
 * index.ts → globals.ts давал ноль тестов и код 0). Импорт по алиасу (`@/x`, `~/x`, `#x`) не
 * разобрать — `opaque`: тогда любая правка возвращает прогон целиком.
 */
function setupClosure(pkgAbs, configs) {
  const seeds = [];
  for (const file of configs) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(
      /(?:setupFiles|globalSetup)\s*:\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/g,
    ))
      for (const s of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) seeds.push(path.resolve(pkgAbs, s[1]));
  }
  const files = new Set();
  let opaque = false;
  const queue = [...seeds];
  while (queue.length > 0 && files.size < 400) {
    const file = resolveModule(queue.shift());
    if (!file) {
      opaque = true;
      continue;
    }
    const rel = slash(path.relative(pkgAbs, file));
    if (files.has(rel)) continue;
    files.add(rel);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
    )) {
      const spec = m[1];
      if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
      else if (/^[@~#]\/|^#/.test(spec)) opaque = true;
    }
  }
  return { files, opaque: opaque || queue.length > 0 };
}

/** Конфиги vitest пакета: свои файлы в корне пакета и названный `-c`/`--config`. */
function configFiles(pkgAbs, flags = []) {
  const out = fs
    .readdirSync(pkgAbs)
    .filter((n) => /^(vite|vitest)[^/]*\.config\.[cm]?[jt]s$/.test(n))
    .map((n) => path.join(pkgAbs, n));
  for (let i = 0; i < flags.length; i += 1) {
    const m = /^(?:-c|--config)(?:=(.+))?$/.exec(flags[i]);
    if (m) out.push(path.resolve(pkgAbs, m[1] ?? flags[i + 1] ?? ''));
  }
  return out;
}

/**
 * Тесты пакета (и их помощники) на дереве `tree`, которых граф не свяжет с правкой
 * (`OPAQUE`): `null` — поиск не удался (тогда целиком).
 */
function opaqueTests(top, tree, pkgRel) {
  const r = spawnSync('git', ['grep', '-l', '-I', '-E', '-e', OPAQUE, tree, '--', pkgRel || '.'], {
    cwd: top,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: gitTimeoutMs(),
  });
  if (r.status === 1 && !r.stderr) return [];
  if (r.status !== 0) return null;
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(tree.length + 1))
    .filter((p) => EXEC_EXT.test(p) && TEST_SIDE.test(p));
}

/** Соседние пакеты, подключённые этим через `file:`/`link:`/`workspace:` — граф их не пересекает. */
function linkedDirs(top, pkgAbs) {
  let pj;
  try {
    pj = JSON.parse(fs.readFileSync(path.join(pkgAbs, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const deps of [pj.dependencies, pj.devDependencies, pj.peerDependencies]) {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      const m = /^(file|link):(.+)$/.exec(String(spec));
      if (m) out.push(slash(path.relative(top, path.resolve(pkgAbs, m[2]))));
      else if (/^workspace:/.test(String(spec))) {
        // Симлинк в node_modules ведёт к исходнику пакета рабочей области.
        try {
          out.push(
            slash(path.relative(top, fs.realpathSync(path.join(pkgAbs, 'node_modules', name)))),
          );
        } catch {
          /* не установлен — не связан */
        }
      }
    }
  }
  return out.filter((d) => d && !d.startsWith('..'));
}

/**
 * Файлы пакета на дереве `tree`, где текстом названо одно из имён: `null` — поиск не удался
 * (тогда целиком). `git grep` по объекту дерева — то же содержимое, что у ключа, без диска.
 */
function mentioners(top, tree, pkgRel, names) {
  const args = ['grep', '-l', '-I', '-F', ...[...names].flatMap((n) => ['-e', n]), tree, '--'];
  const r = spawnSync('git', [...args, pkgRel || '.'], {
    cwd: top,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: gitTimeoutMs(),
  });
  if (r.status === 1 && !r.stderr) return [];
  if (r.status !== 0) return null;
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(tree.length + 1));
}

/**
 * Что из diff(G, сейчас) видят тесты пакета `cwd`. Ответ: `{ why }` — сужать нельзя, либо
 * `{ files }` — изменённые файлы пакета для related (пусто — тесты не видят ничего).
 * Имя, названное текстом (`mentioners`), — для того, чего граф не видит: изменённый скрипт
 * пакета (тест запускает его дочерним процессом), файл чужого пакета и данные вне пакетов
 * (каталог верхнего уровня — так путь собирают: `join(ROOT, 'changelog')`).
 */
function classify({ top, cwd, baseTree, tree, flags = [] }) {
  let diff;
  try {
    diff = git(top, ['diff-tree', '-r', '--no-renames', '--name-status', baseTree, tree]);
  } catch {
    return { why: 'base-tree-gone' };
  }
  const pkgAbs = realDir(cwd);
  const pkgRel = slash(path.relative(realDir(top), pkgAbs));
  const inPkg = (p) => !pkgRel || p === pkgRel || p.startsWith(`${pkgRel}/`);
  // Путь от пакета — и для чужого пакета (`../lib/src/x.ts`): vitest приводит его к корню сам.
  const relOf = (p) => path.posix.relative(pkgRel || '.', p);
  const configs = configFiles(pkgAbs, flags);
  // Свой корень в конфиге — пути Δ от пакета легли бы мимо графа, как у `--root`.
  if (configs.some((f) => /\b(root|dir)\s*:/.test(readOr(f)))) return { why: 'config-root' };
  const setups = setupDirs(pkgAbs).map((d) => (pkgRel ? `${pkgRel}/${d}` : d));
  const setup = setupClosure(pkgAbs, configs);
  const linked = linkedDirs(top, pkgAbs);
  const changed = [];
  const names = new Set();
  let any = false;
  for (const line of diff.split(/\r?\n/)) {
    if (!line) continue;
    any = true;
    const [status, raw] = line.split('\t');
    const p = slash(raw);
    if (status !== 'M' && status !== 'A') return { why: `widen ${status} ${p}` };
    if (WIDE.some((re) => re.test(p))) return { why: `widen ${p}` };
    if (setups.some((d) => p.startsWith(`${d}/`))) return { why: `widen setup ${p}` };
    if (setup.files.has(relOf(p))) return { why: `widen setup ${p}` };
    if (linked.some((d) => p.startsWith(`${d}/`))) return { why: `widen linked ${p}` };
    if (!inPkg(p)) {
      const packaged = insidePackage(top, p);
      if (EXEC_EXT.test(p) && !packaged) return { why: `widen outside ${p}` };
      names.add(path.posix.basename(p));
      // Код чужого пакета тест достаёт и алиасом, и относительным импортом, не только через
      // node_modules (ревью 25.10, R1: мобильный алиас на contracts повторял старый зелёный) —
      // в Δ, а выберет ли его тест, решает граф vitest.
      if (MODULE_EXT.test(p)) {
        changed.push(relOf(p));
        continue;
      }
      const first = p.split('/')[0];
      if (!packaged && first !== p)
        for (const n of [`${first}/`, `'${first}'`, `"${first}"`, `\`${first}\``]) names.add(n);
      continue;
    }
    // Данные (`*.json` и прочее) тест читает и через fs, мимо графа: ноль выбранных тестов
    // и код 0 (ревью 25.10, R2) — прогон целиком.
    if (!MODULE_EXT.test(p)) return { why: `widen non-module ${p}` };
    if (EXEC_EXT.test(p)) names.add(path.posix.basename(p));
    changed.push(relOf(p));
  }
  if (any && setup.opaque) return { why: 'widen setup-alias' };
  if (names.size > 0) {
    const found = mentioners(top, tree, pkgRel, names);
    if (!found) return { why: 'widen mention-scan' };
    for (const p of found) {
      // Не модуль в граф не входит — его related ничего не даст.
      if (MODULE_EXT.test(p) && !changed.includes(relOf(p))) changed.push(relOf(p));
    }
  }
  if (any) {
    const opaque = opaqueTests(top, tree, pkgRel);
    if (!opaque) return { why: 'widen opaque-scan' };
    for (const p of opaque) if (!changed.includes(relOf(p))) changed.push(relOf(p));
  }
  return { files: changed };
}

function readOr(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** `--experimental.vcsProvider` проверен на vitest 4.1.10; старее — список F целиком. */
function vcsProviderReady(script) {
  try {
    const { version } = JSON.parse(
      fs.readFileSync(path.join(path.dirname(script), 'package.json'), 'utf8'),
    );
    const [a, b, c] = String(version)
      .split('.')
      .map((n) => Number.parseInt(n, 10));
    // Опция `experimental.*`: другой мажор может её убрать, и `--changed` молча взял бы git
    // diff — посторонний выбор тестов (ревью 25.10, F4).
    return a === 4 && (b > 1 || (b === 1 && c >= 10));
  } catch {
    return false;
  }
}

const PROVIDER = path.join(__dirname, 'vcs-delta.mjs');

/**
 * Решение о сужении. Ответ: `{ why }` — сужать нельзя, либо `{ files }` — какие изменённые
 * файлы пакета отдать related (пусто — повтор зелёного G: внутри пакета не изменилось
 * ничего, что видят тесты). Машинный отчёт (`wholeOnly`) только повторяется: суженный
 * дал бы отчёт о части тестов, и потребитель счёл бы прочие пропавшими.
 */
function plan({ repo, parts, match, cwd, tree, now = Date.now(), env = process.env }) {
  if (match.id !== 'vitest' || match.noSkip) return { why: 'not-vitest' };
  // Под замком панели (`ledger.cjs` locked) сужение не выключается из команды модели.
  if (!panelLocked(env) && String(env.AGENTDECK_VERIFY_LEDGER_DELTA ?? '').toLowerCase() === 'off')
    return { why: 'delta-off' };
  const shape = vitestShape(match.args);
  if (!shape) return { why: 'shape' };
  const family = familyOf(parts, shape);
  const last = readLast(repo, family);
  if (!last) return { why: 'no-green', family, shape };
  if ((last.chain ?? 0) >= MAX_CHAIN || now - (last.fullAt ?? 0) > MAX_CHAIN_AGE_MS)
    return { why: 'chain-full', family, shape };
  const seen = classify({ top: repo.top, cwd, baseTree: last.tree, tree, flags: shape.flags });
  if (seen.why) return { why: seen.why, family, shape };
  const changed = seen.files;
  if (changed.length > 0 && match.wholeOnly) return { why: 'report', family, shape };
  if (changed.length > 0 && shape.mode === 'files') {
    if (!vcsProviderReady(match.script)) return { why: 'vitest-version', family, shape };
    if (!fs.existsSync(PROVIDER)) return { why: 'no-provider', family, shape };
  }
  const pkgAbs = realDir(cwd);
  if (shape.mode === 'related') {
    // F′ \ Δ ⊆ F: файл, которого не было в зелёном прогоне и который не менялся, — его тесты не шли.
    const delta = new Set(changed);
    const before = new Set(last.files ?? []);
    const now_ = shape.files.map((f) => slash(path.relative(pkgAbs, path.resolve(pkgAbs, f))));
    const fresh = now_.find((f) => !delta.has(f) && !before.has(f));
    if (fresh) return { why: `new-file ${fresh}`, family, shape };
  }
  return { files: changed, family, shape, last };
}

/**
 * Каждый файл Δ ещё и в настоящей форме пути: при cwd через junction корень vitest — в форме
 * ссылки, а зависимости граф держит по настоящему пути (`/@fs/…`), и путь от корня ни с
 * одной не совпадал — ноль тестов, код 0 (ревью 25.10, R5). Форм две: vite раскрывает ссылку
 * через `fs.realpathSync`, а он оставляет короткое имя каталога (`RUSYAN~1`) как есть —
 * `.native` дал бы длинное, и граф снова мимо (пойман настоящим vitest через junction).
 * Лишняя форма выбор не сужает.
 */
function withRealForms(cwd, files) {
  const out = new Set(files);
  for (const f of files) {
    for (const real of [fs.realpathSync, fs.realpathSync.native]) {
      try {
        out.add(slash(real(path.resolve(cwd, f))));
      } catch {
        /* нет файла — хватит относительного */
      }
    }
  }
  return [...out];
}

/**
 * argv для сужения: `related <Δ> --run --passWithNoTests` + прежние флаги. У списка файлов —
 * набранная команда как есть плюс `--changed`, а Δ отдаёт поставщик изменений (`deltaEnv`):
 * vitest берёт из F только тесты, чей граф задевает Δ. Пересборка `run F флаги` уводила
 * значение флага (`--testTimeout 100000`, `-c cfg`) в чужое место (ревью 25.10, F1).
 */
function narrowedArgs(shape, files, { args = [], cwd = process.cwd() } = {}) {
  if (shape.mode === 'files')
    return [
      ...args.filter((a) => a !== '--passWithNoTests'),
      '--changed',
      `--experimental.vcsProvider=${slash(PROVIDER)}`,
      '--passWithNoTests',
    ];
  const flags = shape.flags.filter((f) => f !== '--run' && f !== '--passWithNoTests');
  return ['related', ...withRealForms(cwd, files), ...flags, '--run', '--passWithNoTests'];
}

/**
 * Δ для `vcs-delta.mjs` — путями от пакета: vitest сам приводит их к своему корню, в той
 * же форме, что у модулей графа. Абсолютный путь сверялся бы строкой, и на Windows
 * короткий `RUSYAN~1` против длинного не совпал ни с одним модулем — пустое пересечение,
 * ложный зелёный (поймано настоящим vitest в тесте). Корень другой — поставщик падает.
 */
const deltaEnv = (cwd, files) => ({
  AGENTDECK_VERIFY_LEDGER_DELTA_FILES: JSON.stringify({
    root: realDir(cwd),
    files: withRealForms(cwd, files),
  }),
});

/** Файлы утверждения для записи «последний зелёный»: у `related` — весь F, у `run` — не нужны. */
function claimFiles(shape, cwd) {
  if (shape.mode !== 'related') return null;
  const pkgAbs = realDir(cwd);
  return shape.files.map((f) => slash(path.relative(pkgAbs, path.resolve(pkgAbs, f))));
}

module.exports = {
  linkedDirs,
  classify,
  plan,
  narrowedArgs,
  deltaEnv,
  claimFiles,
  readLast,
  writeLast,
  vitestShape,
  familyOf,
  MAX_CHAIN,
};
