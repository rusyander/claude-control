import type { CheckEntry } from '@agentdeck/contracts/core/records';
import type {
  DetectedCheck,
  JsPm,
  StackFinding,
  StackRow,
  WorkspaceKind,
} from './profile.types.ts';
import { isConfigFile } from './inputs.ts';
import { baseName, dirName, joinRel, type ViewIndex } from './view.ts';

/**
 * JS/TS (04:46, 04:122): скрипты пакета, раскладка воркспейсов (pnpm / yarn / npm / bun,
 * turbo / nx), раннер тестов. Логика скриптов — порт панельного `project-checks.ts` (только
 * объявленное самим проектом; заглушка `npm init` — не проверка), без импорта: ядро — отдельный
 * процесс. `{units}` в элементе argv раннер повторяет на каждую единицу (`--filter={units}` →
 * `--filter=a --filter=b`): у pnpm, npm и bun селектор пакета — один на флаг.
 */

/** Скрипт → роль. Порядок — как их гонять; `build` — сборка, не проверка, в набор по умолчанию не входит. */
const SCRIPT_ROLES: [string, DetectedCheck['role']][] = [
  ['lint', 'static'],
  ['format:check', 'static'],
  ['typecheck', 'static'],
  ['type-check', 'static'],
  ['check-types', 'static'],
  ['types', 'static'],
  ['check', 'static'],
  ['test', 'test'],
  ['test:e2e', 'live'],
  ['e2e', 'live'],
  ['build', 'build'],
];

const CLASS_OF: Record<DetectedCheck['role'], CheckEntry['class']> = {
  static: 'static',
  test: 'test-runner',
  live: 'live',
  build: 'build',
};

const LOCKS: [string, JsPm][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

interface Manifest {
  name?: string;
  scripts: Record<string, string>;
  deps: string[];
  workspaces: string[];
  packageManager?: { name: string; version: string };
}

function readManifest(view: ViewIndex, path: string): Manifest | undefined {
  const json = view.json(path);
  if (!json) return undefined;
  const scripts: Record<string, string> = {};
  if (json.scripts && typeof json.scripts === 'object') {
    for (const [k, v] of Object.entries(json.scripts as Record<string, unknown>))
      if (typeof v === 'string') scripts[k] = v;
  }
  const deps = new Set<string>();
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const block = json[field];
    if (block && typeof block === 'object') for (const k of Object.keys(block)) deps.add(k);
  }
  const ws = json.workspaces;
  const list = Array.isArray(ws)
    ? ws
    : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)
      ? (ws as { packages: unknown[] }).packages
      : [];
  const pmField = typeof json.packageManager === 'string' ? json.packageManager : undefined;
  const pmMatch = pmField ? /^(pnpm|yarn|npm|bun)@([^+\s]+)/.exec(pmField) : null;
  return {
    ...(typeof json.name === 'string' ? { name: json.name } : {}),
    scripts,
    deps: [...deps],
    workspaces: list.filter((x): x is string => typeof x === 'string'),
    ...(pmMatch
      ? { packageManager: { name: pmMatch[1] as string, version: pmMatch[2] as string } }
      : {}),
  };
}

/** Строки `packages:` из pnpm-workspace.yaml — без YAML-библиотеки: формат там один. */
export function pnpmWorkspaceGlobs(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '');
    if (/^packages\s*:/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^\S/.test(line)) break;
    const item = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
    if (inside && item) out.push(item[1] as string);
  }
  return out;
}

/** Маска воркспейса → точное совпадение каталога (`apps/*` — ровно один уровень). */
export function workspaceGlobMatches(glob: string, dir: string): boolean {
  const clean = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  let source = '';
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i] as string;
    if (c === '*' && clean[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(dir);
}

function pmOf(view: ViewIndex, root: string, manifest: Manifest | undefined): JsPm {
  const declared = manifest?.packageManager?.name;
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'npm' || declared === 'bun')
    return declared;
  for (const [lock, pm] of LOCKS) if (view.has(joinRel(root, lock))) return pm;
  if (view.has(joinRel(root, 'pnpm-workspace.yaml'))) return 'pnpm';
  return 'npm';
}

export function pmExec(pm: JsPm, bin: string): string[] {
  if (pm === 'pnpm') return ['pnpm', 'exec', bin];
  if (pm === 'yarn') return ['yarn', bin];
  if (pm === 'bun') return ['bunx', bin];
  return ['npx', '--no-install', bin];
}

function runScript(pm: JsPm, script: string): string[] {
  return [pm, 'run', script];
}

function runInUnits(kind: WorkspaceKind, pm: JsPm, script: string): string[] {
  switch (kind) {
    case 'turbo':
      return [...pmExec(pm, 'turbo'), 'run', script, '--filter={units}'];
    case 'nx':
      return [...pmExec(pm, 'nx'), 'run-many', `--target=${script}`, '--projects={units}'];
    case 'pnpm':
      // Селектор без совпадений у pnpm — «No projects matched» и выход 0: зелёный без прогона.
      return ['pnpm', '--filter={units}', '--fail-if-no-match', 'run', script];
    case 'yarn':
      return ['yarn', 'workspaces', 'foreach', '--include={units}', 'run', script];
    case 'bun':
      return ['bun', 'run', '--filter={units}', script];
    case 'npm':
      return ['npm', 'run', script, '--workspace={units}'];
  }
}

/**
 * Бинарь члена воркспейса из корня (A2r3-Q03): селектор пакета менеджера уводит команду в каталог
 * члена — раннер ищется в его `node_modules/.bin`, и действует его конфиг. `pnpm exec` из корня не
 * видел vitest, стоящий только в члене («Command "vitest" not found»). Менеджер — корня (turbo/nx
 * свои задачи держат скриптами, бинарь члена ведёт менеджер). Пробы: pnpm 10 и npm 10 — команда
 * идёт в каталоге члена; bun `--filter` гоняет только скрипты — узкого прогона нет, вся единица.
 */
function memberExec(pm: JsPm, bin: string): string[] | undefined {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', '--filter={units}', '--fail-if-no-match', 'exec', bin];
    case 'npm':
      return ['npx', '--no-install', '--workspace={units}', bin];
    case 'yarn':
      return ['yarn', 'workspaces', 'foreach', '--include={units}', 'run', bin];
    case 'bun':
      return undefined;
  }
}

function runnerOf(body: string, deps: string[]): 'vitest' | 'jest' | 'playwright' | undefined {
  for (const r of ['vitest', 'jest', 'playwright'] as const)
    if (new RegExp(`\\b${r}\\b`).test(body)) return r;
  for (const r of ['vitest', 'jest'] as const) if (deps.includes(r)) return r;
  if (deps.includes('@playwright/test')) return 'playwright';
  return undefined;
}

/**
 * `exec` — как запустить бинарь раннера: в корне `pmExec`, у членов `memberExec`. `inUnit` — селектор
 * уводит раннер в каталог члена: `{files}` переводятся оттуда (`filesFrom: 'unit'`).
 */
function filterFor(
  runner: 'vitest' | 'jest' | 'playwright' | undefined,
  exec: (bin: string) => string[] | undefined,
  inUnit = false,
): CheckEntry['filter'] | undefined {
  if (runner === undefined) return undefined;
  const bin = exec(runner);
  // Бинарь не запустить одной командой — узкого прогона нет: гонится вся единица (дольше, но честно).
  if (bin === undefined) return undefined;
  const from = inUnit ? { filesFrom: 'unit' as const } : {};
  // Узкий прогон — ядра: репортёр, называющий прошедшие тесты (без них запись не доказывает кейсу
  // его тест, P50); list у playwright ещё и не поднимает сервер отчёта html после красного.
  if (runner === 'vitest')
    return {
      kind: 'vitest',
      argv: [...bin, 'run', '{files}', '--reporter=verbose', '-t', '{tests}'],
      ...from,
    };
  if (runner === 'jest')
    return { kind: 'jest', argv: [...bin, '{files}', '-t', '{tests}'], ...from };
  return {
    kind: 'playwright',
    argv: [...bin, 'test', '{files}', '--reporter=list', '-g', '{tests}'],
    ...from,
  };
}

function isRealScript(body: string | undefined): body is string {
  // Заглушка npm init («no test specified») — не проверка.
  return typeof body === 'string' && body.trim() !== '' && !/no test specified/.test(body);
}

function entry(
  id: string,
  role: DetectedCheck['role'],
  argv: string[],
  cwd: string,
  unit: CheckEntry['unit'],
  pm: JsPm,
  filter: CheckEntry['filter'] | undefined,
): CheckEntry {
  return {
    id,
    class: CLASS_OF[role],
    argv,
    cwd,
    unit,
    requiredAt: [],
    baseDependent: false,
    ...(filter && role === 'test' ? { filter } : {}),
    inputs: [joinRel(cwd, '.env*')],
    envAllow: ['NODE_ENV', 'CI'],
    tools: ['node', pm],
    artifacts: [],
    needs: [],
    source: 'detected',
  };
}

interface JsRoot {
  root: string;
  manifest: Manifest;
  pm: JsPm;
  members: { dir: string; manifest: Manifest }[];
  workspace?: WorkspaceKind;
}

function workspaceOf(view: ViewIndex, root: JsRoot): WorkspaceKind | undefined {
  if (root.members.length === 0) return undefined;
  if (view.has(joinRel(root.root, 'turbo.json'))) return 'turbo';
  if (view.has(joinRel(root.root, 'nx.json'))) return 'nx';
  return root.pm;
}

/** Корни JS: корень репозитория и вложенные самостоятельные проекты (свой лок, вне воркспейса). */
function jsRoots(view: ViewIndex): JsRoot[] {
  const roots: JsRoot[] = [];
  const claimed = new Set<string>();
  const manifests = view.named('package.json').map((f) => dirName(f.path));
  const candidates = manifests.filter(
    (dir) => dir === '' || LOCKS.some(([lock]) => view.has(joinRel(dir, lock))),
  );
  for (const dir of candidates) {
    if (claimed.has(dir) || [...claimed].some((c) => c !== '' && dir.startsWith(`${c}/`))) continue;
    const manifest = readManifest(view, joinRel(dir, 'package.json'));
    if (!manifest) continue;
    const pm = pmOf(view, dir, manifest);
    const pnpmText = view.text(joinRel(dir, 'pnpm-workspace.yaml'));
    const globs = pnpmText !== undefined ? pnpmWorkspaceGlobs(pnpmText) : manifest.workspaces;
    const include = globs.filter((g) => !g.startsWith('!'));
    const exclude = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    const members: JsRoot['members'] = [];
    for (const m of manifests) {
      if (m === dir) continue;
      const rel = dir === '' ? m : m.startsWith(`${dir}/`) ? m.slice(dir.length + 1) : undefined;
      if (rel === undefined) continue;
      if (!include.some((g) => workspaceGlobMatches(g, rel))) continue;
      if (exclude.some((g) => workspaceGlobMatches(g, rel))) continue;
      const mm = readManifest(view, joinRel(m, 'package.json'));
      if (mm) members.push({ dir: m, manifest: mm });
      claimed.add(m);
    }
    claimed.add(dir);
    const row: JsRoot = { root: dir, manifest, pm, members };
    const ws = workspaceOf(view, row);
    if (ws) row.workspace = ws;
    roots.push(row);
  }
  return roots;
}

function suffix(root: string): string {
  return root === '' ? '' : `@${root}`;
}

function rootChecks(r: JsRoot): DetectedCheck[] {
  const out: DetectedCheck[] = [];
  for (const [script, role] of SCRIPT_ROLES) {
    const body = r.manifest.scripts[script];
    if (!isRealScript(body)) continue;
    const filter = filterFor(runnerOf(body, r.manifest.deps), (bin) => pmExec(r.pm, bin));
    out.push({
      entry: entry(
        `js:${script}${suffix(r.root)}`,
        role,
        runScript(r.pm, script),
        r.root,
        'project',
        r.pm,
        filter,
      ),
      role,
      match: { kind: 'script', script, scope: 'root', root: r.root },
    });
  }
  return out;
}

function memberChecks(r: JsRoot): DetectedCheck[] {
  if (!r.workspace) return [];
  const out: DetectedCheck[] = [];
  for (const [script, role] of SCRIPT_ROLES) {
    const having = r.members.filter((m) => isRealScript(m.manifest.scripts[script]));
    if (having.length === 0) continue;
    const runner = having
      .map((m) => runnerOf(m.manifest.scripts[script] as string, m.manifest.deps))
      .find((x) => x !== undefined);
    out.push({
      entry: entry(
        `pkg:${script}${suffix(r.root)}`,
        role,
        runInUnits(r.workspace, r.pm, script),
        r.root,
        'package',
        r.pm,
        filterFor(runner, (bin) => memberExec(r.pm, bin), true),
      ),
      role,
      match: { kind: 'script', script, scope: 'packages', root: r.root },
    });
  }
  return out;
}

export interface JsFinding extends StackFinding {
  packageManager: { name: string; version: string } | null;
}

export function detectJs(view: ViewIndex): JsFinding {
  const finding: JsFinding = {
    stacks: [],
    checks: [],
    units: {},
    machinery: [],
    pathEntries: [],
    notes: [],
    packageManager: null,
  };
  for (const r of jsRoots(view)) {
    const row: StackRow = {
      stack: 'js-ts',
      root: r.root,
      ...(r.workspace ? { workspace: r.workspace } : {}),
    };
    finding.stacks.push(row);
    finding.checks.push(...rootChecks(r), ...memberChecks(r));
    finding.pathEntries.push(joinRel(r.root, 'node_modules/.bin'));
    if (r.root === '')
      finding.packageManager = r.manifest.packageManager ?? { name: r.pm, version: '' };
    // Член без имени выбирается путём (`./packages/c`): голое `packages/c` селекторы pnpm, turbo
    // и bun читают как имя пакета и не находят ничего.
    // Путь — от корня воркспейса: оттуда идёт команда пакетов.
    const unitOf = (m: JsRoot['members'][number]): string =>
      m.manifest.name ?? `./${r.root === '' ? m.dir : m.dir.slice(r.root.length + 1)}`;
    const names = new Map(r.members.map((m) => [unitOf(m), m.dir]));
    for (const m of r.members) {
      const name = unitOf(m);
      finding.units[name] = {
        paths: [m.dir],
        consumes: m.manifest.deps.filter((d) => d !== name && names.has(d)).sort(),
      };
    }
    for (const f of view.inDir(r.root)) {
      const name = baseName(f.path);
      if (
        name === 'package.json' ||
        name === 'pnpm-workspace.yaml' ||
        name === 'turbo.json' ||
        name === 'nx.json' ||
        LOCKS.some(([lock]) => lock === name) ||
        isConfigFile(name)
      )
        finding.machinery.push(f.path);
    }
    if (r.workspace === 'yarn')
      finding.notes.push({
        subject: joinRel(r.root, 'package.json'),
        why: 'yarn workspaces run through `yarn workspaces foreach` (yarn 2+); yarn 1 needs a user edit',
      });
  }
  return finding;
}
