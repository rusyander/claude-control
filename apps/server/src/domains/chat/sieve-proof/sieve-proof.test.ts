import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_SIEVES,
  judgeSieves,
  type SieveDef,
  type SieveReportRow,
} from '@agentdeck/contracts/sieves';
import { sieveProofFacts } from './sieve-proof.ts';

/**
 * Свежесть строк отчёта о ситах на НАСТОЯЩЕМ git (Ф5, Ф6): строку снимает
 * другое содержимое файлов ветки, а не время коммитов. Rebase без правок
 * переписывает время каждого коммита ветки — строки обязаны остаться свежими;
 * правка покрытого файла — снять строку. Время git задано явно
 * (`GIT_COMMITTER_DATE` пишет и время записи reflog), так что тест не ждёт часов.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sieve = (id: string): SieveDef => BUILTIN_SIEVES.find((item) => item.id === id)!;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'sieve-proof-'));
  dirs.push(dir);
  const git = (args: string[], at?: string): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...(at ? { GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at } : {}) },
    }).trim();
  const put = (path: string, text: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string, at: string): void => {
    git(['add', '-A'], at);
    git(['commit', '-q', '-m', message], at);
  };
  git(['init', '-q', '-b', 'main']);
  put('src/Page.tsx', 'export const Page = () => null;\n');
  put('src/config.ts', 'export const url = "x";\n');
  put('src/other.ts', 'export const other = 1;\n');
  commit('init', '2026-10-01T09:00:00Z');
  git(['checkout', '-q', '-b', 'feat'], '2026-10-01T09:30:00Z');
  put('src/Page.tsx', 'export const Page = () => "page";\n');
  put('src/config.ts', 'export const url = "y";\n');
  commit('feat', '2026-10-01T10:00:00Z');
  return { dir, git, put, commit };
}

/** Строки сданы в 11:00 — после коммита ветки. */
const AT = '2026-10-01T11:00:00Z';
const rows: SieveReportRow[] = [
  { id: 'browser-focus', status: 'pass', evidence: 'npx playwright test focus → 3 passed', at: AT },
  { id: 'secrets', status: 'n/a', evidence: 'src/config.ts holds a test fixture URL', at: AT },
];
const BRANCH = ['src/Page.tsx', 'src/config.ts'];

async function factsOf(dir: string, git: (args: string[]) => string) {
  const base = git(['merge-base', 'main', 'HEAD']);
  return sieveProofFacts({ cwd: dir, rows, base, branchPaths: BRANCH });
}

describe('свежесть строк по содержимому файлов (Ф6)', () => {
  it('rebase без правок — строки свежие; правка файла ветки — устарела', async () => {
    const { dir, git, put, commit } = repo();
    // В основную приходит чужая правка, ветка переезжает на неё без своих правок.
    git(['checkout', '-q', 'main'], '2026-10-01T12:00:00Z');
    put('src/other.ts', 'export const other = 2;\n');
    commit('main moves', '2026-10-01T12:00:00Z');
    git(['checkout', '-q', 'feat'], '2026-10-01T12:30:00Z');
    git(['rebase', '-q', 'main'], '2026-10-01T13:00:00Z');

    const fresh = await factsOf(dir, git);
    expect(fresh.changedAfterRow).toEqual({});
    expect(
      judgeSieves({
        applicable: [sieve('browser-focus')],
        rows,
        mechanics: {},
        proof: fresh,
      }),
    ).toEqual([]);

    put('src/Page.tsx', 'export const Page = () => "changed";\n');
    commit('rewrite page', '2026-10-01T14:00:00Z');
    const stale = await factsOf(dir, git);
    expect(stale.changedAfterRow?.['browser-focus']).toEqual(['src/Page.tsx']);
    expect(
      judgeSieves({ applicable: [sieve('browser-focus')], rows, mechanics: {}, proof: stale }),
    ).toEqual([
      { code: 'sieve-gap-stale', params: { sieve: 'browser-focus', files: 'src/Page.tsx' } },
    ]);
  });
});

describe('снятие механики привязано к содержимому файла (Ф5)', () => {
  const mechanics = { secrets: ['src/config.ts'] };

  it('снял → правка другого файла — снято; правка отмеченного — снова открыто', async () => {
    const { dir, git, put, commit } = repo();
    const judge = async () =>
      judgeSieves({ applicable: [], rows, mechanics, proof: await factsOf(dir, git) });
    expect(await judge()).toEqual([]);

    put('src/Page.tsx', 'export const Page = () => "other edit";\n');
    commit('page only', '2026-10-01T12:00:00Z');
    expect(await judge()).toEqual([]);

    put('src/config.ts', 'export const url = "z";\n');
    commit('config again', '2026-10-01T13:00:00Z');
    expect(await judge()).toEqual([
      { code: 'sieve-gap-stale', params: { sieve: 'secrets', files: 'src/config.ts' } },
    ]);
  });
});
