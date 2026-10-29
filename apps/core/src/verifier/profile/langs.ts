import type { CheckEntry } from '@agentdeck/contracts/core/records';
import { buildWrapperFor, venvBinDir } from '../../platform/build-wrappers.ts';
import type { DetectContext, DetectedCheck, StackFinding } from './profile.types.ts';
import { matchWords } from './ci.ts';
import { baseName, dirName, joinRel, type ViewIndex } from './view.ts';

/**
 * Go, Python, JVM (Gradle / Maven), .NET, Rust и цели Makefile (04:46-47, 04:122). Штатные
 * команды языков — порт панельного `project-checks.ts` / `language-chains.ts`: только когда
 * проект объявил сам инструмент (манифест, конфиг, обёртка `gradlew` / `mvnw`), без догадок.
 */

const CLASS_OF: Record<DetectedCheck['role'], CheckEntry['class']> = {
  static: 'static',
  test: 'test-runner',
  live: 'live',
  build: 'build',
};

function suffix(root: string): string {
  return root === '' ? '' : `@${root}`;
}

function check(
  id: string,
  role: DetectedCheck['role'],
  argv: string[],
  root: string,
  opts: { filter?: CheckEntry['filter']; tools: string[]; envAllow?: string[]; inputs?: string[] },
): DetectedCheck {
  return {
    entry: {
      id: `${id}${suffix(root)}`,
      class: CLASS_OF[role],
      argv,
      cwd: root,
      unit: 'project',
      requiredAt: [],
      baseDependent: false,
      ...(opts.filter ? { filter: opts.filter } : {}),
      inputs: opts.inputs ?? [joinRel(root, '.env*')],
      envAllow: opts.envAllow ?? ['CI'],
      tools: opts.tools,
      artifacts: [],
      needs: [],
      source: 'detected',
    },
    role,
    match: { kind: 'argv', words: matchWords(argv), root },
  };
}

function emptyFinding(): StackFinding {
  return { stacks: [], checks: [], units: {}, machinery: [], pathEntries: [], notes: [] };
}

/** Корни языка: каталоги, где лежит маркер; вложенный корень того же языка — свой. */
function rootsOf(view: ViewIndex, names: string[]): string[] {
  const set = new Set<string>();
  for (const n of names) for (const f of view.named(n)) set.add(dirName(f.path));
  return [...set].sort();
}

export function detectGo(view: ViewIndex): StackFinding {
  const out = emptyFinding();
  for (const root of rootsOf(view, ['go.mod'])) {
    out.stacks.push({ stack: 'go', root });
    out.checks.push(
      check('go:vet', 'static', ['go', 'vet', './...'], root, { tools: ['go'] }),
      check('go:test', 'test', ['go', 'test', './...'], root, {
        tools: ['go'],
        filter: { kind: 'go', argv: ['go', 'test', '{units}', '-run', '{tests}'] },
      }),
    );
    if (view.has(joinRel(root, '.golangci.yml')) || view.has(joinRel(root, '.golangci.yaml')))
      out.checks.push(
        check('go:golangci', 'static', ['golangci-lint', 'run'], root, {
          tools: ['golangci-lint'],
        }),
      );
    out.machinery.push(
      ...['go.mod', 'go.sum'].map((n) => joinRel(root, n)).filter((p) => view.has(p)),
    );
  }
  if (view.has('go.work'))
    out.notes.push({
      subject: 'go.work',
      why: 'Go workspace modules run as project checks per module root',
    });
  return out;
}

const PYTHON_MARKERS = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'pytest.ini',
  'tox.ini',
  'manage.py',
];

function envManager(
  view: ViewIndex,
  root: string,
  pyproject: string,
): 'uv' | 'poetry' | 'pipenv' | undefined {
  if (view.has(joinRel(root, 'uv.lock'))) return 'uv';
  if (view.has(joinRel(root, 'poetry.lock')) || /^\s*\[tool\.poetry\]/m.test(pyproject))
    return 'poetry';
  if (view.has(joinRel(root, 'Pipfile'))) return 'pipenv';
  return undefined;
}

export function detectPython(view: ViewIndex, ctx: DetectContext): StackFinding {
  const out = emptyFinding();
  const requirementDirs = view
    .matching((p) => /^requirements([-_.][\w-]+)?\.txt$/.test(baseName(p)))
    .map((f) => dirName(f.path));
  for (const root of [...new Set([...rootsOf(view, PYTHON_MARKERS), ...requirementDirs])].sort()) {
    const pyproject = view.text(joinRel(root, 'pyproject.toml')) ?? '';
    // Каталог с одним requirements.txt (документация, скрипты) — не Python-проект: нужен маркер.
    if (!PYTHON_MARKERS.some((m) => view.has(joinRel(root, m)))) continue;
    out.stacks.push({ stack: 'python', root });
    // Зависимости poetry и pipenv живут в их собственном окружении (часто вне репозитория):
    // системный python его не видит — инструменты гоняются через `<менеджер> run`.
    const manager = envManager(view, root, pyproject);
    const run = (tool: string, args: string[]): string[] => {
      if (manager) return [manager, 'run', tool, ...args];
      return tool === 'pytest' ? ['python', '-m', 'pytest', ...args] : [tool, ...args];
    };
    const tools = manager ? ['python', manager] : ['python'];
    if (
      /\[tool\.ruff\b/.test(pyproject) ||
      view.has(joinRel(root, 'ruff.toml')) ||
      view.has(joinRel(root, '.ruff.toml'))
    )
      out.checks.push(check('py:ruff', 'static', run('ruff', ['check', '.']), root, { tools }));
    if (/\[tool\.mypy\b/.test(pyproject) || view.has(joinRel(root, 'mypy.ini')))
      out.checks.push(check('py:mypy', 'static', run('mypy', ['.']), root, { tools }));
    const tox = view.text(joinRel(root, 'tox.ini')) ?? '';
    if (
      /\[tool\.pytest\b/.test(pyproject) ||
      view.has(joinRel(root, 'pytest.ini')) ||
      view.has(joinRel(root, 'conftest.py')) ||
      /\[pytest\]/.test(tox) ||
      view.hasDir(joinRel(root, 'tests'))
    )
      out.checks.push(
        check('py:pytest', 'test', run('pytest', []), root, {
          tools,
          filter: { kind: 'pytest', argv: [...run('pytest', []), '{tests}'] },
        }),
      );
    out.pathEntries.push(joinRel(root, venvBinDir(ctx.os)));
    out.machinery.push(
      ...[
        'pyproject.toml',
        'setup.cfg',
        'tox.ini',
        'pytest.ini',
        'uv.lock',
        'poetry.lock',
        'Pipfile',
      ]
        .map((n) => joinRel(root, n))
        .filter((p) => view.has(p)),
    );
  }
  return out;
}

/**
 * Обёртка проекта (`gradlew`/`mvnw`) важнее системной сборки: версия инструмента — проекта. На
 * Windows `./gradlew` — sh-скрипт, его запускает только `gradlew.bat`/`mvnw.cmd`; нет их —
 * системный бинарь.
 */
function wrapperBin(view: ViewIndex, root: string, ctx: DetectContext, tool: 'gradle' | 'mvn') {
  const wrapper = buildWrapperFor(tool, ctx.os);
  return view.has(joinRel(root, wrapper.file)) ? wrapper.command : tool;
}

export function detectJvm(view: ViewIndex, ctx: DetectContext): StackFinding {
  const out = emptyFinding();
  const gradleRoots = rootsOf(view, [
    'settings.gradle',
    'settings.gradle.kts',
    'build.gradle',
    'build.gradle.kts',
  ]);
  // Подпроект Gradle внутри корня с settings — не свой корень: его гоняет корневая сборка.
  const settings = rootsOf(view, ['settings.gradle', 'settings.gradle.kts']);
  const topGradle = gradleRoots.filter(
    (r) => !settings.some((s) => s !== r && (s === '' || r.startsWith(`${s}/`))),
  );
  for (const root of topGradle) {
    out.stacks.push({ stack: 'jvm', root });
    const bin = wrapperBin(view, root, ctx, 'gradle');
    out.checks.push(
      check('jvm:check', 'test', [bin, 'check'], root, {
        tools: ['java', 'gradle'],
        envAllow: ['CI', 'JAVA_HOME'],
        filter: { kind: 'gradle', argv: [bin, 'test', '--tests', '{tests}'] },
      }),
    );
    out.machinery.push(
      ...['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts']
        .map((n) => joinRel(root, n))
        .filter((p) => view.has(p)),
    );
  }
  const mavenRoots = rootsOf(view, ['pom.xml']).filter(
    (r) =>
      !topGradle.includes(r) &&
      !rootsOf(view, ['pom.xml']).some((o) => o !== r && (o === '' || r.startsWith(`${o}/`))),
  );
  for (const root of mavenRoots) {
    out.stacks.push({ stack: 'jvm', root });
    const bin = wrapperBin(view, root, ctx, 'mvn');
    out.checks.push(
      check('jvm:verify', 'test', [bin, '-q', 'verify'], root, {
        tools: ['java', 'maven'],
        envAllow: ['CI', 'JAVA_HOME'],
        // Узкий прогон без `-q`: итог Surefire `Tests run: N` печатается и считается (D§3.7);
        // модуль без совпавших тестов не падает сам — пустую выборку называет итог `Tests run: 0`.
        filter: {
          kind: 'maven',
          argv: [bin, 'test', '-Dsurefire.failIfNoSpecifiedTests=false', '-Dtest={tests}'],
        },
      }),
    );
    out.machinery.push(joinRel(root, 'pom.xml'));
  }
  if (out.stacks.length > 0)
    out.notes.push({
      subject: 'jvm',
      why: 'Gradle/Maven modules are not split into units: whole-project checks',
    });
  return out;
}

const TEST_SDK = /Microsoft\.NET\.Test\.Sdk|xunit|nunit|MSTest/i;

export function detectDotnet(view: ViewIndex): StackFinding {
  const out = emptyFinding();
  const slns = view.matching((p) => p.endsWith('.sln'));
  const projects = view.matching((p) => /\.(csproj|fsproj)$/.test(p));
  if (slns.length === 0 && projects.length === 0) return out;
  const testProjects = projects.filter((p) => TEST_SDK.test(p.text ?? ''));
  const sln = [...slns].sort(
    (a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
  )[0];
  if (sln) {
    // Решение названо явно: два .sln в каталоге — `dotnet build` без имени падает (MSB1011).
    const root = dirName(sln.path);
    const name = baseName(sln.path);
    out.stacks.push({ stack: 'dotnet', root });
    out.checks.push(
      check('dotnet:build', 'build', ['dotnet', 'build', name], root, { tools: ['dotnet'] }),
    );
    if (testProjects.length > 0)
      out.checks.push(
        check('dotnet:test', 'test', ['dotnet', 'test', name], root, {
          tools: ['dotnet'],
          filter: { kind: 'dotnet', argv: ['dotnet', 'test', name, '--filter', '{tests}'] },
        }),
      );
    for (const other of slns.filter((s) => s !== sln))
      out.notes.push({ subject: other.path, why: `second solution: checks run ${sln.path}` });
  } else {
    // Без решения `dotnet test` в каталоге не-тестового проекта не находит тестов и зелёный
    // впустую: каждый тестовый проект — своя проверка в своём каталоге.
    const root = projects
      .map((p) => dirName(p.path))
      .sort((a, b) => a.length - b.length)[0] as string;
    out.stacks.push({ stack: 'dotnet', root });
    out.checks.push(
      check('dotnet:build', 'build', ['dotnet', 'build'], root, { tools: ['dotnet'] }),
    );
    for (const dir of [...new Set(testProjects.map((p) => dirName(p.path)))].sort())
      out.checks.push(
        check('dotnet:test', 'test', ['dotnet', 'test'], dir, {
          tools: ['dotnet'],
          filter: { kind: 'dotnet', argv: ['dotnet', 'test', '--filter', '{tests}'] },
        }),
      );
  }
  out.machinery.push(
    ...slns.map((s) => s.path),
    ...(view.has('global.json') ? ['global.json'] : []),
  );
  return out;
}

export function detectRust(view: ViewIndex): StackFinding {
  const out = emptyFinding();
  const roots = rootsOf(view, ['Cargo.toml']);
  const workspaces = roots.filter((r) =>
    /^\s*\[workspace\]/m.test(view.text(joinRel(r, 'Cargo.toml')) ?? ''),
  );
  for (const root of roots) {
    // Член cargo-воркспейса гоняется корнем воркспейса.
    if (workspaces.some((w) => w !== root && (w === '' || root.startsWith(`${w}/`)))) continue;
    out.stacks.push({ stack: 'rust', root });
    out.checks.push(
      check('rust:fmt', 'static', ['cargo', 'fmt', '--check'], root, { tools: ['cargo'] }),
      check('rust:clippy', 'static', ['cargo', 'clippy', '--all-targets'], root, {
        tools: ['cargo'],
      }),
      check('rust:test', 'test', ['cargo', 'test'], root, {
        tools: ['cargo'],
        filter: { kind: 'cargo', argv: ['cargo', 'test', '{tests}'] },
      }),
    );
    out.machinery.push(
      ...['Cargo.toml', 'Cargo.lock'].map((n) => joinRel(root, n)).filter((p) => view.has(p)),
    );
  }
  return out;
}

const MAKE_TARGETS: [string, DetectedCheck['role']][] = [
  ['lint', 'static'],
  ['typecheck', 'static'],
  ['check', 'static'],
  ['test', 'test'],
];

/** Цели Makefile корня, которые являются проверками. */
export function detectMake(view: ViewIndex): StackFinding {
  const out = emptyFinding();
  const text = view.text('Makefile') ?? view.text('makefile');
  if (text === undefined) return out;
  for (const [target, role] of MAKE_TARGETS)
    // `test := …` / `test ::= …` — присвоение переменной, не цель (`test::` — цель).
    if (new RegExp(`^${target}\\s*:(?!=|:=)`, 'm').test(text))
      out.checks.push(check(`make:${target}`, role, ['make', target], '', { tools: ['make'] }));
  if (out.checks.length > 0) out.machinery.push(view.has('Makefile') ? 'Makefile' : 'makefile');
  return out;
}
