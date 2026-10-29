import { BUILD_WRAPPER_FILES } from '../../platform/build-wrappers.ts';
import type { RepoInputKind, RepoViewSpec } from '../../platform/repo-view.types.ts';

/**
 * Входы обнаружения (04:45-49, 04:89-91, 04:102): ровно те файлы, по которым профиль решает о
 * стеках, проверках, CI, хуках и рантаймах. Их отпечаток — `inputsFp`: правка любого из них —
 * повторное обнаружение, применяемое со следующего шага. Лок-файлы — только хэш: важен факт и
 * отпечаток, разбирать их профилю незачем.
 */

const TEXT_NAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'nx.json',
  '.nvmrc',
  '.node-version',
  '.tool-versions',
  'go.mod',
  'go.work',
  'pyproject.toml',
  'setup.cfg',
  'Pipfile',
  'pytest.ini',
  'tox.ini',
  '.python-version',
  'runtime.txt',
  'ruff.toml',
  '.ruff.toml',
  'mypy.ini',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pom.xml',
  'global.json',
  'Cargo.toml',
  'rust-toolchain',
  'rust-toolchain.toml',
  'Makefile',
  'makefile',
  '.gitlab-ci.yml',
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.pre-commit-config.yaml',
  '.golangci.yml',
  '.golangci.yaml',
]);

const HASH_NAMES = new Set([
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  'setup.py',
  'conftest.py',
  'manage.py',
  ...BUILD_WRAPPER_FILES,
]);

/** Конфиги инструментов: их правка меняет вердикт любой единицы — это обвязка (D§3.3 machinery). */
const CONFIG_PREFIXES = [
  'tsconfig',
  'eslint.config.',
  '.eslintrc',
  'vitest.config.',
  'vitest.workspace',
  'jest.config.',
  'playwright.config.',
  '.prettierrc',
  'prettier.config.',
  'biome.json',
];

/** Скрытые каталоги, где живут входы: CI, хуки, файл проверок проекта. Остальные скрытые — мимо. */
const HIDDEN_DIRS = new Set(['.github', '.agentdeck', '.husky', '.githooks', '.git', '.circleci']);

const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'venv',
  'env',
  '__pycache__',
  'site-packages',
  'coverage',
  'bin',
  'obj',
]);

function isComposeFile(name: string): boolean {
  return /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name);
}

export function isEnvSample(name: string): boolean {
  return /^\.env(\.[\w-]+)*\.(example|sample|template|dist)$/.test(name);
}

export function isConfigFile(name: string): boolean {
  return CONFIG_PREFIXES.some((p) => name.startsWith(p));
}

export function inputKind(path: string, name: string): RepoInputKind | null {
  if (path.startsWith('.git/')) {
    // Внутри `.git` вход — только хуки (имя важнее содержимого, `.sample` — не хук).
    return path.startsWith('.git/hooks/') && !name.endsWith('.sample') ? 'hash' : null;
  }
  if (path.startsWith('.husky/') || path.startsWith('.githooks/')) return 'hash';
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return 'text';
  if (path === '.circleci/config.yml') return 'text';
  if (path === '.agentdeck/checks.json') return 'text';
  if (TEXT_NAMES.has(name) || isComposeFile(name) || isEnvSample(name)) return 'text';
  if (/\.(csproj|fsproj|sln)$/.test(name)) return 'text';
  if (HASH_NAMES.has(name) || /^requirements([-_.][\w-]+)?\.txt$/.test(name)) return 'hash';
  if (isConfigFile(name)) return 'hash';
  return null;
}

export function enterDir(path: string, name: string): boolean {
  if (path === '.git') return true;
  if (path === '.git/hooks') return true;
  if (path.startsWith('.git/')) return false;
  if (name.startsWith('.')) return HIDDEN_DIRS.has(name) && !path.includes('/');
  if (path === '.husky/_') return false;
  return !SKIP_DIRS.has(name);
}

export const PROFILE_VIEW_SPEC: RepoViewSpec = {
  inputKind,
  enterDir,
  // Монорепозиторий: `apps/core/package.json` — глубина 2, `.github/workflows/x.yml` — 2,
  // `services/api/cmd/go.mod` — 3. Глубже входы обнаружения не живут, а обход дорожает.
  maxDepth: 4,
  maxEntries: 50_000,
  maxTextBytes: 1024 * 1024,
};
