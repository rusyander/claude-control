import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScope } from './run-permissions.ts';
import { auditScope, scopeBaseline } from './scope-audit.ts';

/**
 * Сверка границ прогона на финише против настоящего git во временном репозитории: что поменялось
 * вне границ режима и сдвинулась ли голова ветки.
 */

let root: string;
const git = (...args: string[]): void => {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
};
const put = (path: string, text: string): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scope-audit-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  git('config', 'core.autocrlf', 'false');
  put('src/app.ts', 'export {};\n');
  put('e2e/login.spec.ts', 'test\n');
  put('.agent/tests/groups/a.json', '{}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scope-audit', () => {
  it('a write outside the run scope is reported; the tests folder and the scope itself are not', () => {
    const scope = runScope(root, 'run');
    const base = scopeBaseline(root);
    put('.agent/tests/groups/a.json', '{"x":1}\n');
    put('src/app.ts', 'export const hacked = 1;\n');
    put('src/new.ts', 'x\n');
    const audit = auditScope(root, scope, base);
    expect(audit).toEqual({ outside: ['src/app.ts', 'src/new.ts'], total: 2, headMoved: false });
  });

  it('generate: only drafts are in scope, but the tests folder is never audited (the panel writes there too)', () => {
    const scope = runScope(root, 'generate', [], 'e2e');
    const base = scopeBaseline(root);
    put('.agent/tests/drafts/d.json', '{}\n');
    // История прогонов пишется панелью, не агентом: вне черновиков, но не нарушение.
    put('.agent/tests/history/run.json', '{}\n');
    put('e2e/new.spec.ts', 'test\n');
    put('README.md', 'x\n');
    expect(auditScope(root, scope, base).outside).toEqual(['README.md']);
  });

  it('automate: files the cases name and their folder are in scope', () => {
    const cases = [{ id: 'c', automation: { status: 'automated', file: 'tests/unit/a.test.ts' } }];
    const scope = runScope(root, 'automate', cases as never);
    const base = scopeBaseline(root);
    put('tests/unit/a.test.ts', 'x\n');
    put('tests/unit/fixture.json', '{}\n');
    put('tests/other/b.test.ts', 'x\n');
    expect(auditScope(root, scope, base).outside).toEqual(['tests/other/b.test.ts']);
  });

  it('a file already dirty at the start counts only when the run changed it again', () => {
    put('src/app.ts', 'dirty before\n');
    const scope = runScope(root, 'run');
    const base = scopeBaseline(root);
    expect(auditScope(root, scope, base).outside).toEqual([]);
    put('src/app.ts', 'changed by the run, longer text\n');
    expect(auditScope(root, scope, base).outside).toEqual(['src/app.ts']);
  });

  it('a commit made during the run moves the head and is reported; a reverted dirty file counts too', () => {
    put('src/app.ts', 'dirty before\n');
    const scope = runScope(root, 'run');
    const base = scopeBaseline(root);
    git('checkout', '--', 'src/app.ts');
    put('.agent/tests/groups/a.json', '{"y":2}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'agent commit');
    const audit = auditScope(root, scope, base);
    expect(audit.headMoved).toBe(true);
    expect(audit.outside).toEqual(['src/app.ts']);
  });

  it('the list is capped, the total is not', () => {
    const scope = runScope(root, 'run');
    const base = scopeBaseline(root);
    for (let i = 0; i < 5; i += 1) put(`src/f${i}.ts`, 'x\n');
    const audit = auditScope(root, scope, base, 2);
    expect(audit.outside).toHaveLength(2);
    expect(audit.total).toBe(5);
  });

  it('a folder that is not a git repository is skipped with a reason, not reported clean', () => {
    const plain = mkdtempSync(join(tmpdir(), 'scope-audit-plain-'));
    try {
      const base = scopeBaseline(plain);
      expect(base.git).toBe(false);
      expect(auditScope(plain, runScope(plain, 'run'), base).skipped).toBe('not a git repository');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
