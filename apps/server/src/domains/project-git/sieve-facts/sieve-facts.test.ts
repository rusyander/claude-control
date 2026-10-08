import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseZeroContextDiff,
  readSieveFacts,
  removedTokens,
  touchedPaths,
} from './sieve-facts.ts';

/**
 * Механика сит — на НАСТОЯЩЕМ git: голый «удалённый», основная, копия группы.
 * Подменять тут нечего: вопрос и есть в том, что отвечает git (`merge-tree`,
 * `blame`, `grep`), и таблица входов здесь доказала бы только таблицу.
 *
 * Время коммитов задаётся явно: «чужие −» — это строки, пришедшие в основную
 * ПОСЛЕ старта группы, и граница проходит по дате коммита основной.
 */

const BEFORE = '2026-01-01T10:00:00Z';
const STARTED = '2026-02-01T10:00:00Z';
const AFTER = '2026-03-01T10:00:00Z';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], date = BEFORE): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function commit(root: string, files: Record<string, string>, date: string, message = 'c'): void {
  write(root, files);
  git(root, ['add', '-A'], date);
  git(root, ['commit', '-q', '-m', message], date);
}

/** Удалённый с основной `main`, в нём `seed`; копия группы `work` на ветке `grp`. */
function repo(seed: Record<string, string>): { origin: string; main: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'sieve-facts-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const work = join(root, 'work');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, main]);
  git(main, ['checkout', '-q', '-b', 'main']);
  commit(main, seed, BEFORE, 'seed');
  git(main, ['push', '-q', '-u', 'origin', 'main']);
  git(root, ['clone', '-q', origin, work]);
  git(work, ['checkout', '-q', '-b', 'grp']);
  return { origin, main, work };
}

/** Основная уходит вперёд после старта группы. */
function landOnMain(main: string, files: Record<string, string>): void {
  commit(main, files, AFTER, 'landed after start');
  git(main, ['push', '-q', 'origin', 'main'], AFTER);
}

describe('механика сит на настоящем git', () => {
  it('конфликт со свежей основной находится после fetch, без правки копии', async () => {
    const { main, work } = repo({ 'a.txt': 'one\ntwo\n' });
    commit(work, { 'a.txt': 'ONE-branch\ntwo\n' }, STARTED);
    landOnMain(main, { 'a.txt': 'ONE-main\ntwo\n' });

    const facts = await readSieveFacts({ cwd: work, startedAt: STARTED });
    expect(facts.mechanics.conflicts).toEqual(['a.txt']);
    expect(facts.paths).toEqual(['a.txt']);
    // Копия не тронута: HEAD ветки на месте, дерево чистое.
    expect(git(work, ['status', '--porcelain']).trim()).toBe('');
    expect(git(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('grp');
  });

  // Ревью PR #1: git брал кириллическое имя в восьмеричные кавычки — механика его теряла.
  it('файл с кириллицей в имени — механика видит его под настоящим путём', async () => {
    const { work } = repo({ 'a.txt': 'one\n' });
    commit(work, { 'src/страница.ts': 'export const a = 1;\ndebugger;\n' }, STARTED);
    const facts = await readSieveFacts({ cwd: work, startedAt: STARTED });
    expect(facts.mechanics.debugLeftovers).toEqual(['src/страница.ts']);
  });

  it('без конфликта — пусто, и старые строки основной чужими не считаются', async () => {
    const { work } = repo({ 'old.ts': 'const keep = 1;\nconst drop = 2;\n' });
    commit(work, { 'old.ts': 'const keep = 1;\n' }, STARTED);
    const facts = await readSieveFacts({ cwd: work, startedAt: STARTED });
    // Git-механика молчит; остаётся только «код без тестов» — тестов ветка не трогала.
    expect(facts.mechanics).toEqual({ untestedCode: ['old.ts'] });
    expect(facts.unchecked).toBeUndefined();
    expect(facts.commits?.[0]?.paths).toEqual(['old.ts']);
  });

  it('чужие «−»: ветка перенесена на свежую основную и удалила пришедшее после старта', async () => {
    const { main, work } = repo({ 'late.ts': 'export const a = 1;\n', 'old.ts': 'x\ny\n' });
    commit(work, { 'mine.ts': 'export const mine = 1;\n' }, STARTED);
    landOnMain(main, { 'late.ts': 'export const a = 1;\nexport const lateWork = 2;\n' });
    git(work, ['fetch', '-q', 'origin'], AFTER);
    git(work, ['rebase', '-q', 'origin/main'], AFTER);
    commit(work, { 'late.ts': 'export const a = 1;\n', 'old.ts': 'x\n' }, AFTER, 'overwrite');

    const facts = await readSieveFacts({ cwd: work, startedAt: STARTED });
    expect(facts.mechanics.foreignRemovals).toEqual(['late.ts']);
  });

  it('потребители вне диффа: удалённое имя и тест-id, которые ещё ищутся', async () => {
    const { work } = repo({
      'src/lib.ts':
        'export function computeTotal() {\n  return 1;\n}\nexport const movedThing = 1;\n',
      'src/Page.tsx': 'export const P = () => <td data-testid="total-cell" />;\n',
      'src/other.ts': 'export const keepMe = 1;\n',
      'e2e/total.spec.ts': "computeTotal();\npage.getByTestId('total-cell');\n",
    });
    commit(
      work,
      {
        'src/lib.ts': '',
        'src/Page.tsx': 'export const P = () => <td />;\n',
        'src/other.ts': 'export const keepMe = 1;\nexport const movedThing = 1;\n',
      },
      STARTED,
    );

    const facts = await readSieveFacts({ cwd: work, startedAt: STARTED });
    const consumers = facts.mechanics.consumers ?? [];
    expect(consumers.map((hit) => hit.token).sort()).toEqual(['computeTotal', 'total-cell']);
    for (const hit of consumers) expect(hit.files).toEqual(['e2e/total.spec.ts']);
  });

  it('имя, объявленное где-то ещё, потребителей не даёт', async () => {
    const { work } = repo({
      'src/a.ts': 'export function sharedName() {}\n',
      'src/b.ts': 'export function sharedName() {}\n',
      'src/use.ts': "import { sharedName } from './b';\nsharedName();\n",
    });
    commit(work, { 'src/a.ts': '' }, STARTED);
    const facts = await readSieveFacts({ cwd: work, startedAt: STARTED });
    expect(facts.mechanics.consumers).toBeUndefined();
  });

  it('нет удалённого — проверка честно не сделана, а не «чисто»', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sieve-facts-'));
    dirs.push(root);
    git(root, ['init', '-q', '-b', 'main']);
    commit(root, { 'a.txt': 'x\n' }, BEFORE);
    const facts = await readSieveFacts({ cwd: root, startedAt: STARTED });
    expect(facts.unchecked).toEqual(['no-remote']);
    expect(facts.mechanics).toEqual({});
  });

  it('затронутые пути: развилка, незакоммиченное и новые файлы', async () => {
    const { work } = repo({ 'a.ts': 'x\n' });
    commit(work, { 'b.tsx': 'y\n' }, STARTED);
    write(work, { 'a.ts': 'changed\n', 'new/c.go': 'package c\n' });
    expect((await touchedPaths(work)).sort()).toEqual(['a.ts', 'b.tsx', 'new/c.go']);
  });
});

describe('разбор диффа без контекста', () => {
  it('удалённые куски с путём и строками, добавленное отдельно', () => {
    const diff = parseZeroContextDiff(
      [
        'diff --git a/x.ts b/x.ts',
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -3,2 +3 @@',
        '-export const goneName = 1;',
        '-const b = 2;',
        '+const c = 3;',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1 @@',
        '+export const goneNameX = 1;',
      ].join('\n'),
    );
    expect(diff.removed).toEqual([
      { path: 'x.ts', start: 3, count: 2, lines: ['export const goneName = 1;', 'const b = 2;'] },
    ]);
    // `goneNameX` — другое имя: удалённое `goneName` осталось удалённым.
    expect(removedTokens(diff)).toEqual([{ token: 'goneName', kind: 'name' }]);
  });

  // Ревью PR #1: строка «++ x» в ханке приходит как «+++ x» и уводила следующие в чужой путь.
  it('добавленная «++ …» и удалённая «-- …» внутри ханка — строки, а не заголовки', () => {
    const diff = parseZeroContextDiff(
      [
        '--- a/q.sql',
        '+++ b/q.sql',
        '@@ -1 +1,2 @@',
        '--- old comment',
        '+++ i;',
        '+debugger;',
      ].join('\n'),
    );
    expect(diff.additions).toEqual([
      { path: 'q.sql', text: '++ i;' },
      { path: 'q.sql', text: 'debugger;' },
    ]);
    expect(diff.removed).toEqual([
      { path: 'q.sql', start: 1, count: 1, lines: ['-- old comment'] },
    ]);
  });
});
