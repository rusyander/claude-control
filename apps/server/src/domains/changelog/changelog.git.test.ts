import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChangelog, resetChangelogMemo } from './changelog.ts';

/**
 * Лента «Что нового» поверх НАСТОЯЩЕГО git: свой репозиторий во временном
 * каталоге, коммиты с кириллицей в сообщениях и путях, двоичный файл, описание,
 * правленное в двух коммитах, уборка двух описаний разом, запись без коммита и
 * битый файл. Git здесь не подменён: вопрос именно в том, что он отдаёт.
 */

let root: string;

const git = (args: string[], date?: string): string =>
  execFileSync('git', ['-c', 'core.quotepath=off', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });

const put = (path: string, text: string | Buffer): void => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

const entry = (title: string): string =>
  JSON.stringify({ title: { ru: title }, items: [{ kind: 'added', text: { ru: 'пункт' } }] });

const commit = (message: string, date: string): void => {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message], date);
};

beforeEach(() => {
  resetChangelogMemo();
  root = mkdtempSync(join(tmpdir(), 'cc-changelog-'));
  git(['init', '-q']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('getChangelog на настоящем репозитории', () => {
  it('привязывает описания к коммитам, собирает остальные из git и находит запись в работе', async () => {
    put('apps/web/a.ts', 'a\nb\nc\n');
    put('docs/Заметка.md', 'x\n');
    put('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    commit('feat(web): первая версия', '2026-10-01T10:00:00+05:00');

    put('changelog/entries/2026-10-02-one.json', entry('Первое'));
    put('changelog/entries/2026-10-02-two.json', entry('Второе'));
    put('apps/web/b.ts', '1\n2\n');
    commit('feat: вторая\n\n- пункт А,\n  продолжение\n- пункт Б', '2026-10-02T10:00:00+05:00');

    put('changelog/entries/2026-10-02-one.json', entry('Первое, правка'));
    put('apps/server/s.ts', 's\n');
    commit('fix: доработка', '2026-10-03T10:00:00+05:00');

    // Уборка: правка двух описаний разом ничего не привязывает.
    put('changelog/entries/2026-10-02-one.json', `${entry('Первое, правка')}\n`);
    put('changelog/entries/2026-10-02-two.json', `${entry('Второе')}\n`);
    commit('chore: формат описаний', '2026-10-04T10:00:00+05:00');

    // Запись без коммита и правка рабочей копии.
    put('changelog/entries/2026-10-05-wip.json', entry('В работе'));
    put('changelog/entries/2026-10-06-bad.json', '{ не json');
    put('apps/web/b.ts', '1\n2\n3\n4\n');
    put('apps/web/new.tsx', 'x\ny\n');

    const response = await getChangelog(root);

    expect(response.gitAvailable).toBe(true);
    expect(response.invalid).toHaveLength(1);
    expect(response.invalid[0]!.file).toBe('2026-10-06-bad.json');

    const ids = response.entries.map((e) => e.id);
    expect(ids[0]).toBe('2026-10-05-wip');
    const byId = new Map(response.entries.map((e) => [e.id, e]));

    const wip = byId.get('2026-10-05-wip')!;
    expect(wip.status).toBe('pending');
    expect(wip.commits).toEqual([]);
    expect(wip.totals).toEqual({ files: 0, insertions: 0, deletions: 0 });
    // Числа рабочей копии — своя карточка: b.ts +2 (отслеженный), new.tsx +2,
    // два новых файла описаний по +1.
    expect(ids[1]).toBe('working-tree');
    expect(byId.get('working-tree')!.totals).toEqual({ files: 4, insertions: 6, deletions: 0 });

    const one = byId.get('2026-10-02-one')!;
    expect(one.status).toBe('released');
    expect(one.commits.map((c) => c.subject)).toEqual(['fix: доработка', 'feat: вторая']);
    expect(Date.parse(one.date)).toBe(Date.parse('2026-10-03T10:00:00+05:00'));
    expect(one.areas.map((a) => a.area).sort()).toEqual(['docs', 'server', 'web']);

    const two = byId.get('2026-10-02-two')!;
    expect(two.commits.map((c) => c.subject)).toEqual(['feat: вторая']);

    // Уборка стала своей записью из git, а не частью описаний.
    const cleanup = response.entries.find(
      (e) => e.source === 'git' && e.commits[0]!.subject === 'chore: формат описаний',
    );
    expect(cleanup).toBeDefined();
    expect(cleanup!.items).toEqual([]);

    const first = response.entries.find(
      (e) => e.commits[0]?.subject === 'feat(web): первая версия',
    )!;
    expect(first).toMatchObject({ source: 'git', title: { ru: 'Первая версия' } });
    expect(first.totals).toEqual({ files: 3, insertions: 3 + 1 + 0, deletions: 0 });
    expect(first.areas.map((a) => a.area).sort()).toEqual(['docs', 'other', 'web']);

    // Все четыре коммита на ленте; единственный повтор — коммит, добавивший ДВА
    // описания разом: он принадлежит обоим.
    const hashes = response.entries.flatMap((e) => e.commits.map((c) => c.hash));
    expect(new Set(hashes).size).toBe(4);
    expect(hashes).toHaveLength(5);
  });

  it('пункты автозаписи берутся из тела настоящего коммита вместе с продолжением', async () => {
    put('a.txt', 'a\n');
    commit(
      'feat: вторая\n\n- пункт А,\n  продолжение\n- пункт Б\n\nCo-Authored-By: X <x@example.com>',
      '2026-10-02T10:00:00+05:00',
    );
    const { entries } = await getChangelog(root);
    expect(entries[0]!.items.map((i) => i.text.ru)).toEqual(['пункт А, продолжение', 'пункт Б']);
    // Сообщение коммита отдаётся целиком, только трейлер авторства убран.
    expect(entries[0]!.commits[0]!.body).toBe('- пункт А,\n  продолжение\n- пункт Б');
  });

  it('без репозитория отдаёт только описания и говорит, что git недоступен', async () => {
    rmSync(join(root, '.git'), { recursive: true, force: true });
    put('changelog/entries/2026-10-02-one.json', entry('Первое'));
    const response = await getChangelog(root);
    expect(response.gitAvailable).toBe(false);
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0]).toMatchObject({ status: 'released', commits: [] });
  });

  it('память по HEAD не прячет новый коммит', async () => {
    put('a.txt', 'a\n');
    commit('feat: один', '2026-10-01T10:00:00+05:00');
    expect((await getChangelog(root)).entries).toHaveLength(1);
    put('b.txt', 'b\n');
    commit('feat: два', '2026-10-02T10:00:00+05:00');
    expect((await getChangelog(root)).entries).toHaveLength(2);
  });
});
