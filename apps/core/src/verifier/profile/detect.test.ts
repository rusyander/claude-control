import { describe, expect, it } from 'vitest';
import { detectProfile, inputsFingerprint } from './detect.ts';
import { JS_WITH_CI, REPOS, viewOf, type RepoFiles } from './__fixtures__/repos.ts';

/**
 * Обнаружение профиля по образцам (04:45-49, 04:121-123): семь стеков + generic, шесть видов
 * рабочих пространств JS, набор публикации из CI, обёртки сборки по ОС. Вид строится тем же
 * правилом входов, что и обход настоящего репозитория.
 */

const detect = (files: RepoFiles, os: 'win32' | 'linux' | 'darwin' = 'linux') =>
  detectProfile(viewOf(files), { os });

const ids = (files: RepoFiles, os?: 'win32' | 'linux' | 'darwin') =>
  detect(files, os).registry.checks.map((c) => c.id);

const argvOf = (files: RepoFiles, id: string, os?: 'win32' | 'linux' | 'darwin') =>
  detect(files, os).registry.checks.find((c) => c.id === id)?.argv;

describe('profile detection: stacks', () => {
  it('each known stack is named with its own checks; nothing known → generic from CI and Makefile', () => {
    const stackOf = (k: string) => detect(REPOS[k] as RepoFiles).stacks.map((s) => s.stack);
    expect(stackOf('pnpm')).toEqual(['js-ts']);
    expect(stackOf('go')).toEqual(['go']);
    expect(stackOf('python')).toEqual(['python']);
    expect(stackOf('gradle')).toEqual(['jvm']);
    expect(stackOf('maven')).toEqual(['jvm']);
    expect(stackOf('dotnet')).toEqual(['dotnet']);
    expect(stackOf('rust')).toEqual(['rust']);
    expect(stackOf('generic')).toEqual(['generic']);

    expect(ids(REPOS.go as RepoFiles)).toEqual(['go:vet', 'go:test', 'go:golangci']);
    expect(ids(REPOS.python as RepoFiles)).toEqual(['py:ruff', 'py:mypy', 'py:pytest']);
    expect(argvOf(REPOS.python as RepoFiles, 'py:pytest')).toEqual(['uv', 'run', 'pytest']);
    expect(ids(REPOS.dotnet as RepoFiles)).toEqual(['dotnet:build', 'dotnet:test']);
    expect(ids(REPOS.rust as RepoFiles)).toEqual(['rust:fmt', 'rust:clippy', 'rust:test']);
    expect(ids(REPOS.maven as RepoFiles)).toEqual(['jvm:verify']);

    // узкий прогон vitest — с репортёром, называющим прошедшие тесты (P50)
    const vitestFilter = detect(REPOS.pnpm as RepoFiles).registry.checks.find(
      (c) => c.filter?.kind === 'vitest',
    )?.filter?.argv;
    expect(vitestFilter?.slice(-4)).toEqual(['{files}', '--reporter=verbose', '-t', '{tests}']);

    const generic = detect(REPOS.generic as RepoFiles);
    expect(generic.stacks[0]?.named).toMatch(/no known stack/);
    expect(generic.registry.checks.map((c) => c.argv.join(' '))).toEqual([
      'make lint',
      'make test',
      './scripts/check.sh --all',
    ]);
  });

  it('runtimes come from the version files the project declares, never guessed', () => {
    expect(detect(REPOS.go as RepoFiles).runtimes).toEqual({
      go: { version: '>=1.23', from: 'go.mod' },
    });
    expect(detect(REPOS.python as RepoFiles).runtimes.python).toEqual({
      version: '3.12',
      from: '.python-version',
    });
    expect(detect(REPOS.rust as RepoFiles).runtimes.cargo?.from).toBe('rust-toolchain.toml');
    expect(detect(REPOS.gradle as RepoFiles).runtimes).toEqual({});
  });

  it('runtime keys are the tool names the checks carry: cargo for rust, the declared package manager', () => {
    for (const k of ['go', 'python', 'rust', 'yarn', 'dotnet']) {
      const p = detect(REPOS[k] as RepoFiles);
      const tools = new Set(p.registry.checks.flatMap((c) => c.tools));
      for (const key of Object.keys(p.runtimes)) expect(tools.has(key), `${k}: ${key}`).toBe(true);
    }
    expect(detect(REPOS.rust as RepoFiles).runtimes.cargo?.version).toBe('1.82');
    expect(detect(REPOS.yarn as RepoFiles).runtimes.yarn).toEqual({
      version: '4.5.0',
      from: 'package.json',
    });
  });

  it('the build wrapper follows the OS: ./gradlew on POSIX, ./gradlew.bat on Windows — a path in the check dir, never a PATH lookup', () => {
    expect(argvOf(REPOS.gradle as RepoFiles, 'jvm:check', 'linux')).toEqual(['./gradlew', 'check']);
    expect(argvOf(REPOS.gradle as RepoFiles, 'jvm:check', 'win32')).toEqual([
      './gradlew.bat',
      'check',
    ]);
    const { 'gradlew.bat': _bat, ...noBat } = REPOS.gradle as RepoFiles;
    expect(argvOf(noBat, 'jvm:check', 'win32')).toEqual(['gradle', 'check']);
    expect(argvOf(REPOS.maven as RepoFiles, 'jvm:verify', 'darwin')).toEqual([
      'mvn',
      '-q',
      'verify',
    ]);
  });

  it('maven narrow run prints the Surefire summary (no -q) and a module without matching tests does not fail itself', () => {
    const narrow = detect(REPOS.maven as RepoFiles, 'darwin').registry.checks.find(
      (c) => c.id === 'jvm:verify',
    )?.filter;
    expect(narrow).toEqual({
      kind: 'maven',
      argv: ['mvn', 'test', '-Dsurefire.failIfNoSpecifiedTests=false', '-Dtest={tests}'],
    });
  });
});

describe('profile detection: language commands that really run the project', () => {
  it('dotnet names its solution, and without one tests each test project', () => {
    const two = {
      ...(REPOS.dotnet as RepoFiles),
      'Tools.sln': 'Microsoft Visual Studio Solution File\n',
    };
    expect(argvOf(two, 'dotnet:test')).toEqual(['dotnet', 'test', 'Svc.sln']);
    expect(argvOf(two, 'dotnet:build')).toEqual(['dotnet', 'build', 'Svc.sln']);
    expect(detect(two).notes.map((n) => n.subject)).toContain('Tools.sln');
    const { 'Svc.sln': _sln, ...noSln } = REPOS.dotnet as RepoFiles;
    const tests = detect(noSln).registry.checks.filter((c) => c.id.startsWith('dotnet:test'));
    expect(tests.map((c) => [c.id, c.cwd])).toEqual([
      ['dotnet:test@tests/Svc.Tests', 'tests/Svc.Tests'],
    ]);
  });

  it('poetry and pipenv projects run their tools inside their own environment', () => {
    const poetry = {
      'pyproject.toml': '[tool.poetry]\nname = "svc"\n\n[tool.pytest.ini_options]\n\n[tool.ruff]\n',
      'poetry.lock': '',
    };
    expect(argvOf(poetry, 'py:pytest')).toEqual(['poetry', 'run', 'pytest']);
    expect(argvOf(poetry, 'py:ruff')).toEqual(['poetry', 'run', 'ruff', 'check', '.']);
    expect(argvOf({ Pipfile: '[packages]\n', 'pytest.ini': '' }, 'py:pytest')).toEqual([
      'pipenv',
      'run',
      'pytest',
    ]);
  });

  it('a Makefile variable `test := …` is not a target', () => {
    expect(ids({ Makefile: 'test := unit\nlint:\n\techo\n' })).toEqual(['make:lint']);
  });

  it('a compose image that is not a plain reference (flag-like, interpolated) is not a recipe', () => {
    const p = detect({
      'compose.yml':
        'services:\n  db:\n    image: postgres:16\n  evil:\n    image: "-v/:/host"\n  var:\n    image: ${IMG}\n',
    });
    expect(p.serviceRecipes.map((r) => r.name)).toEqual(['db']);
    expect(p.notes.map((n) => n.subject)).toEqual(
      expect.arrayContaining(['compose.yml#evil', 'compose.yml#var']),
    );
  });
});

describe('profile detection: JS workspaces', () => {
  const kinds = ['pnpm', 'yarn', 'npm', 'bun', 'turbo', 'nx'] as const;

  it('every workspace kind is named, and its units carry paths and consumes', () => {
    for (const k of kinds) {
      const p = detect(REPOS[k] as RepoFiles);
      expect(p.stacks, k).toEqual([{ stack: 'js-ts', root: '', workspace: k }]);
      expect(p.registry.units, k).toEqual({
        a: { paths: ['packages/a'], consumes: ['b'] },
        b: { paths: ['packages/b'], consumes: [] },
      });
    }
  });

  it('an unnamed member is selected by path, and pnpm fails when a selector matches nothing', () => {
    // Живая проба pnpm 10: `--filter=packages/c` без имени пакета — «No projects matched», выход 0.
    const files = {
      ...(REPOS.pnpm as RepoFiles),
      'packages/c/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    };
    expect(Object.keys(detect(files).registry.units)).toContain('./packages/c');
    expect(argvOf(files, 'pkg:test')).toContain('--fail-if-no-match');
  });

  it('a per-package check runs through the tool of its workspace kind', () => {
    const pkgTest = (k: string) => argvOf(REPOS[k] as RepoFiles, 'pkg:test')?.join(' ');
    expect(pkgTest('pnpm')).toBe('pnpm --filter={units} --fail-if-no-match run test');
    expect(pkgTest('yarn')).toBe('yarn workspaces foreach --include={units} run test');
    expect(pkgTest('npm')).toBe('npm run test --workspace={units}');
    expect(pkgTest('bun')).toBe('bun run --filter={units} test');
    expect(pkgTest('turbo')).toBe('pnpm exec turbo run test --filter={units}');
    expect(pkgTest('nx')).toBe('npx --no-install nx run-many --target=test --projects={units}');
    expect(detect(REPOS.yarn as RepoFiles).packageManager).toEqual({
      name: 'yarn',
      version: '4.5.0',
    });
  });

  it('A2r3-Q03 a member narrow run starts the runner inside the member through the package selector, never from the root', () => {
    const narrow = (k: string, id: string) =>
      detect(REPOS[k] as RepoFiles)
        .registry.checks.find((c) => c.id === id)
        ?.filter?.argv.join(' ');
    const tail = 'vitest run {files} --reporter=verbose -t {tests}';
    expect(narrow('pnpm', 'pkg:test')).toBe(
      `pnpm --filter={units} --fail-if-no-match exec ${tail}`,
    );
    expect(narrow('npm', 'pkg:test')).toBe(`npx --no-install --workspace={units} ${tail}`);
    expect(narrow('yarn', 'pkg:test')).toBe(
      `yarn workspaces foreach --include={units} run ${tail}`,
    );
    // turbo/nx: бинарь члена ведёт менеджер корня.
    expect(narrow('turbo', 'pkg:test')).toBe(
      `pnpm --filter={units} --fail-if-no-match exec ${tail}`,
    );
    expect(narrow('nx', 'pkg:test')).toBe(`npx --no-install --workspace={units} ${tail}`);
    // bun `--filter` гоняет только скрипты: узкого прогона члена нет — вся единица.
    expect(narrow('bun', 'pkg:test')).toBeUndefined();
    // Корень своего vitest зовёт по-прежнему из корня.
    expect(narrow('pnpm', 'js:test')).toBe(`pnpm exec ${tail}`);
  });
});

describe('profile detection: publish set', () => {
  it('with CI, publish requires exactly the checks CI runs; setup steps map to nothing', () => {
    const p = detect(JS_WITH_CI);
    expect(p.ciChecks).toEqual(['js:lint', 'js:test']);
    const required = p.registry.checks.filter((c) => c.requiredAt.includes('publish'));
    expect(required.map((c) => c.id)).toEqual(['js:lint', 'js:test']);
  });

  it('without CI, publish takes test and static checks and the profile says so', () => {
    const p = detect(REPOS.pnpm as RepoFiles);
    expect(p.ciChecks).toEqual([]);
    const required = p.registry.checks.filter((c) => c.requiredAt.includes('publish'));
    expect(required.map((c) => c.id)).toEqual([
      'js:lint',
      'js:typecheck',
      'js:test',
      'pkg:lint',
      'pkg:test',
    ]);
    expect(detect(REPOS.dotnet as RepoFiles).registry.checks[0]?.requiredAt).toEqual([]);
  });

  it('the inputs fingerprint moves with any input and ignores non-inputs', () => {
    const base = inputsFingerprint(viewOf(REPOS.go as RepoFiles));
    expect(inputsFingerprint(viewOf({ ...(REPOS.go as RepoFiles), 'main.go': 'x' }))).toBe(base);
    expect(
      inputsFingerprint(viewOf({ ...(REPOS.go as RepoFiles), 'go.mod': 'module x\n\ngo 1.24\n' })),
    ).not.toBe(base);
  });
});
