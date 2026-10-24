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
 * Только vitest и только в режиме `on`: сужение меняет то, что реально идёт, поэтому
 * строка о нём печатается всегда, а `AGENTDECK_VERIFY_LEDGER_DELTA=off` отключает его.
 */
const { execFileSync } = require('node:child_process');
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

/** `run` — весь пакет, `related` — тесты файлов; остальное (фильтры, `--project` без run) не сужаем. */
function vitestShape(args) {
  const positional = [];
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('-')) {
      flags.push(a);
      // Значение флага через пробел — тоже флаг, а не путь: `--project web`, `--reporter dot`.
      if (
        !a.includes('=') &&
        /^--(project|reporter|config|root|dir|pool|environment|shard)$/.test(a) &&
        args[i + 1] !== undefined
      ) {
        flags.push(args[i + 1]);
        i += 1;
      }
    } else positional.push(a);
  }
  if (positional[0] === 'run' && positional.length === 1) return { mode: 'run', files: [], flags };
  if (positional[0] === 'related' && positional.length > 1)
    return { mode: 'related', files: positional.slice(1), flags };
  return null;
}

/**
 * Семейство: тот же запуск, кроме дерева и списка файлов. Другое окружение — другое семейство.
 * `canonical`, а не `JSON.stringify(ctx, ключи)`: массив-заменитель — список имён на ВСЕХ
 * уровнях, и вложенные `env`/`tool` сериализовались пустыми — мутант через окружение или
 * ключ node получал «ничего не изменилось» от зелёного тождества (24.10).
 */
function familyOf(parts, shape) {
  const { tree: _t, args: _a, ...ctx } = parts;
  const flags = shape.flags.filter((f) => f !== '--run' && f !== '--passWithNoTests');
  return sha(
    JSON.stringify({
      ctx: sha(canonical(ctx)),
      mode: shape.mode,
      flags,
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
 * Решение о сужении. Ответ: `null` — сужать нельзя (с причиной в `why`), либо
 * `{ files }` — какие изменённые файлы пакета отдать `vitest related` (пусто — внутри
 * пакета не изменилось ничего, что видят тесты).
 */
function plan({ repo, parts, match, cwd, tree, now = Date.now(), env = process.env }) {
  if (match.id !== 'vitest' || match.noSkip) return { why: 'not-vitest' };
  // Суженный прогон дал бы отчёт лишь о части тестов — потребитель счёл бы прочие пропавшими.
  if (match.wholeOnly) return { why: 'report' };
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

  let diff;
  try {
    diff = git(repo.top, ['diff-tree', '-r', '--no-renames', '--name-status', last.tree, tree]);
  } catch {
    return { why: 'base-tree-gone', family, shape };
  }
  const pkgAbs = realDir(cwd);
  const pkgRel = slash(path.relative(realDir(repo.top), pkgAbs));
  const inPkg = (p) => !pkgRel || p === pkgRel || p.startsWith(`${pkgRel}/`);
  const setups = setupDirs(pkgAbs).map((d) => (pkgRel ? `${pkgRel}/${d}` : d));
  const linked = linkedDirs(repo.top, pkgAbs);
  const changed = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line) continue;
    const [status, raw] = line.split('\t');
    const p = slash(raw);
    if (status !== 'M' && status !== 'A') return { why: `widen ${status} ${p}`, family, shape };
    if (WIDE.some((re) => re.test(p))) return { why: `widen ${p}`, family, shape };
    if (setups.some((d) => p.startsWith(`${d}/`)))
      return { why: `widen setup ${p}`, family, shape };
    if (linked.some((d) => p.startsWith(`${d}/`)))
      return { why: `widen linked ${p}`, family, shape };
    if (!inPkg(p)) {
      // Данные вне пакетов (md, json), читаемые тестом через fs, сюда не попадают:
      // правка документации гнала бы всё целиком, а такие чтения редки.
      if (EXEC_EXT.test(p) && !insidePackage(repo.top, p))
        return { why: `widen outside ${p}`, family, shape };
      continue;
    }
    const rel = pkgRel ? p.slice(pkgRel.length + 1) : p;
    const moduleLike = MODULE_EXT.test(p) || (/\.json$/.test(p) && /^src\//.test(rel));
    if (!moduleLike) return { why: `widen non-module ${p}`, family, shape };
    changed.push(rel);
  }
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

/** argv для сужения: `related <Δ> --run --passWithNoTests` + прежние флаги. */
function narrowedArgs(shape, files) {
  const flags = shape.flags.filter((f) => f !== '--run' && f !== '--passWithNoTests');
  return ['related', ...files, ...flags, '--run', '--passWithNoTests'];
}

/** Файлы утверждения для записи «последний зелёный»: у `related` — весь F, у `run` — не нужны. */
function claimFiles(shape, cwd) {
  if (shape.mode !== 'related') return null;
  const pkgAbs = realDir(cwd);
  return shape.files.map((f) => slash(path.relative(pkgAbs, path.resolve(pkgAbs, f))));
}

module.exports = {
  linkedDirs,
  plan,
  narrowedArgs,
  claimFiles,
  readLast,
  writeLast,
  vitestShape,
  familyOf,
  MAX_CHAIN,
};
