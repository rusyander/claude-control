#!/usr/bin/env node
// Проверка строк переноса (спека 10:18, этап 10): каждый модуль под перечисленными каталогами
// панели назван строкой таблицы спеки 10 или записью «stays», а строка, помеченная `switched`
// в колонке ph, означает, что старого пути больше нет. Красное — непокрытый модуль или живой путь
// переключённой строки; оба печатаются поимённо. Таблица — единственный источник: строки не
// переписываются сюда второй копией, скрипт читает саму спеку.
//
//   node tools/check-core/migration-rows.mjs [--spec <md>] [--root <repo>] [--json]
//
// Выход: 0 — зелёное, 1 — красное, 2 — нет спеки или неверный вызов.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..');
const DEFAULT_SPEC = join('.agent', 'core-spec', '10-migration.agent.md');

const SERVER = 'apps/server/src';
const KIT_HOOKS = 'apps/server/assets/kit/agentdeck-kit/hooks';
const CONTRACTS = 'packages/contracts/src';

/** Каталоги, чьи прямые дети — модули (10:18). */
const MODULE_DIRS = [
  'chat',
  'project-git',
  'integrations',
  'platform',
  'local-models',
  'endpoints',
  'models',
  'dlp',
  'usage-limits',
  'assistant-runner',
  'panel-agent',
].map((d) => `${SERVER}/domains/${d}`);

const EXT = /(\.d\.mts|\.d\.ts|\.types\.ts|\.tsx|\.ts|\.mjs|\.cjs|\.js|\.json|\.md)$/;

/** Ключ модуля: путь без расширения; `foo.types.ts` принадлежит `foo`. */
export function moduleKey(path) {
  return path.replace(/\/+$/, '').replace(EXT, '');
}

const isTestLike = (name) =>
  /\.(test|spec)\./.test(name) || name === '__fixtures__' || name === '__snapshots__';

/** Раскрыть `{a,b}` (один уровень, сколько угодно групп). */
export function expandBraces(token) {
  const m = token.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [token];
  return m[2].split(',').flatMap((part) => expandBraces(`${m[1]}${part.trim()}${m[3]}`));
}

/**
 * Путь строки спеки → путь от корня репозитория (10:5-7): `lib/`, `providers/`, `bootstrap/` — от
 * `apps/server/src`, `packages/` и `tools/` — от корня, остальное — под `domains/`.
 */
function rootPath(token) {
  if (/^(packages|tools)\//.test(token)) return token;
  if (/^(lib|providers|bootstrap)\//.test(token)) return `${SERVER}/${token}`;
  return `${SERVER}/domains/${token}`;
}

/**
 * Ячейка модулей → пути. Скобки — пояснения, их имена не строки. Голое имя (без `/`) наследует
 * каталог предыдущего имени ячейки; слово `kit` перед именем — каталог хуков набора, `contracts`
 * — каталог контрактов. `~/…` (слой владельца) вне репозитория и не проверяется.
 */
export function cellPaths(cell) {
  let text = cell;
  for (let prev = ''; prev !== text;) {
    prev = text;
    text = text.replace(/\([^()]*\)/g, ' ');
  }
  const out = [];
  let dir = null;
  let last = 0;
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const before = text.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const raw = m[1]
      .trim()
      .replace(/\/\*\*?$/, '')
      .replace(/\/$/, '');
    if (!raw || raw.startsWith('~') || /\s/.test(raw)) continue;
    if (/\bkit\b/.test(before)) dir = KIT_HOOKS;
    else if (/\bcontracts\b/.test(before) && !raw.includes('/')) dir = CONTRACTS;
    for (const token of expandBraces(raw)) {
      const path = token.includes('/') || dir === null ? rootPath(token) : `${dir}/${token}`;
      out.push(path);
      dir = dirname(path);
    }
  }
  return out;
}

/**
 * Спека → строки и записи «stays». Строка таблицы `| module | class | ph |`; `switched` в ph —
 * переключена; ph `—` с классом «stays …» — запись остающегося. Раздел `## Stays` — прозой:
 * имена в обратных кавычках, сначала под `domains/chat/`, иначе под `domains/`.
 */
export function parseSpec(text, exists = () => false) {
  const rows = [];
  const stays = [];
  const lines = text.split(/\r?\n/);
  let inStays = false;
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) inStays = /^##\s+Stays\b/i.test(line);
    if (inStays) {
      // «Kit hooks without a core class … stay» — хук набора без строки остаётся в наборе.
      if (/\bKit hooks\b/.test(line)) stays.push({ id: `10:${i + 1}`, path: `${KIT_HOOKS}/*` });
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const name = m[1].trim();
        if (!name || name.startsWith('~') || /\s/.test(name)) continue;
        const chat = `${SERVER}/domains/chat/${name}`;
        stays.push({ id: `10:${i + 1}`, path: exists(chat) ? chat : `${SERVER}/domains/${name}` });
      }
      return;
    }
    if (!line.startsWith('|')) return;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3 || /^-+$/.test(cells[0]) || cells[0] === 'module') return;
    const [module, klass, ph] = cells;
    const paths = cellPaths(module);
    if (paths.length === 0) return;
    const id = `10:${i + 1}`;
    if (ph === '—' && /^stays\b/i.test(klass)) {
      for (const path of paths) stays.push({ id, path });
      return;
    }
    rows.push({ id, paths, switched: /\bswitched\b/i.test(ph) });
  });
  return { rows, stays };
}

/** Модули 10:18 — прямые дети каталогов, `domains/provider-*`, хуки набора, `bootstrap/*-wiring`, `providers/`, `tools/qa/stub-*`. */
export function listModules(root) {
  const children = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return [];
    return readdirSync(abs)
      .filter((name) => !isTestLike(name))
      .map((name) => `${rel}/${name}`);
  };
  const keys = new Set();
  for (const dir of MODULE_DIRS) for (const p of children(dir)) keys.add(moduleKey(p));
  for (const p of children(`${SERVER}/domains`)) {
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (name.startsWith('provider-')) keys.add(moduleKey(p));
  }
  for (const p of children(KIT_HOOKS)) keys.add(moduleKey(p));
  for (const p of children(`${SERVER}/bootstrap`)) {
    if (/-wiring$/.test(moduleKey(p))) keys.add(moduleKey(p));
  }
  for (const p of children(`${SERVER}/providers`)) keys.add(moduleKey(p));
  for (const p of children('tools/qa')) {
    if (/\/stub-[^/]*$/.test(p)) keys.add(moduleKey(p));
  }
  return [...keys].sort();
}

/** Покрывает ли путь строки модуль: тот же ключ, предок, потомок или маска `*` в последнем шаге. */
export function covers(rowPath, module) {
  const key = moduleKey(rowPath);
  if (key.includes('*')) {
    const re = new RegExp(
      `^${key.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}(/.*)?$`,
    );
    return re.test(module);
  }
  // Строка, назвавшая файл внутри модуля (`platform/routing/routing.ts`), — строка этого модуля.
  return module === key || module.startsWith(`${key}/`) || key.startsWith(`${module}/`);
}

/** Есть ли путь строки на диске (с любым из расширений модуля или каталогом). */
export function pathExists(root, rowPath) {
  const key = moduleKey(rowPath);
  if (key.includes('*')) return false;
  const candidates = [
    rowPath,
    key,
    ...['.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.md'].map((e) => key + e),
  ];
  return candidates.some((c) => {
    try {
      statSync(join(root, c));
      return true;
    } catch {
      return false;
    }
  });
}

export function checkRows({ root, specText }) {
  const exists = (rel) => pathExists(root, rel);
  const { rows, stays } = parseSpec(specText, exists);
  const all = [...rows.flatMap((r) => r.paths), ...stays.map((s) => s.path)];
  const modules = listModules(root);
  const uncovered = modules.filter((m) => !all.some((p) => covers(p, m)));
  const alive = rows
    .filter((r) => r.switched)
    .flatMap((r) => r.paths.filter(exists).map((path) => ({ id: r.id, path })));
  return {
    rows: rows.length,
    switched: rows.filter((r) => r.switched).length,
    stays: stays.length,
    modules: modules.length,
    uncovered,
    alive,
  };
}

function main(argv) {
  const arg = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const root = resolve(arg('--root') ?? DEFAULT_ROOT);
  const specPath = resolve(root, arg('--spec') ?? DEFAULT_SPEC);
  if (!existsSync(specPath)) {
    console.error(`[migration-rows] spec not found: ${specPath}`);
    return 2;
  }
  const result = checkRows({ root, specText: readFileSync(specPath, 'utf8') });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[migration-rows] rows ${result.rows} (switched ${result.switched}), stays ${result.stays}, modules ${result.modules}`,
    );
    for (const m of result.uncovered) console.log(`UNCOVERED ${m} — no row and no stays entry`);
    for (const a of result.alive)
      console.log(`ALIVE ${a.id} ${a.path} — row is switched, path still exists`);
    console.log(
      result.uncovered.length + result.alive.length === 0
        ? '[migration-rows] green'
        : `[migration-rows] red: ${result.uncovered.length} uncovered, ${result.alive.length} alive on switched rows`,
    );
  }
  return result.uncovered.length + result.alive.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
