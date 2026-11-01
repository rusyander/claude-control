import type { Profile, RepoPath } from '@agentdeck/contracts/core/records';
import { currentOs, type OsKind } from '../../platform/os-kind.ts';
import { venvPython } from '../../platform/build-wrappers.ts';
import type { InstallPlan, InstallStep } from './copy.types.ts';

/**
 * Команда установки зависимостей копии (04:98) — из профиля проекта (стеки, менеджер пакетов) и
 * lock-файлов в корнях стеков; перенесено из панели (`project-git/bootstrap.ts` INSTALL,
 * `language-chains.ts`). Установка ЗАМОРОЖЕНА: копия ставит ровно то, что записано в lock-файле, а
 * не «свежее» — иначе ветка агента уносила бы чужое обновление зависимостей. Нет lock-файла —
 * замороженной установки нет, шаг не придумывается, а стек называется на единице.
 *
 * `--prefer-offline` у npm/pnpm — замер панели 24.09 на 36 тыс. файлов: 16 с без флага, 9–10 с.
 */

const JS_LOCKS: readonly { file: string; manager: string; args: string[] }[] = [
  {
    file: 'pnpm-lock.yaml',
    manager: 'pnpm',
    args: ['install', '--frozen-lockfile', '--prefer-offline'],
  },
  {
    file: 'package-lock.json',
    manager: 'npm',
    args: ['ci', '--prefer-offline', '--no-audit', '--no-fund'],
  },
  {
    file: 'npm-shrinkwrap.json',
    manager: 'npm',
    args: ['ci', '--prefer-offline', '--no-audit', '--no-fund'],
  },
  { file: 'yarn.lock', manager: 'yarn', args: ['install', '--immutable'] },
  { file: 'bun.lock', manager: 'bun', args: ['install', '--frozen-lockfile'] },
  { file: 'bun.lockb', manager: 'bun', args: ['install', '--frozen-lockfile'] },
];

/** Своя команда человека: настроенная сильнее найденной, пустая — «определи сама». */
export interface ConfiguredInstall {
  command: string;
  args: string[];
}

function at(root: RepoPath, file: string): RepoPath {
  return root === '' ? file : `${root}/${file}`;
}

/** Текст файла копии; `undefined` — нет или не прочитался (членство тогда не доказано). */
export type ReadCopyText = (rel: RepoPath) => string | undefined;

/** Строго выше: корень шага — предок вложенного корня, не он сам. */
function above(parent: RepoPath, child: RepoPath): boolean {
  return parent !== child && (parent === '' || child.startsWith(`${parent}/`));
}

function relFrom(parent: RepoPath, child: RepoPath): RepoPath {
  return parent === '' ? child : child.slice(parent.length + 1);
}

function hasJsLock(root: RepoPath, exists: (rel: RepoPath) => boolean): boolean {
  return JS_LOCKS.some((lock) => exists(at(root, lock.file)));
}

/** Глоб членов uv (крейт `glob`): `*` и `?` — внутри сегмента, `**` — через сегменты. */
function uvGlob(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  let body = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i] as string;
    if (ch === '*' && clean[i + 1] === '*') {
      body += '.*';
      i++;
    } else if (ch === '*') body += '[^/]*';
    else if (ch === '?') body += '[^/]';
    else body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${body}$`);
}

function tomlStrings(array: string | undefined): string[] {
  if (array === undefined) return [];
  const noComments = array.replace(/^\s*#.*$/gm, '');
  return [...noComments.matchAll(/"([^"\\]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
}

/**
 * Члены uv-воркспейса из `pyproject.toml` корня: таблица `[tool.uv.workspace]`, массивы `members` и
 * `exclude` (без TOML-библиотеки: формат там один). Таблицы нет — воркспейса нет.
 */
export function uvWorkspaceOf(
  pyproject: string,
): { members: string[]; exclude: string[] } | undefined {
  const header = /^\s*\[tool\.uv\.workspace\]\s*(?:#.*)?$/m.exec(pyproject);
  if (!header) return undefined;
  const rest = pyproject.slice(header.index + header[0].length);
  const next = /^\s*\[/m.exec(rest);
  const table = next ? rest.slice(0, next.index) : rest;
  const array = (key: string): string | undefined =>
    new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(table)?.[1];
  return { members: tomlStrings(array('members')), exclude: tomlStrings(array('exclude')) };
}

function uvMember(
  workspaceRoot: RepoPath,
  nested: RepoPath,
  read: ReadCopyText | undefined,
): boolean {
  const text = read?.(at(workspaceRoot, 'pyproject.toml'));
  const ws = text === undefined ? undefined : uvWorkspaceOf(text);
  if (!ws) return false;
  const rel = relFrom(workspaceRoot, nested);
  if (!ws.members.some((g) => uvGlob(g).test(rel))) return false;
  return !ws.exclude.some((g) => uvGlob(g).test(rel));
}

/**
 * Покрыт ли вложенный корень шагом корня выше (F-175) — только членством в воркспейсе инструмента
 * этого стека, иначе у корня свой шаг или заметка:
 * - js-ts: корень выше объявил воркспейс, а у вложенного нет своего lock-файла — члены воркспейса
 *   pnpm/npm/yarn/bun делят один lock корня. Свой lock = самостоятельный проект (так его выделяет
 *   профиль, `verifier/profile/js.ts` jsRoots), корень его не ставит.
 * - python: у вложенного нет своего `uv.lock`, а `[tool.uv.workspace]` корня выше включает его
 *   (`members` минус `exclude`); шаг корня тогда идёт с `--all-packages` — простой `uv sync`
 *   ставит только пакет корня и его зависимости.
 * - go: никогда — `go mod download` качает зависимости главного модуля каталога; вложенный
 *   `go.mod` — другой модуль, а `go.work` в копии не гарантирован (обычно вне git).
 * - rust: никогда — члены cargo-воркспейса профиль в стеки не выносит (`langs.ts` detectRust),
 *   вложенная строка — отдельный проект.
 * Тот же корень того же стека — дубль, покрыт.
 */
function coveringStep(
  s: Profile['stacks'][number],
  steps: InstallStep[],
  jsWorkspaces: ReadonlySet<RepoPath>,
  exists: (rel: RepoPath) => boolean,
  read: ReadCopyText | undefined,
): InstallStep | undefined {
  const same = steps.filter((step) => step.stack === s.stack);
  const dup = same.find((step) => step.root === s.root);
  if (dup) return dup;
  const parents = same.filter((step) => above(step.root, s.root));
  if (s.stack === 'js-ts') {
    if (hasJsLock(s.root, exists)) return undefined;
    return parents.find((step) => jsWorkspaces.has(step.root));
  }
  if (s.stack === 'python') {
    if (exists(at(s.root, 'uv.lock'))) return undefined;
    return parents.find((step) => uvMember(step.root, s.root, read));
  }
  return undefined;
}

function jsStep(
  root: RepoPath,
  exists: (rel: RepoPath) => boolean,
  pm: Profile['packageManager'],
): InstallStep | undefined {
  const found = JS_LOCKS.filter((lock) => exists(at(root, lock.file)));
  if (found.length === 0) return undefined;
  // Два lock-файла в одном корне: решает менеджер, объявленный проектом (`packageManager`).
  const pick = found.find((lock) => lock.manager === pm?.name) ?? (found[0] as (typeof found)[0]);
  return {
    stack: 'js-ts',
    root,
    command: pick.manager,
    args: [...pick.args],
    why: `${at(root, pick.file)}${pm?.name === pick.manager ? ` + packageManager ${pm.name}@${pm.version}` : ''}`,
  };
}

/**
 * Файлы зависимостей Python без `uv.lock` (список панели `language-chains.ts`): цепочка venv +
 * pip ставит их в `.venv` корня стека — без неё `pytest` копии находил бы чужой глобальный.
 */
export const REQUIREMENT_FILES: readonly string[] = [
  'requirements.txt',
  'requirements-dev.txt',
  'requirements_dev.txt',
  'dev-requirements.txt',
  'requirements-test.txt',
  'requirements_test.txt',
  'test-requirements.txt',
  'requirements/base.txt',
  'requirements/dev.txt',
  'requirements/test.txt',
];

export { venvPython };

function pythonChain(
  root: RepoPath,
  exists: (rel: RepoPath) => boolean,
  os: OsKind,
): InstallStep[] {
  const files = REQUIREMENT_FILES.filter((name) => exists(at(root, name)));
  if (files.length === 0) return [];
  const why = files.map((name) => at(root, name)).join(', ');
  return [
    { stack: 'python', root, command: 'python', args: ['-m', 'venv', '.venv'], why },
    {
      stack: 'python',
      root,
      command: venvPython(os),
      args: [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        ...files.flatMap((name) => ['-r', name]),
      ],
      why,
    },
  ];
}

/**
 * Сборки JVM/.NET. `dotnet restore --locked-mode` — только с `packages.lock.json`: без него
 * восстановление берёт «свежее», а копия ставит ровно записанное. Gradle/Maven отдельного шага не
 * имеют — зависимости тянет первая сборка; это сказано заметкой, не молчит.
 */
function buildToolStep(
  s: Profile['stacks'][number],
  exists: (rel: RepoPath) => boolean,
): InstallStep | { note: string } {
  if (s.stack === 'dotnet') {
    if (exists(at(s.root, 'packages.lock.json')))
      return {
        stack: 'dotnet',
        root: s.root,
        command: 'dotnet',
        args: ['restore', '--locked-mode'],
        why: at(s.root, 'packages.lock.json'),
      };
    return {
      note: 'no packages.lock.json: a locked restore is impossible, dependencies resolve inside the first build',
    };
  }
  const tool = exists(at(s.root, 'pom.xml')) ? 'maven' : 'gradle';
  return {
    note: `${tool}: dependencies resolve inside the first build (no separate install step)`,
  };
}

export function planInstall(
  profile: Pick<Profile, 'stacks' | 'packageManager'>,
  exists: (rel: RepoPath) => boolean,
  configured?: ConfiguredInstall,
  read?: ReadCopyText,
  os: OsKind = currentOs(),
): InstallPlan {
  if (configured && configured.command.trim() !== '') {
    return {
      steps: [
        {
          stack: 'generic',
          root: '',
          command: configured.command,
          args: [...configured.args],
          why: 'configured install command',
        },
      ],
      notes: [],
    };
  }
  const steps: InstallStep[] = [];
  const notes: InstallPlan['notes'] = [];
  // Корни по длине: корень воркспейса планируется раньше своих членов (покрытие — `coveringStep`).
  const stacks = [...profile.stacks].sort((a, b) => {
    if (a.root.length !== b.root.length) return a.root.length - b.root.length;
    if (a.root === b.root) return 0;
    return a.root < b.root ? -1 : 1;
  });
  const jsWorkspaces = new Set<RepoPath>();
  for (const s of stacks) {
    const subject = `${s.stack} at ${s.root || '.'}`;
    const cover = coveringStep(s, steps, jsWorkspaces, exists, read);
    if (cover) {
      if (
        cover.stack === 'python' &&
        cover.root !== s.root &&
        !cover.args.includes('--all-packages')
      )
        cover.args.push('--all-packages');
      continue;
    }
    if (s.stack === 'js-ts') {
      const step = jsStep(s.root, exists, profile.packageManager);
      if (step) {
        steps.push(step);
        if (s.workspace) jsWorkspaces.add(s.root);
      } else
        notes.push({
          subject,
          why: 'no lock file: a frozen install is impossible, deps not installed',
        });
    } else if (s.stack === 'go') {
      if (exists(at(s.root, 'go.mod'))) {
        steps.push({
          stack: 'go',
          root: s.root,
          command: 'go',
          args: ['mod', 'download'],
          why: at(s.root, 'go.mod'),
        });
      } else notes.push({ subject, why: 'no go.mod' });
    } else if (s.stack === 'python') {
      if (exists(at(s.root, 'uv.lock'))) {
        steps.push({
          stack: 'python',
          root: s.root,
          command: 'uv',
          args: ['sync', '--frozen'],
          why: at(s.root, 'uv.lock'),
        });
      } else {
        const chain = pythonChain(s.root, exists, os);
        if (chain.length > 0) steps.push(...chain);
        else
          notes.push({
            subject,
            why: 'no uv.lock and no requirements*.txt: the virtualenv is not created by copy setup',
          });
      }
    } else if (s.stack === 'rust') {
      if (exists(at(s.root, 'Cargo.lock'))) {
        steps.push({
          stack: 'rust',
          root: s.root,
          command: 'cargo',
          args: ['fetch', '--locked'],
          why: at(s.root, 'Cargo.lock'),
        });
      } else notes.push({ subject, why: 'no Cargo.lock' });
    } else if (s.stack === 'jvm' || s.stack === 'dotnet') {
      const step = buildToolStep(s, exists);
      if ('note' in step) notes.push({ subject, why: step.note });
      else steps.push(step);
    } else {
      // generic (и любой стек без своей ветки): команды установки нет — это сказано, не молчит.
      notes.push({
        subject,
        why: 'no known stack: no install command is detected, deps not installed; set the project install command',
      });
    }
  }
  return { steps, notes };
}
