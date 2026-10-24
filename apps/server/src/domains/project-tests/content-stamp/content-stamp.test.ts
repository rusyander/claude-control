import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { readRuns, writeRun } from '../runs-store/runs-store.ts';
import { contentStamps, freshResult, stampPaths, stampsOf } from './content-stamp.ts';

/**
 * Отпечаток содержимого кейса: блобы его `codePaths` и автотеста. Свежесть
 * прогона для ворот решает он — проверяется здесь на настоящем git.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function put(dir: string, path: string, body: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
}

describe('stampPaths — от чего зависит кейс', () => {
  it('codePaths и файл автотеста, в одном виде и по порядку', () => {
    expect(
      stampPaths({
        codePaths: ['./src/b/', 'src\\a.ts'],
        automation: { status: 'automated', file: 'tests/a.test.ts' },
      }),
    ).toEqual(['src/a.ts', 'src/b', 'tests/a.test.ts']);
  });

  it('без codePaths, «весь проект» или путь вне проекта — отпечатка нет', () => {
    expect(stampPaths({ automation: { status: 'automated', file: 't.ts' } })).toBeUndefined();
    expect(stampPaths({ codePaths: ['.'] })).toBeUndefined();
    expect(stampPaths({ codePaths: ['../other/src'] })).toBeUndefined();
    expect(stampPaths({ codePaths: ['C:/abs/src'] })).toBeUndefined();
  });
});

describe('freshResult — отпечаток сильнее времени', () => {
  const run = { startedAt: '2026-10-24T10:00:00.000Z', stamps: { 'g:c': 'aaa' } };
  const later = Date.parse('2026-10-24T11:00:00.000Z');
  const earlier = Date.parse('2026-10-24T09:00:00.000Z');

  it('тот же отпечаток — свеж, хотя правка позже прогона', () => {
    expect(freshResult(run, 'g:c', later, new Map([['g:c', 'aaa']]))).toBe(true);
  });

  it('другой отпечаток — стар, хотя прогон позже правки', () => {
    expect(freshResult(run, 'g:c', earlier, new Map([['g:c', 'bbb']]))).toBe(false);
  });

  it('нет отпечатка в записи или сейчас — правило по времени', () => {
    const old = { startedAt: run.startedAt };
    expect(freshResult(old, 'g:c', later, new Map([['g:c', 'aaa']]))).toBe(false);
    expect(freshResult(old, 'g:c', earlier, new Map([['g:c', 'aaa']]))).toBe(true);
    expect(freshResult(run, 'g:c', later)).toBe(false);
    expect(freshResult(run, 'g:c', earlier, new Map())).toBe(true);
  });
});

describe('stampsOf — в запись только кейсы с результатом', () => {
  it('лишние ключи отброшены, пустое — без поля', () => {
    const stamps = new Map([
      ['g:a', '1'],
      ['g:b', '2'],
    ]);
    expect(stampsOf(stamps, [{ groupId: 'g', caseId: 'a' }])).toEqual({ stamps: { 'g:a': '1' } });
    expect(stampsOf(stamps, [{ groupId: 'g', caseId: 'z' }])).toEqual({});
    expect(stampsOf(undefined, [{ groupId: 'g', caseId: 'a' }])).toEqual({});
  });
});

describe('contentStamps на настоящем git', { timeout: 60_000 }, () => {
  let dir = '';
  const cases = [
    { key: 'g:auth', paths: ['src/auth', 'tests/auth.test.ts'] },
    { key: 'g:other', paths: ['src/other'] },
  ];
  const stamp = (key: string) => contentStamps(dir, cases).get(key);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-content-stamp-'));
    git(dir, 'init', '-q', '-b', 'main');
    put(dir, 'src/auth/login.ts', 'export const a = 1;\n');
    put(dir, 'src/other/x.ts', 'export const x = 1;\n');
    put(dir, 'tests/auth.test.ts', '// t\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('коммит той же правки отпечатка не меняет, правка покрытого — меняет', () => {
    put(dir, 'src/auth/login.ts', 'export const a = 2;\n');
    const dirty = stamp('g:auth');
    git(dir, 'commit', '-q', '-am', 'edit');
    expect(stamp('g:auth')).toBe(dirty);
    put(dir, 'src/auth/login.ts', 'export const a = 3;\n');
    expect(stamp('g:auth')).not.toBe(dirty);
  });

  it('правка соседнего кейса отпечатка не меняет', () => {
    const before = stamp('g:auth');
    const otherBefore = stamp('g:other');
    put(dir, 'src/other/x.ts', 'export const x = 2;\n');
    expect(stamp('g:auth')).toBe(before);
    expect(stamp('g:other')).not.toBe(otherBefore);
  });

  it('новый, удалённый файл и правка автотеста меняют отпечаток; .agent/ — нет', () => {
    const start = stamp('g:auth');
    put(dir, 'src/auth/.agent/notes.md', 'note\n');
    expect(stamp('g:auth')).toBe(start);
    put(dir, 'src/auth/new.ts', 'export {};\n');
    const added = stamp('g:auth');
    expect(added).not.toBe(start);
    unlinkSync(join(dir, 'src/auth/login.ts'));
    const removed = stamp('g:auth');
    expect(removed).not.toBe(added);
    put(dir, 'tests/auth.test.ts', '// t2\n');
    expect(stamp('g:auth')).not.toBe(removed);
  });

  it('вложенный репозиторий под путём — отпечатка нет (его файлов git не видит)', () => {
    const nested = join(dir, 'src/auth/vendor');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q');
    put(nested, 'a.ts', 'x\n');
    expect(stamp('g:auth')).toBeUndefined();
  });

  it('не репозиторий — отпечатков нет', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cc-content-stamp-plain-'));
    try {
      expect(contentStamps(plain, cases).size).toBe(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('отпечатки переживают запись и чтение истории; мусор в поле отброшен', () => {
    const record = (stamps: unknown): ProjectTestRunRecord =>
      ({
        id: `r-${JSON.stringify(stamps).length}`,
        mode: 'import',
        actor: 'ci',
        status: 'done',
        startedAt: new Date().toISOString(),
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 },
        stamps,
      }) as ProjectTestRunRecord;
    writeRun(dir, record({ 'g:auth': 'abc', 'g:bad': 7 }));
    expect(readRuns(dir)[0]?.stamps).toEqual({ 'g:auth': 'abc' });
    writeRun(dir, record(['x']));
    expect(readRuns(dir).some((run) => run.stamps === undefined)).toBe(true);
  });
});
