import { createHash } from 'node:crypto';
import type { RepoView } from '../../../platform/repo-view.types.ts';
import { inputKind } from '../inputs.ts';

/**
 * Репозитории-образцы для обнаружения профиля: вид строится так же, как его строит обход
 * (`readRepoView`) — текст только у входов `text`, хэш у всех, каталоги по путям. Так модульный
 * тест идёт через тот же `detectProfile`, что и настоящий репозиторий.
 */

export type RepoFiles = Record<string, string>;

export function viewOf(files: RepoFiles): RepoView {
  const dirs = new Set<string>();
  const out: RepoView['files'] = [];
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const kind = inputKind(path, parts.at(-1) ?? path);
    if (!kind) continue;
    const bytes = Buffer.byteLength(text);
    out.push({
      path,
      sha: createHash('sha256').update(text).digest('hex'),
      bytes,
      text: kind === 'text' ? text : null,
    });
  }
  return { files: out, dirs: [...dirs].sort(), truncated: false, overCap: [] };
}

const pkg = (o: object): string => JSON.stringify(o, null, 2);

const JS_ROOT_SCRIPTS = { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' };

function workspacePackages(): RepoFiles {
  return {
    'packages/a/package.json': pkg({
      name: 'a',
      scripts: { test: 'vitest run', lint: 'eslint .' },
      dependencies: { b: 'workspace:*' },
    }),
    'packages/b/package.json': pkg({ name: 'b', scripts: { test: 'vitest run' } }),
  };
}

export const REPOS: Record<string, RepoFiles> = {
  pnpm: {
    'package.json': pkg({ name: 'mono', private: true, scripts: JS_ROOT_SCRIPTS }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    ...workspacePackages(),
  },
  yarn: {
    'package.json': pkg({
      name: 'mono',
      private: true,
      packageManager: 'yarn@4.5.0',
      workspaces: ['packages/*'],
      scripts: JS_ROOT_SCRIPTS,
    }),
    'yarn.lock': '# yarn lockfile\n',
    ...workspacePackages(),
  },
  npm: {
    'package.json': pkg({
      name: 'mono',
      private: true,
      workspaces: ['packages/*'],
      scripts: JS_ROOT_SCRIPTS,
    }),
    'package-lock.json': '{}',
    ...workspacePackages(),
  },
  bun: {
    'package.json': pkg({
      name: 'mono',
      private: true,
      workspaces: ['packages/*'],
      scripts: JS_ROOT_SCRIPTS,
    }),
    'bun.lock': '{}',
    ...workspacePackages(),
  },
  turbo: {
    'package.json': pkg({ name: 'mono', private: true, scripts: { test: 'turbo run test' } }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'turbo.json': pkg({ tasks: { test: {}, lint: {} } }),
    ...workspacePackages(),
  },
  nx: {
    'package.json': pkg({
      name: 'mono',
      private: true,
      workspaces: ['packages/*'],
      scripts: { test: 'nx run-many -t test' },
    }),
    'package-lock.json': '{}',
    'nx.json': pkg({ targetDefaults: { test: {} } }),
    ...workspacePackages(),
  },
  go: {
    'go.mod': 'module example.com/svc\n\ngo 1.23\n',
    'go.sum': '',
    '.golangci.yml': 'linters: {}\n',
  },
  python: {
    'pyproject.toml':
      '[project]\nname = "svc"\nrequires-python = ">=3.12"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n',
    'uv.lock': '',
    '.python-version': '3.12\n',
  },
  gradle: {
    'build.gradle.kts': 'plugins { java }\n',
    'settings.gradle.kts': 'rootProject.name = "svc"\n',
    gradlew: '#!/bin/sh\n',
    'gradlew.bat': '@echo off\r\n',
  },
  maven: {
    'pom.xml': '<project><artifactId>svc</artifactId></project>\n',
  },
  dotnet: {
    'Svc.sln': 'Microsoft Visual Studio Solution File\n',
    'src/Svc/Svc.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'tests/Svc.Tests/Svc.Tests.csproj':
      '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>\n',
    'global.json': pkg({ sdk: { version: '8.0.100' } }),
  },
  rust: {
    'Cargo.toml': '[package]\nname = "svc"\nversion = "0.1.0"\n',
    'Cargo.lock': '',
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.82"\n',
  },
  generic: {
    Makefile: 'test:\n\t./scripts/test.sh\n\nlint:\n\t./scripts/lint.sh\n',
    '.github/workflows/ci.yml':
      'jobs:\n  ci:\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./scripts/check.sh --all\n',
  },
};

/** pnpm-репозиторий с CI, который гоняет только `pnpm test` и `pnpm lint`. */
export const JS_WITH_CI: RepoFiles = {
  ...REPOS.pnpm,
  '.github/workflows/ci.yml':
    'jobs:\n  ci:\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm test\n      - run: pnpm lint\n',
};
