import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * `tools/affected.mjs` и `gate-run.mjs --affected` набора: локальный прогон перед пушем остаётся
 * внутри затронутых зон, пока это доказуемо, иначе FULL с причиной. Доказательство — настоящий git
 * над крошечным воркспейсом (два пакета, один зависит от другого, CI с тестами) и настоящий запуск
 * копии из набора, не домашней: набор едет к людям без ~/.claude.
 */

const TOOLS = join(builtinKitDir(), 'tools');
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kit-affected-')));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
};
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const pkg = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify({ name, scripts: { test: 'vitest run' }, dependencies: deps });
const affected = () => {
  const r = spawnSync(process.execPath, [join(TOOLS, 'affected.mjs'), '--json', '--base', 'main'], {
    cwd: repo,
    encoding: 'utf8',
  });
  return JSON.parse(r.stdout) as { verdict: string; affected: string[]; reasons: string[] };
};

git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
put('package.json', JSON.stringify({ name: 'w', private: true, scripts: { lint: 'eslint .' } }));
put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
put('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: pnpm test\n');
put('packages/shared/package.json', pkg('@w/shared'));
put('packages/shared/a.ts', 'export {};\n');
put('packages/food/package.json', pkg('@w/food', { '@w/shared': 'workspace:*' }));
put('packages/food/a.ts', 'export {};\n');
put('packages/tables/package.json', pkg('@w/tables'));
put('packages/tables/a.ts', 'export {};\n');
put('apps/host/package.json', pkg('@w/host', { '@w/food': 'workspace:*' }));
put('apps/host/a.ts', 'export {};\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
git('checkout', '-q', '-b', 'work');

describe('affected из набора', () => {
  it('правка пакета — только он и зависящие от него, корневой lint наследуется', () => {
    put('packages/food/a.ts', 'export const x = 1;\n');
    const a = affected();
    expect(a.verdict).toBe('scoped');
    expect(a.affected).toEqual(['apps/host', 'packages/food']);
    const plan = spawnSync(
      process.execPath,
      [
        join(TOOLS, 'gate-run.mjs'),
        '--dry',
        '--affected',
        '--base',
        'main',
        '--no-ledger',
        'full=pnpm -r test',
        'always:brand=node -e 0',
      ],
      { cwd: repo, encoding: 'utf8' },
    ).stdout;
    expect(plan).toContain('plan: brand → node -e 0');
    expect(plan).toContain('plan: food:test → pnpm run test');
    expect(plan).toContain('plan: root:lint → pnpm run lint');
    expect(plan).not.toContain('pnpm -r test');
    put('packages/food/a.ts', 'export {};\n');
  });

  it('правка корневого lock-файла — FULL с причиной', () => {
    put('pnpm-lock.yaml', 'lockfileVersion: 9\n# moved\n');
    const a = affected();
    expect(a.verdict).toBe('full');
    expect(a.reasons.join()).toContain('root-owned file: pnpm-lock.yaml');
    put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  });
});
